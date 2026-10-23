// Maps simple commands to the protected actions the gate hook cares about.
import { posix } from 'node:path';
import type { Config } from '../config/types.ts';
import { basename, stripWrappers, type Argv } from './shell.ts';
import { keyPath } from '../seal.ts';

export type ProtectedAction =
  | { kind: 'push'; detail: string; refs: PushRefs }
  | { kind: 'pr_create'; detail: string }
  | { kind: 'merge'; detail: string }
  | { kind: 'deploy'; detail: string }
  | { kind: 'release'; detail: string }
  | { kind: 'approve'; detail: string }
  | { kind: 'abort'; detail: string }
  | { kind: 'record'; detail: string; subcommand: 'gate' | 'done'; by?: string }
  | { kind: 'state_write'; detail: string; path: string }
  | { kind: 'config_write'; detail: string; path: string }
  | { kind: 'key_access'; detail: string; path: string };

export interface PushRefs {
  /** Directory from `git -C`, if given. */
  cwd?: string;
  /** Destination branches named explicitly (refs/heads/ stripped). */
  branches: string[];
  /** The current branch is pushed implicitly (`git push`, `git push origin HEAD`). */
  current: boolean;
  /** `--all`, `--mirror`, or a deletion: treated as touching every branch. */
  everything: boolean;
  tags: boolean;
}

const GIT_GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

/** `git [global options] <sub> args…` → [sub, args, -C dir]. */
function gitSubcommand(args: Argv): { sub?: string; rest: Argv; cwd?: string } {
  let cwd: string | undefined;
  let i = 0;
  while (i < args.length && args[i]!.startsWith('-')) {
    const flag = args[i]!;
    if (flag === '-C') cwd = args[i + 1];
    i += GIT_GLOBAL_WITH_VALUE.has(flag) ? 2 : 1;
  }
  return { sub: args[i], rest: args.slice(i + 1), cwd };
}

