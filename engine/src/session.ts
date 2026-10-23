import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { GenieError } from './errors.ts';
import { advance, type Ctx } from './engine.ts';
import { loadConfig, repoConfigPath } from './config/load.ts';
import type { Config, ConfigLayer } from './config/types.ts';
import type { RunState } from './state.ts';
import { withLock } from './lock.ts';
import { appendLog, currentRunId, findRoot, loadRun, runDir, saveRun } from './store.ts';

/** Everything a CLI command needs: the repo root, its resolved config, and a clock. */
export interface Session {
  root: string;
  config: Config;
  now: () => string;
}

export function openSession(cwd: string, flags?: ConfigLayer): Session {
  const root = findRoot(cwd);
  if (!existsSync(repoConfigPath(root))) {
    throw new GenieError(`genie is not initialized in ${root} (run \`genie init\`)`);
  }
  return { root, config: loadConfig({ root, flags }).config, now: () => new Date().toISOString() };
}

/**
 * Loads a run, applies `fn`, and persists the result, holding the run's lock throughout so
 * concurrent genie processes serialize. The state is saved before the log is appended, so the log
 * never records a transition that didn't stick.
 */
export function mutateRun<T>(session: Session, runId: string | undefined, fn: (state: RunState, ctx: Ctx) => T): {
  state: RunState;
  result: T;
} {
  // With no run named or current, loadRun throws its "no active run" error.
  const id = runId ?? currentRunId(session.root) ?? loadRun(session.root).id;
  return withLock(join(runDir(session.root, id), 'state.json.lock'), () => {
    const state = loadRun(session.root, id);
    const ctx: Ctx = { now: session.now(), events: [] };
    // Pick up config changes (e.g. a gate disabled mid-run) before acting.
    advance(state, session.config, ctx);
    const result = fn(state, ctx);
    saveRun(session.root, state);
    appendLog(session.root, state.id, ctx.events);
    return { state, result };
  });
}
