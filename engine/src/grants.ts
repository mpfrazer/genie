// Human-only commands (`approve`, `abort`) need a grant: a one-time permission issued by the
// UserPromptSubmit hook when the user types `/genie:approve …` or `/genie:abort …`. The model can't
// cause that event, so a `genie approve` it runs indirectly (a script, an interpreter) finds no grant.
// Grants are MACed with the sealing key, so writing one by hand doesn't work either.
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { GenieError } from './errors.ts';
import { mac } from './seal.ts';
import { runDir, writeAtomic } from './store.ts';

export type GrantCommand = 'approve' | 'abort';

export interface Grant {
  command: GrantCommand;
  /** The arguments as the user typed them after the command. */
  args: string;
  issuedAt: string;
  /** The Claude Code session the user typed it in. */
  session?: string;
  nonce: string;
  mac: string;
}

/** How long a grant waits for its command; the slash command's own shell step runs right after the hook. */
export const GRANT_TTL_MS = 5 * 60_000;

/** The human-only commands, as the user types them. Only the namespaced form: `/approve` may be another plugin's. */
const SLASH = /^\s*\/genie:(approve|abort)(?=\s|$)(.*)$/s;

export function grantsDir(root: string, runId: string): string {
  return join(runDir(root, runId), 'grants');
}

function grantMac(g: Omit<Grant, 'mac'>): string {
  return mac(JSON.stringify([g.command, g.args, g.issuedAt, g.session ?? '', g.nonce]));
}

/** The human-only command a typed prompt invokes, if any. */
export function parseSlash(prompt: string): { command: GrantCommand; args: string } | undefined {
  const m = SLASH.exec(prompt);
  return m ? { command: m[1] as GrantCommand, args: m[2]!.trim() } : undefined;
}

export function issueGrant(root: string, runId: string, command: GrantCommand, args: string, now: string, session?: string): Grant {
  const body = { command, args, issuedAt: now, ...(session ? { session } : {}), nonce: randomBytes(12).toString('hex') };
  const grant = { ...body, mac: grantMac(body) };
  writeAtomic(join(grantsDir(root, runId), `${grant.nonce}.json`), `${JSON.stringify(grant)}\n`);
  return grant;
}

/** What a grant's typed arguments say, for matching against the CLI call that redeems it. */
export interface GrantedCall {
  /** `approve`: the gate (or `budget`, `state`). */
  target?: string;
  reject: boolean;
  slice?: string;
}

export function describeArgs(args: string): GrantedCall {
  const words = args.split(/\s+/).filter(Boolean);
  const slice = /(?:^|\s)--slice(?:=|\s+)(\S+)/.exec(args)?.[1];
  return {
    ...(words[0] && !words[0].startsWith('--') ? { target: words[0] } : {}),
    reject: /(?:^|\s)--reject(?=\s|=|$)/.test(args),
    ...(slice ? { slice } : {}),
  };
}

/**
 * Redeems the grant for this call: an unexpired, untampered grant for the same command whose typed
 * arguments name the same target, rejection, and slice. The grant is used up either way: a call
 * that then fails needs the user to type the command again.
 */
export function redeemGrant(root: string, runId: string, command: GrantCommand, call: GrantedCall, now: string): Grant {
  const dir = grantsDir(root, runId);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
  for (const file of files) {
    const path = join(dir, file);
    let grant: Grant;
    try {
      grant = JSON.parse(readFileSync(path, 'utf8')) as Grant;
    } catch {
      rmSync(path, { force: true });
      continue;
    }
    const { mac: recorded, ...body } = grant;
    const age = Date.parse(now) - Date.parse(grant.issuedAt);
    if (recorded !== grantMac(body) || !(age >= 0 && age <= GRANT_TTL_MS)) {
      rmSync(path, { force: true });
      continue;
    }
    if (grant.command !== command) continue;
    const typed = describeArgs(grant.args);
    // An abort has nothing to match; an approval must name the same decision the user typed.
    if (command === 'approve' && (typed.target !== call.target || typed.reject !== call.reject || typed.slice !== call.slice)) continue;
    rmSync(path, { force: true });
    return grant;
  }
  const typed = `/genie:${command}${call.target ? ` ${call.target}` : ''}${call.slice ? ` --slice ${call.slice}` : ''}${call.reject ? ' --reject' : ''}`;
  throw new GenieError(
    `genie ${command} only acts on a command the user typed in Claude Code. Ask them to type \`${typed}\` (it lasts ${GRANT_TTL_MS / 60_000} minutes).`,
  );
}
