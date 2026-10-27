import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import YAML from 'yaml';
import { GenieError } from './errors.ts';
import { init } from './commands/init.ts';
import { abortRun, done, newRun, next, setMode, status, type RunView } from './commands/run.ts';
import { agentVerdict, approve, runGate } from './commands/gate.ts';
import { hookOutput, preToolUse, promptExpansion, type PreToolUseInput, type PromptExpansionInput } from './commands/hook.ts';
import { statusline } from './commands/statusline.ts';
import { describeAction, describeChecks, describeRework, describeRun } from './format.ts';
import { loadConfig } from './config/load.ts';
import { configDiff, openSession } from './session.ts';
import type { Config, Mode } from './config/types.ts';

const USAGE = `genie: deterministic pipeline engine

Usage: genie <command> [options]

  init [--profile <name>] [--force]      Write .genie/config.yaml for this repo
  config                                 Print the resolved configuration
  new <intent...> [--file <path>|-] [--mode guided|orchestrated]
                                         Start a run
  status                                 Show the run and what happens next
  next                                   Show what happens next (orchestrated: every ready action,
                                         with a worktree for each ready slice)
  mode guided|orchestrated               Switch the run's mode
  done <stage> [--by <author>] [--slice <id>]
                                         Mark the current stage's work (or one slice's) complete
  gate <gate> --run [--slice <id>]       Evaluate an automated gate
  gate <gate> --verdict pass|fail|needs_human --by <agent> [--slice <id>] --findings <file> [--note <text>]
                                         Record an agent gate verdict
  approve <gate>|budget [--reject] [--slice <id>] [--note <text>]
                                         Record a human decision (human-only channel)

  --slice names the plan slice for slice gates (slice.verified, slice.reviewed) and implement work;
  it can be left out when only one slice is waiting.
  abort [--note <text>]                  Abort the run
  hook pre-tool-use                      Claude Code PreToolUse hook (reads the payload on stdin)
  hook user-prompt-expansion             Claude Code UserPromptExpansion hook: grants /genie:approve and /genie:abort
  statusline                             One-line run status for Claude Code's statusLine (payload on stdin)

Global: --json  machine-readable output    --run-id <id>  target a specific run    --version`;

/** The plugin manifest is the version of record; it sits two levels up from both src/ and dist/. */
function version(): string {
  const manifest = new URL('../../.claude-plugin/plugin.json', import.meta.url);
  return (JSON.parse(readFileSync(manifest, 'utf8')) as { version: string }).version;
}