function classifyPush(rest: Argv, cwd: string | undefined): PushRefs {
  const refs: PushRefs = { cwd, branches: [], current: false, everything: false, tags: false };
  const positionals: string[] = [];
  let deleting = false;
  let tagsOnly = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--all' || a === '--mirror' || a === '--branches') refs.everything = true;
    else if (a === '--tags') refs.tags = tagsOnly = true;
    else if (a === '--follow-tags') refs.tags = true;
    else if (a === '-d' || a === '--delete') deleting = true;
    else if (a === '--repo' || a === '-o' || a === '--push-option' || a === '--receive-pack' || a === '--exec') i++;
    else if (!a.startsWith('-')) positionals.push(a);
  }
  for (const spec of positionals.slice(1)) {
    const clean = spec.replace(/^\+/, '');
    const dst = clean.includes(':') ? clean.slice(clean.indexOf(':') + 1) : clean;
    if (dst.startsWith('refs/tags/')) {
      refs.tags = true;
    } else if (dst === '' || dst === 'HEAD') {
      refs.current = true;
    } else {
      refs.branches.push(dst.replace(/^refs\/heads\//, ''));
    }
  }
  if (deleting && refs.branches.length === 0) refs.everything = true;
  if (positionals.length <= 1 && !tagsOnly && !refs.everything) refs.current = true;
  return refs;
}

/** First words of a configured command, up to its first `{placeholder}`. */
function commandPrefix(command: string | undefined): string[] | undefined {
  if (!command) return undefined;
  const words = command.trim().split(/\s+/);
  const cut = words.findIndex((w) => w.includes('{'));
  const prefix = cut === -1 ? words : words.slice(0, cut);
  return prefix.length > 0 ? prefix : undefined;
}

function startsWith(argv: Argv, prefix: string[] | undefined): boolean {
  return !!prefix && prefix.every((w, i) => argv[i] === w);
}

const PUBLISH = [
  ['npm', 'publish'],
  ['pnpm', 'publish'],
  ['yarn', 'publish'],
  ['yarn', 'npm', 'publish'],
  ['bun', 'publish'],
  ['cargo', 'publish'],
  ['gem', 'push'],
  ['twine', 'upload'],
];

const READ_ONLY = new Set([
  'cat', 'less', 'more', 'head', 'tail', 'grep', 'rg', 'egrep', 'jq', 'wc', 'ls', 'stat', 'file', 'diff', 'bat',
  'cd', 'pushd', 'test', '[', 'realpath', 'readlink', 'tree', 'du', 'cmp',
]);

const FIND_WRITES = /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/;

// Engine-owned: the .genie or runs directory itself, a whole run directory, CURRENT, and each
// run's state.json / log.jsonl / evidence / grants (including temp-file swaps like state.json.123.tmp).
// Stage artifacts (spec.md, plan.md, …) are deliberately writable.
const STATE_PATH =
  /(^|\/)\.genie(\/?$|\/runs(\/?$|\/CURRENT$|\/[^/]+\/?$|\/[^/]+\/(state\.json|log\.jsonl|evidence|grants)(\/|$|\.)))/;
const CONFIG_PATH = /(^|\/)\.genie\/config\.yaml$/;
const KEY_PATH = /(^|\/)\.genie\/secret$/;

/**
 * Whether `path` is genie's sealing key (seal.ts), in its default place or under $GENIE_HOME. Reading
 * it is how run state could be forged, so the hook denies any tool call that names it.
 */
export function isKeyPath(path: string, dirs: string[] = []): boolean {
  if (KEY_PATH.test(path)) return true;
  const key = keyPath();
  if (path === key) return true;
  return !path.startsWith('/') && dirs.some((d) => posix.join(d, path) === key || KEY_PATH.test(posix.join(d, path)));
}

/** Whether `path` is engine-owned run state (writable only through the genie CLI). */
export function isStatePath(path: string): boolean {
  return STATE_PATH.test(path);
}

export function isConfigPath(path: string): boolean {
  return CONFIG_PATH.test(path);
}

/**
 * True when `argv` would write `path`: a redirect onto it, or a non-read-only command naming it.
 * Relative paths are also tried against each directory in `dirs` (the directories the command may
 * be running in), so `cd .genie/runs/r1 && echo x > state.json` is still caught.
 */
function writesTo(argv: Argv, matches: (p: string) => boolean, dirs: string[]): string | undefined {
  const hit = (p: string) => matches(p) || (!p.startsWith('/') && dirs.some((d) => matches(posix.join(d, p))));
  for (let i = 0; i < argv.length; i++) {
    const w = argv[i]!;
    const redirect = /^\d*>>?$/.test(w) ? argv[i + 1] : /^\d*>>?(.+)$/.exec(w)?.[1];
    if (redirect && hit(redirect)) return redirect;
  }
  if (READ_ONLY.has(basename(argv[0] ?? ''))) return undefined;
  // find only writes through these actions; otherwise the paths it names are only searched.
  if (basename(argv[0] ?? '') === 'find' && !argv.some((a) => FIND_WRITES.test(a))) return undefined;
  return argv.slice(1).find(hit);
}

function isGenie(argv: Argv): Argv | undefined {
  const cmd = basename(argv[0] ?? '');
  if (cmd === 'genie' || cmd === 'genie.mjs') return argv.slice(1);
  if ((cmd === 'node' || cmd === 'npx') && argv[1] && /(^|\/)(genie\.mjs|cli\.ts)$|^genie$/.test(argv[1])) {
    return argv.slice(2);
  }
  return undefined;
}

// genie CLI options that take a value (see OPTIONS in cli.ts); their values aren't positionals.
const GENIE_VALUE_FLAGS = new Set([
  '--run-id',
  '--profile',
  '--file',
  '--mode',
  '--by',
  '--verdict',
  '--findings',
  '--note',
  '--slice',
]);

function geniePositionals(args: Argv): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (GENIE_VALUE_FLAGS.has(a)) i++;
    else if (!a.startsWith('-')) out.push(a);
  }
  return out;
}

