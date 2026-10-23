// Orchestrated-mode budgets: how long a run may work unattended and what it may spend before a
// human has to say "keep going". Pure transitions over RunState, like engine.ts.
import { GenieError } from './errors.ts';
import { nextActions, type Ctx } from './engine.ts';
import type { Config } from './config/types.ts';
import type { BudgetState, RunState } from './state.ts';

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `30m`, `4h`, `2d` → milliseconds. The config schema guarantees the shape. */
export function parseDuration(text: string): number {
  const match = /^(\d+)([mhd])$/.exec(text);
  if (!match) throw new GenieError(`invalid duration "${text}" (expected e.g. 30m, 4h, 2d)`);
  return Number(match[1]) * UNIT_MS[match[2]!]!;
}

export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h${m > 0 ? `${String(m).padStart(2, '0')}m` : ''}` : `${m}m`;
}

function ensureBudget(state: RunState, now: string): BudgetState {
  state.budget ??= { activeMs: 0, tickedAt: now, costUsd: 0, sessions: {}, extensions: 0 };
  return state.budget;
}

/** The limits in force: the configured ones, once more for every extension a human granted. */
export function budgetLimits(state: RunState, config: Config): { durationMs: number; costUsd: number } {
  const times = 1 + (state.budget?.extensions ?? 0);
  return {
    durationMs: parseDuration(config.budgets.max_run_duration) * times,
    costUsd: config.budgets.max_cost_usd * times,
  };
}

/** True when the run can't move until a human acts: only human decisions, or nothing, are left. */
function waitingOnHuman(state: RunState, config: Config): boolean {
  if (state.status !== 'active' || state.budget?.exceeded) return true;
  try {
    return nextActions(state, config).every((a) => a.type === 'await_human');
  } catch {
    // A merge the engine couldn't run also needs a human to clear it.
    return true;
  }
}

/** Whether time and cost count against the budget right now. */
function charging(state: RunState, config: Config): boolean {
  return state.mode === 'orchestrated' && !waitingOnHuman(state, config);
}

/**
 * Charges the time since the last tick, if the run was orchestrated and had work to do. Called
 * before every mutation, so the gap is attributed to the state the run was in during it.
 */
export function chargeTime(state: RunState, config: Config, ctx: Ctx): void {
  const budget = state.budget;
  if (!budget) {
    if (state.mode === 'orchestrated') ensureBudget(state, ctx.now);
    return;
  }
  if (charging(state, config)) budget.activeMs += Math.max(0, Date.parse(ctx.now) - Date.parse(budget.tickedAt));
  budget.tickedAt = ctx.now;
}

/**
 * Records a Claude Code session's cumulative cost. Only the increase since that session's last
 * report is charged, and only while the run is orchestrated and has work to do.
 */
export function chargeCost(state: RunState, config: Config, session: string, totalUsd: number, ctx: Ctx): void {
  if (state.status !== 'active' || !Number.isFinite(totalUsd) || totalUsd < 0) return;
  if (!state.budget && state.mode !== 'orchestrated') return;
  const budget = ensureBudget(state, ctx.now);
  const last = budget.sessions[session] ?? 0;
  const increase = totalUsd - last;
  if (increase <= 0) return;
  budget.sessions[session] = totalUsd;
  if (charging(state, config)) budget.costUsd += increase;
}

/** Pauses the run (see `nextActions`) the first time a limit is exceeded. */
export function checkBudget(state: RunState, config: Config, ctx: Ctx): void {
  const budget = state.budget;
  if (!budget || budget.exceeded || state.status !== 'active') return;
  const limits = budgetLimits(state, config);
  const over: string[] = [];
  if (budget.activeMs > limits.durationMs) {
    over.push(`ran for ${formatDuration(budget.activeMs)}, over the ${formatDuration(limits.durationMs)} budget`);
  }
  if (budget.costUsd > limits.costUsd) {
    over.push(`spent $${budget.costUsd.toFixed(2)}, over the $${limits.costUsd.toFixed(2)} budget`);
  }
  if (over.length === 0) return;
  budget.exceeded = over.join('; ');
  ctx.events.push({ ts: ctx.now, run: state.id, type: 'budget.exceeded', note: budget.exceeded });
  state.updatedAt = ctx.now;
}

/** A human's go-ahead after a pause: the configured limits are granted again on top of what's spent. */
export function extendBudget(state: RunState, config: Config, note: string | undefined, ctx: Ctx): void {
  if (state.status !== 'active') throw new GenieError(`run ${state.id} is ${state.status}`);
  const budget = state.budget;
  if (!budget?.exceeded) throw new GenieError('the run is within its budget; there is nothing to approve');
  budget.extensions += 1;
  delete budget.exceeded;
  budget.tickedAt = ctx.now;
  const limits = budgetLimits(state, config);
  ctx.events.push({
    ts: ctx.now,
    run: state.id,
    type: 'budget.extended',
    by: 'human',
    source: 'human',
    note: note ?? `limits now ${formatDuration(limits.durationMs)} and $${limits.costUsd.toFixed(2)}`,
  });
  state.updatedAt = ctx.now;
}

/** One line for `genie status`: what's been used against the limits in force. */
export function describeBudget(state: RunState, config: Config): string | undefined {
  const budget = state.budget;
  if (!budget) return undefined;
  const limits = budgetLimits(state, config);
  return `budget: ${formatDuration(budget.activeMs)} of ${formatDuration(limits.durationMs)} · $${budget.costUsd.toFixed(2)} of $${limits.costUsd.toFixed(2)}${budget.exceeded ? ' · paused' : ''}`;
}
