import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { budgetLimits, chargeCost, chargeTime, checkBudget, describeBudget, extendBudget, parseDuration } from './budget.ts';
import { advance, completeWork, nextAction, type Ctx } from './engine.ts';
import { resolveConfig } from './config/load.ts';
import { newRunState, type RunState } from './state.ts';

const config = resolveConfig('internal-tool', [{ stages: { deploy: { enabled: false } }, budgets: { max_run_duration: '2h', max_cost_usd: 10 } }]);
const T0 = Date.parse('2026-10-23T10:00:00Z');
const at = (hours: number): Ctx => ({ now: new Date(T0 + hours * 3_600_000).toISOString(), events: [] });

function run(mode: 'guided' | 'orchestrated' = 'orchestrated'): RunState {
  const state = newRunState({ id: 'r', title: 't', mode, branch: 'genie/r', base: 'main' }, at(0).now);
  advance(state, config, at(0));
  return state;
}

/** One mutation's worth of budget bookkeeping, as mutateRun does it. */
function tick(state: RunState, ctx: Ctx, fn: (s: RunState, c: Ctx) => void = () => undefined): Ctx {
  advance(state, config, ctx);
  chargeTime(state, config, ctx);
  fn(state, ctx);
  checkBudget(state, config, ctx);
  return ctx;
}

describe('budgets', () => {
  it('parses durations', () => {
    assert.equal(parseDuration('30m'), 1_800_000);
    assert.equal(parseDuration('4h'), 14_400_000);
    assert.equal(parseDuration('2d'), 172_800_000);
    assert.throws(() => parseDuration('4 hours'), /invalid duration/);
  });

  it('charges orchestrated time with work to do, and pauses the run once over the limit', () => {
    const state = run();
    tick(state, at(0));
    tick(state, at(1.5));
    assert.equal(state.budget?.activeMs, 1.5 * 3_600_000);
    assert.equal(nextAction(state, config).type, 'work');

    const ctx = tick(state, at(2.5));
    assert.equal(state.budget?.exceeded, 'ran for 2h30m, over the 2h budget');
    assert.deepEqual(ctx.events.map((e) => e.type), ['budget.exceeded']);
    assert.deepEqual(nextAction(state, config), { type: 'over_budget', reason: 'ran for 2h30m, over the 2h budget' });
    assert.equal(describeBudget(state, config), 'budget: 2h30m of 2h · $0.00 of $10.00 · paused');

    // Paused time isn't charged; a human extension grants the limits again.
    tick(state, at(10));
    assert.equal(state.budget?.activeMs, 2.5 * 3_600_000);
    const extended = tick(state, at(10), (s, c) => extendBudget(s, config, undefined, c));
    assert.equal(state.budget?.exceeded, undefined);
    assert.deepEqual(budgetLimits(state, config), { durationMs: 4 * 3_600_000, costUsd: 20 });
    assert.equal(extended.events[0]?.note, 'limits now 4h and $20.00');
    assert.equal(nextAction(state, config).type, 'work');
    assert.throws(() => extendBudget(state, config, undefined, at(10)), /within its budget/);
  });

  it("doesn't charge time spent waiting on a human, or in guided mode", () => {
    const state = run();
    tick(state, at(0));
    tick(state, at(1), (s, c) => completeWork(s, config, 'spec', 'claude', () => true, c));
    assert.equal(nextAction(state, config).type, 'await_human');
    tick(state, at(30));
    assert.equal(state.budget?.activeMs, 3_600_000, 'a night at spec.approved costs nothing');

    const guided = run('guided');
    tick(guided, at(0));
    tick(guided, at(5));
    assert.equal(guided.budget, undefined);
    checkBudget(guided, config, at(5));
    assert.equal(nextAction(guided, config).type, 'work');
  });

  it("charges each session's cost increase once", () => {
    const state = run();
    tick(state, at(0));
    chargeCost(state, config, 'a', 3, at(0.1));
    chargeCost(state, config, 'a', 3, at(0.2));
    chargeCost(state, config, 'a', 4.5, at(0.3));
    chargeCost(state, config, 'b', 2, at(0.4));
    chargeCost(state, config, 'a', 1, at(0.5)); // stale report
    assert.equal(state.budget?.costUsd, 6.5);

    // Spend while a human gate is pending is recorded but not charged.
    tick(state, at(0.6), (s, c) => completeWork(s, config, 'spec', 'claude', () => true, c));
    chargeCost(state, config, 'a', 9, at(0.7));
    assert.equal(state.budget?.costUsd, 6.5);
    assert.equal(state.budget?.sessions.a, 9);

    const guided = run('guided');
    chargeCost(guided, config, 'a', 100, at(1));
    assert.equal(guided.budget, undefined);
  });

  it('pauses on cost too', () => {
    const state = run();
    tick(state, at(0));
    tick(state, at(0.1), (s, c) => chargeCost(s, config, 'a', 12.345, c));
    assert.equal(state.budget?.exceeded, 'spent $12.35, over the $10.00 budget');
  });
});
