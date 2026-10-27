import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { GenieError } from './errors.ts';
import { advance, type Ctx } from './engine.ts';
import { chargeTime, checkBudget } from './budget.ts';
import { deepMerge, loadConfig, repoConfigPath } from './config/load.ts';
import { defaultConfig } from './config/defaults.ts';
import type { Config, ConfigLayer } from './config/types.ts';
import type { RunState } from './state.ts';
import { withLock } from './lock.ts';
import { commitRun, currentRunId, findRoot, loadRun, runDir } from './store.ts';

/** Everything a CLI command needs: the repo root, the config in force, and a clock. */
export interface Session {
  root: string;
  /** The config in force: the live run's snapshot when there is one, otherwise the file's. */
  config: Config;
  /** .genie/config.yaml as it stands now. */
  fileConfig: Config;
  /** Settings where the file differs from the live run's snapshot: pending `/genie:approve config`. */
  pendingConfig: string[];
  now: () => string;
}

export function openSession(cwd: string, flags?: ConfigLayer, runId?: string): Session {
  const root = findRoot(cwd);
  if (!existsSync(repoConfigPath(root))) {
    throw new GenieError(`genie is not initialized in ${root} (run \`genie init\`)`);
  }
  const fileConfig = loadConfig({ root, flags }).config;
  const now = () => new Date().toISOString();
  const run = liveSnapshot(root, runId);
  if (!run) return { root, config: fileConfig, fileConfig, pendingConfig: [], now };
  return { root, config: run, fileConfig, pendingConfig: configDiff(run, fileConfig), now };
}

/**
 * The live run's config snapshot. Read unverified to set up the session; every mutation verifies
 * the run before acting, so a forged snapshot is never acted on.
 */
function liveSnapshot(root: string, runId: string | undefined): Config | undefined {
  const id = runId ?? currentRunId(root);
  if (!id) return undefined;
  try {
    const state = loadRun(root, id, { unverified: true });
    return state.status === 'active' || state.status === 'halted' ? state.config : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Dotted paths whose values differ between two configs, e.g. `gates.pr.approved.enabled`. A setting
 * added by a newer genie counts as its default in a snapshot taken before it existed.
 */
export function configDiff(a: Config, b: Config): string[] {
  const out: string[] = [];
  const walk = (x: unknown, y: unknown, path: string) => {
    const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
    if (obj(x) && obj(y)) {
      for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[key], y[key], path ? `${path}.${key}` : key);
    } else if (JSON.stringify(x) !== JSON.stringify(y)) {
      out.push(path);
    }
  };
  const withDefaults = (c: Config) => deepMerge(defaultConfig() as unknown as Record<string, unknown>, c as unknown as Record<string, unknown>);
  walk(withDefaults(a), withDefaults(b), '');
  return out;
}

/**
 * Loads a run, applies `fn`, and persists the result, holding the run's lock throughout so
 * concurrent genie processes serialize. The run is verified on load and sealed on save (store.ts).
 */
export function mutateRun<T>(
  session: Session,
  runId: string | undefined,
  fn: (state: RunState, ctx: Ctx) => T,
  opts: { lockTimeoutMs?: number; unverified?: boolean } = {},
): {
  state: RunState;
  result: T;
} {
  // With no run named or current, loadRun throws its "no active run" error.
  const id = runId ?? currentRunId(session.root) ?? loadRun(session.root).id;
  return withLock(join(runDir(session.root, id), 'state.json.lock'), () => {
    const state = loadRun(session.root, id, { unverified: opts.unverified });
    const ctx: Ctx = { now: session.now(), events: [] };
    if (!state.config) {
      // Runs from before config snapshots adopt the file's config as it stands.
      state.config = session.fileConfig;
      ctx.events.push({ ts: ctx.now, run: state.id, type: 'config.recorded', note: 'snapshot of .genie/config.yaml' });
    }
    // The run follows its own snapshot, whatever the session was opened with.
    session = { ...session, config: state.config };
    advance(state, session.config, ctx);
    // Time since the last mutation is charged to the state the run was in during it.
    chargeTime(state, session.config, ctx);
    const result = fn(state, ctx);
    checkBudget(state, session.config, ctx);
    commitRun(session.root, state, ctx.events);
    return { state, result };
  }, { timeoutMs: opts.lockTimeoutMs });
}