function flagValue(args: Argv, flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i !== -1) return args[i + 1];
  return args.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

export function classify(raw: Argv, config: Config | undefined, dirs: string[] = []): ProtectedAction[] {
  const argv = stripWrappers(raw);
  const detail = argv.join(' ');
  const cmd = basename(argv[0] ?? '');
  const actions: ProtectedAction[] = [];

  const key = argv.find((a, i) => i > 0 && isKeyPath(a, dirs));
  if (key) actions.push({ kind: 'key_access', detail, path: key });

  const genieArgs = isGenie(argv);
  if (genieArgs) {
    const sub = geniePositionals(genieArgs)[0];
    if (sub === 'approve') actions.push({ kind: 'approve', detail });
    if (sub === 'abort') actions.push({ kind: 'abort', detail });
    if (sub === 'gate' && genieArgs.some((a) => a === '--verdict' || a.startsWith('--verdict='))) {
      actions.push({ kind: 'record', detail, subcommand: 'gate', by: flagValue(genieArgs, '--by') });
    }
    if (sub === 'done') actions.push({ kind: 'record', detail, subcommand: 'done', by: flagValue(genieArgs, '--by') });
    return actions;
  }

  if (cmd === 'git') {
    const { sub, rest, cwd } = gitSubcommand(argv.slice(1));
    if (sub === 'push') {
      const refs = classifyPush(rest, cwd);
      actions.push({ kind: 'push', detail, refs });
      if (refs.tags) actions.push({ kind: 'release', detail });
    }
    const listing = rest.some((a) => ['-l', '--list', '-d', '--delete', '-v', '--verify', '--contains'].includes(a));
    if (sub === 'tag' && rest.some((a) => !a.startsWith('-')) && !listing) actions.push({ kind: 'release', detail });
  } else if (cmd === 'gh' || cmd === 'glab') {
    const [group, verb] = argv.slice(1).filter((a) => !a.startsWith('-'));
    if ((group === 'pr' || group === 'mr') && verb === 'create') actions.push({ kind: 'pr_create', detail });
    if ((group === 'pr' || group === 'mr') && verb === 'merge') actions.push({ kind: 'merge', detail });
    if (group === 'release' && ['create', 'edit', 'upload', 'delete'].includes(verb ?? '')) {
      actions.push({ kind: 'release', detail });
    }
  }

  if (PUBLISH.some((p) => startsWith(argv, p)) || startsWith(argv, commandPrefix(config?.release.publish))) {
    actions.push({ kind: 'release', detail });
  }
  if (startsWith(argv, commandPrefix(config?.deploy.command))) actions.push({ kind: 'deploy', detail });

  const state = writesTo(argv, isStatePath, dirs);
  if (state) actions.push({ kind: 'state_write', detail, path: state });
  const cfg = writesTo(argv, isConfigPath, dirs);
  if (cfg) actions.push({ kind: 'config_write', detail, path: cfg });
  return actions;
}

const MAX_DIRS = 64;

/**
 * Classifies a command's simple commands in order, following `cd`/`pushd`. Pipelines and subshells
 * blur where each one runs, so every directory seen so far stays a candidate, which errs toward denying.
 */
export function classifyCommands(commands: Argv[], config: Config | undefined, cwd?: string): ProtectedAction[] {
  const dirs = new Set(cwd ? [cwd] : []);
  return commands.flatMap((raw) => {
    const argv = stripWrappers(raw);
    const cmd = basename(argv[0] ?? '');
    const to = argv.slice(1).find((a) => !a.startsWith('-'));
    if ((cmd === 'cd' || cmd === 'pushd') && to) {
      const next = to.startsWith('/') ? [to] : [to, ...[...dirs].map((d) => posix.join(d, to))];
      for (const d of next) if (dirs.size < MAX_DIRS) dirs.add(d);
    }
    return classify(raw, config, [...dirs]);
  });
}
