import { existsSync } from 'node:fs';
import { advance, nextAction } from '../engine.ts';
import { loadConfig, repoConfigPath } from '../config/load.ts';
import type { Config } from '../config/types.ts';
import { describeStatusline } from '../format.ts';
import { currentRunId, findRoot, loadRun } from '../store.ts';
import { chargeCost } from '../budget.ts';
import { mutateRun } from '../session.ts';
import type { RunState } from '../state.ts';

interface Payload {
  workspace?: { current_dir?: unknown };
  cwd?: unknown;
  session_id?: unknown;
  cost?: { total_cost_usd?: unknown };
}

/**
 * One line for Claude Code's status line, from its statusLine JSON payload. Returns '' when the
 * workspace has no genie config or no active run, and on any error: a status line must never fail.
 *
 * The payload is also the only place Claude Code reports what a session has cost, so this is where
 * an orchestrated run's cost is charged to its budget. That's the one write the status line makes,
 * and only when the session's cost has gone up; if the run is busy, the charge waits for the next refresh.
 */
export function statusline(payload: string): string {
  try {
    const input = JSON.parse(payload) as Payload;
    const cwd = input.workspace?.current_dir ?? input.cwd;
    if (typeof cwd !== 'string' || cwd === '') return '';

    const root = findRoot(cwd);
    if (!existsSync(repoConfigPath(root))) return '';
    const id = currentRunId(root);
    if (!id) return '';
    let run = loadRun(root, id);
    if (run.status !== 'active' && run.status !== 'halted') return '';

    const config = run.config ?? loadConfig({ root }).config;
    run = recordCost(root, config, run, input) ?? run;
    // Settle config-driven transitions in memory only.
    advance(run, config, { now: new Date().toISOString(), events: [] });
    return describeStatusline(run, nextAction(run, config));
  } catch {
    return '';
  }
}

/** Charges the session's cost increase to the run, returning the updated state when it wrote one. */
function recordCost(root: string, config: Config, run: RunState, input: Payload): RunState | undefined {
  const session = input.session_id;
  const total = input.cost?.total_cost_usd;
  if (typeof session !== 'string' || typeof total !== 'number') return undefined;
  if (run.status !== 'active' || (!run.budget && run.mode !== 'orchestrated')) return undefined;
  if (total <= (run.budget?.sessions[session] ?? 0)) return undefined;
  try {
    const now = () => new Date().toISOString();
    return mutateRun({ root, config, fileConfig: config, pendingConfig: [], now }, run.id, (s, ctx) => chargeCost(s, config, session, total, ctx), {
      lockTimeoutMs: 200,
    }).state;
  } catch {
    return undefined;
  }
}
