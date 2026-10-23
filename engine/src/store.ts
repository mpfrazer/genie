import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GenieError } from './errors.ts';
import type { RunState } from './state.ts';
import type { GateName, StageName } from './pipeline.ts';

/** An event as emitted by the engine; the store stamps `ts` and `run`. */
export interface LogEventBody {
  type: string;
  stage?: StageName;
  gate?: GateName;
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

/** The git toplevel containing `cwd`, or `cwd` itself outside a repository. */
export function findRoot(cwd: string): string {
  const res = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : cwd;
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

export function setCurrentRun(root: string, id: string): void {
  writeAtomic(join(runsDir(root), CURRENT), `${id}\n`);
}

export function loadRun(root: string, id?: string): RunState {
  const runId = id ?? currentRunId(root);
  if (!runId) throw new GenieError('no active run (start one with /genie:new or `genie new "<intent>"`)');
  const path = join(runDir(root, runId), 'state.json');
  if (!existsSync(path)) throw new GenieError(`run ${runId} not found`);
  return JSON.parse(readFileSync(path, 'utf8')) as RunState;
}

export function saveRun(root: string, state: RunState): void {
  writeAtomic(join(runDir(root, state.id), 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
}

export function appendLog(root: string, runId: string, events: LogEvent[]): void {
  if (events.length === 0) return;
  const path = join(runDir(root, runId), 'log.jsonl');
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, events.map((e) => `${JSON.stringify(e)}\n`).join(''));
}

export function readLog(root: string, runId: string): LogEvent[] {
  const path = join(runDir(root, runId), 'log.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEvent);
}

/** Write via rename so a crash never leaves a half-written file. */
export function writeAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}