const OPTIONS = {
  json: { type: 'boolean' },
  'run-id': { type: 'string' },
  profile: { type: 'string' },
  force: { type: 'boolean' },
  file: { type: 'string' },
  mode: { type: 'string' },
  by: { type: 'string' },
  run: { type: 'boolean' },
  verdict: { type: 'string' },
  findings: { type: 'string' },
  note: { type: 'string' },
  reject: { type: 'boolean' },
  slice: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

function main(argv: string[]): number {
  const { values: opts, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  const [command, ...rest] = positionals;
  const json = opts.json ?? false;
  const id = opts['run-id'];
  const print = (data: unknown, text: string) => console.log(json ? JSON.stringify(data, null, 2) : text);
  const printRun = (v: RunView, config: Config, extra = '') => print(v, `${extra}${describeRun(v.state, config, v.action, v.dir, v.rework)}${pending(v)}`);
  // Read fresh: approve config clears it within the same command.
  const pending = (v: RunView) => {
    if (v.state.status !== 'active' && v.state.status !== 'halted') return '';
    let changed: string[] = [];
    try {
      if (v.state.config) changed = configDiff(v.state.config, openSession(process.cwd(), undefined, v.state.id).fileConfig);
    } catch (err) {
      return `\n\n.genie/config.yaml can't be read (${(err as Error).message}); the run keeps its own config.`;
    }
    return changed.length > 0
      ? `\n\n.genie/config.yaml changed since the run started (${changed.join(', ')}). The run keeps its own config until you apply the change: /genie:approve config`
      : '';
  };

  if (opts.version || command === 'version') {
    print({ version: version() }, version());
    return 0;
  }
  if (!command || opts.help || command === 'help') {
    console.log(USAGE);
    return command || opts.help ? 0 : 1;
  }

  switch (command) {
    case 'init': {
      const r = init({ cwd: process.cwd(), profile: opts.profile, force: opts.force });
      const notes = r.notes.map((n) => `  note: ${n}`).join('\n');
      print(r, `Wrote ${r.path} (profile: ${r.profile}${r.ecosystem ? `, detected ${r.ecosystem}` : ''})\n${notes}`);
      return 0;
    }
    case 'config': {
      const session = openSession(process.cwd(), undefined, id);
      const { sources } = loadConfig({ root: session.root });
      print({ config: session.config, sources }, `# sources: defaults, profile:${session.config.profile}${sources.map((s) => `, ${s}`).join('')}\n${YAML.stringify(session.config)}`);
      return 0;
    }
    case 'new': {
      const session = openSession(process.cwd(), undefined, id);
      const intent = opts.file ? readFileSync(opts.file === '-' ? 0 : opts.file, 'utf8') : rest.join(' ');
      if (opts.mode && opts.mode !== 'guided' && opts.mode !== 'orchestrated') {
        throw new GenieError(`--mode must be guided or orchestrated (got "${opts.mode}")`);
      }
      printRun(newRun(session, intent, opts.mode as Mode | undefined), session.config);
      return 0;
    }
    case 'status': {
      const session = openSession(process.cwd(), undefined, id);
      printRun(status(session, id), session.config);
      return 0;
    }
    case 'next': {
      const session = openSession(process.cwd(), undefined, id);
      const v = next(session, id);
      const text = v.actions.map(({ action, feedback, worktree }) => {
        const why = feedback
          ? `Reworking after ${describeRework(feedback)}${feedback.evidence?.length ? `\n  evidence: ${feedback.evidence.join(', ')}` : ''}\n`
          : '';
        const where = worktree ? `\n  worktree: ${worktree.path} (${worktree.branch}, merges onto ${worktree.base})` : '';
        return `${why}${describeAction(action)}${where}`;
      });
      print(v, text.join('\n\n'));
      return 0;
    }
    case 'done': {
      const session = openSession(process.cwd(), undefined, id);
      if (!rest[0]) throw new GenieError('usage: genie done <stage>');
      printRun(done(session, rest[0], opts.by ?? 'claude', id, opts.slice), session.config);
      return 0;
    }
    case 'gate': {
      const session = openSession(process.cwd(), undefined, id);
      const gate = rest[0];
      if (!gate) throw new GenieError('usage: genie gate <gate> --run | --verdict <v> --by <agent>');
      if (opts.run) {
        const r = runGate(session, gate, id, opts.slice);
        printRun(r, session.config, `${describeChecks(r.results)}\n\n`);
        return r.verdict === 'pass' ? 0 : 2;
      }
      if (!opts.verdict) throw new GenieError('gate needs --run (automated) or --verdict (agent)');
      printRun(
        agentVerdict(session, {
          gate,
          verdict: opts.verdict,
          by: opts.by ?? '',
          slice: opts.slice,
          note: opts.note,
          findings: opts.findings,
          id,
        }),
        session.config,
      );
      return 0;
    }
    case 'approve': {
      const session = openSession(process.cwd(), undefined, id);
      if (!rest[0]) throw new GenieError('usage: genie approve <gate> [--reject]');
      printRun(approve(session, rest[0], opts.reject ?? false, opts.note, id, opts.slice), session.config);
      return 0;
    }
    case 'abort': {
      const session = openSession(process.cwd(), undefined, id);
      const r = abortRun(session, opts.note, id);
      printRun(r, session.config, r.note ? `note: ${r.note}\n\n` : '');
      return 0;
    }
    case 'mode': {
      const session = openSession(process.cwd(), undefined, id);
      if (rest[0] !== 'guided' && rest[0] !== 'orchestrated') throw new GenieError('usage: genie mode guided|orchestrated');
      printRun(setMode(session, rest[0], id), session.config);
      return 0;
    }
    case 'hook': {
      if (rest[0] === 'user-prompt-expansion') {
        // Never block or fail the user's prompt: without a grant, the approval itself reports why.
        try {
          promptExpansion(JSON.parse(readFileSync(0, 'utf8')) as PromptExpansionInput);
        } catch (err) {
          console.error(`genie hook: ${(err as Error).message}`);
        }
        return 0;
      }
      if (rest[0] !== 'pre-tool-use') throw new GenieError('usage: genie hook pre-tool-use|user-prompt-expansion');
      // Hook failures must never wedge the session: an unreadable payload or an engine bug is
      // reported on stderr and the call proceeds. (Config/state errors while judging a protected
      // action are handled inside preToolUse, which fails closed.)
      try {
        const decision = preToolUse(JSON.parse(readFileSync(0, 'utf8')) as PreToolUseInput);
        if (decision) console.log(JSON.stringify(hookOutput(decision)));
      } catch (err) {
        console.error(`genie hook: ${(err as Error).message}`);
      }
      return 0;
    }
    case 'statusline': {
      let payload = '';
      try {
        payload = readFileSync(0, 'utf8');
      } catch {
        // No readable stdin: nothing to show.
      }
      const line = statusline(payload);
      if (line) console.log(line);
      return 0;
    }
    default:
      throw new GenieError(`unknown command "${command}"\n\n${USAGE}`);
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  if (err instanceof GenieError || (err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
    const message = (err as Error).message;
    if (process.argv.includes('--json')) console.log(JSON.stringify({ error: message }));
    else console.error(`genie: ${message}`);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
