import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { GenieError } from './errors.ts';
import { chainLink, stateSeal, TamperError } from './seal.ts';
import { migrateState, type RunState } from './state.ts';
import type { GateName, StageName } from './pipeline.ts';

/** An event as emitted by the engine; the store stamps `ts` and `run`. */
export interface LogEventBody {
  type: string;
  stage?: StageName;
  gate?: GateName;
  /** For slice-level events: the slice id. */
  slice?: string;
  verdict?: string;
  by?: string;
  attempt?: number;
  note?: string;
  evidence?: string[];
  [key: string]: unknown;
}

export interface LogEvent extends LogEventBody {
  ts: string;
  run: string;
}

/**
 * The repository's main worktree containing `cwd`, or `cwd` itself outside a repository. From a
 * linked worktree (such as a slice worktree) this is still the main checkout, where runs live.
 */
export function findRoot(cwd: string): string {
  const res = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
  });
  if (res.status !== 0) return cwd;
  const [common, toplevel] = res.stdout.trim().split('\n');
  return common && basename(common) === '.git' ? dirname(common) : (toplevel ?? cwd);
}

export function genieDir(root: string): string {
  return join(root, '.genie');
}

export function runsDir(root: string): string {
  return join(genieDir(root), 'runs');
}

export function runDir(root: string, id: string): string {
  return join(runsDir(root), id);
}

const CURRENT = 'CURRENT';

export function currentRunId(root: string): string | undefined {
  const path = join(runsDir(root), CURRENT);
  return existsSync(path) ? readFileSync(path, 'utf8').trim() || undefined : undefined;
}

/**
 * The run the hook guards: CURRENT if it's live, otherwise the newest live run, so deleting or
 * repointing CURRENT can't hide one. A run that fails verification counts as live (whatever its
 * state claims), except an unsealed finished run from before sealing existed.
 */
export function liveRunId(root: string): string | undefined {
  const current = currentRunId(root);
  if (current && isLive(root, current)) return current;
  if (!existsSync(runsDir(root))) return undefined;
  const ids = readdirSync(runsDir(root), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(runsDir(root), d.name, 'state.json')))
    .map((d) => d.name)
    .sort()
    .reverse();
  return ids.find((id) => isLive(root, id));
}

function isLive(root: string, id: string): boolean {
  let raw: { status?: string; seal?: string; logMac?: string };
  try {
    raw = JSON.parse(readFileSync(join(runDir(root, id), 'state.json'), 'utf8'));
  } catch {
    return existsSync(join(runDir(root, id), 'state.json'));
  }
  const live = raw.status === 'active' || raw.status === 'halted';
  if (live) return true;
  try {
    verifyRun(root, id, raw);
    return false;
  } catch {
    const legacy = !raw.seal && !raw.logMac && checkLog(root, id).changed.length === 0 && !hasMacs(root, id);
    return !legacy;
  }
}

function hasMacs(root: string, id: string): boolean {
  return logLines(root, id).some((line) => line.includes('"mac":'));
}

export function setCurrentRun(root: string, id: string): void {
  writeAtomic(join(runsDir(root), CURRENT), `${id}\n`);
}

export interface LoadOptions {
  /**
   * Skip the seal and log checks. Only for reading a run a human is about to accept or abort, or
   * one whose status doesn't matter; never for a decision about what the run may do.
   */
  unverified?: boolean;
}

export function loadRun(root: string, id?: string, opts: LoadOptions = {}): RunState {
  const runId = id ?? currentRunId(root);
  if (!runId) throw new GenieError('no active run (start one with /genie:new or `genie new "<intent>"`)');
  const path = join(runDir(root, runId), 'state.json');
  if (!existsSync(path)) throw new GenieError(`run ${runId} not found`);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { seal?: string };
  if (!opts.unverified) verifyRun(root, runId, raw);
  return migrateState(raw, runId);
}

const ACCEPT = 'A human can check the run and accept it as it is with `/genie:approve state`, or stop it with `/genie:abort`.';

/** Throws a TamperError unless state.json carries a valid seal and log.jsonl matches the chain it records. */
export function verifyRun(root: string, id: string, raw: { seal?: string; logMac?: string }): void {
  if (!raw.seal) {
    throw new TamperError(`run ${id}'s state isn't sealed: it was written by a genie older than 0.7, or outside genie. ${ACCEPT}`);
  }
  if (raw.seal !== stateSeal(raw)) {
    throw new TamperError(`run ${id}'s state.json was changed outside genie (its seal doesn't match). ${ACCEPT}`);
  }
  const problem = logProblem(root, id, raw.logMac);
  if (problem) throw new TamperError(`run ${id}'s log.jsonl ${problem}. ${ACCEPT}`);
}

/** The MAC chain over a run's log, and where it breaks: a changed line, or lines added or removed. */
export function checkLog(root: string, id: string): { tail: string; changed: number[] } {
  let tail = '';
  const changed: number[] = [];
  logLines(root, id).forEach((line, i) => {
    const { mac: recorded, ...event } = JSON.parse(line) as LogEvent & { mac?: string };
    const expected = chainLink(tail, JSON.stringify(event));
    if (recorded !== undefined && recorded !== expected) changed.push(i + 1);
    // Each line is checked against the MAC recorded on the line before it, so an edit is reported
    // where it is rather than on every line after. Lines from before sealing carry no MAC; the
    // chain still covers them through the state's record of its tail.
    tail = recorded ?? expected;
  });
  return { tail, changed };
}

function logProblem(root: string, id: string, recorded: string | undefined): string | undefined {
  const { tail, changed } = checkLog(root, id);
  if (changed.length > 0) return `was changed outside genie (line ${changed.join(', ')})`;
  if (tail !== (recorded ?? '')) return 'has lines added or removed outside genie';
  return undefined;
}

function logLines(root: string, id: string): string[] {
  const path = join(runDir(root, id), 'log.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean);
}

/**
 * Persists a run: chains `events` onto the log, records the new chain tail in the state, and seals
 * it. The state is written before the log, so the log never records a transition that didn't stick;
 * a crash between the two leaves a run that fails verification until a human accepts it.
 */
export function commitRun(root: string, state: RunState, events: LogEvent[]): void {
  let tail = state.logMac ?? '';
  const lines = events.map((e) => {
    const line = JSON.stringify(e);
    tail = chainLink(tail, line);
    return `${JSON.stringify({ ...e, mac: tail })}\n`;
  });
  if (lines.length > 0) state.logMac = tail;
  delete state.seal;
  state.seal = stateSeal(state);
  writeAtomic(join(runDir(root, state.id), 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  if (lines.length === 0) return;
  const path = join(runDir(root, state.id), 'log.jsonl');
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, lines.join(''));
}

/** Recomputes the log chain over the log as it stands, for a human accepting a run's current state. */
export function logTail(root: string, id: string): string | undefined {
  return logLines(root, id).length > 0 ? checkLog(root, id).tail : undefined;
}

export function readLog(root: string, runId: string): LogEvent[] {
  const path = join(runDir(root, runId), 'log.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const { mac: _, ...event } = JSON.parse(line) as LogEvent & { mac?: string };
      return event as LogEvent;
    });
}

/** Write via rename so a crash never leaves a half-written file. */
export function writeAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}
