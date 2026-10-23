import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { advance, completeWork, nextAction, nextActions, recordVerdict, type Ctx, type VerdictInput } from './engine.ts';
import { resolveConfig } from './config/load.ts';
import type { Config, ConfigLayer, ProfileName } from './config/types.ts';
import type { PlanSlice } from './plan.ts';
import { findSlice, newRunState, type RunState } from './state.ts';
import type { StageName } from './pipeline.ts';

const NO_DEPLOY: ConfigLayer = { stages: { deploy: { enabled: false } } };

function slice(id: string, depends_on: string[] = []): PlanSlice {
  return { id, title: `slice ${id}`, goal: `do ${id}`, covers: [], tests: [`test ${id}`], depends_on };
}

const ONE_SLICE = [slice('S1')];

function setup(profile: ProfileName = 'service', layer: ConfigLayer = {}): { state: RunState; config: Config; ctx: Ctx } {
  const config = resolveConfig(profile, [NO_DEPLOY, layer]);
  const ctx: Ctx = { now: '2026-10-22T00:00:00.000Z', events: [] };
  const state = newRunState({ id: 'r1', title: 'test run', mode: 'guided', branch: 'genie/r1', base: 'main' }, ctx.now);
  advance(state, config, ctx);
  return { state, config, ctx };
}

type T = ReturnType<typeof setup>;
const always = () => true;

function work(t: T, stage: StageName, by = 'claude', opts: { slice?: string; plan?: PlanSlice[] } = {}) {
  completeWork(t.state, t.config, stage, by, always, t.ctx, opts);
}

function verdict(t: T, input: Partial<VerdictInput> & Pick<VerdictInput, 'gate'>) {
  recordVerdict(t.state, t.config, { verdict: 'pass', source: 'human', by: 'human', ...input }, t.ctx);
}

const verify = (t: T, extra: Partial<VerdictInput> = {}) =>
  verdict(t, { gate: 'slice.verified', source: 'automated', by: 'genie', ...extra });
const review = (t: T, extra: Partial<VerdictInput> = {}) =>
  verdict(t, { gate: 'slice.reviewed', source: 'agent', by: 'adversarial-reviewer', ...extra });

/** Drives a run through spec and decompose with `plan`, into the implement stage. */
function toImplement(t: T, plan: PlanSlice[] = ONE_SLICE) {
  work(t, 'spec');
  verdict(t, { gate: 'spec.approved' });
  work(t, 'decompose', 'claude', { plan });
  verdict(t, { gate: 'plan.approved' });
}

/** …and through the single slice's work, to its gates. */
function toSliceGates(t: T) {
  toImplement(t);
  work(t, 'implement', 'implementer');
}

describe('advance', () => {
  it('starts a new run at spec work', () => {
    const { state, config } = setup();
    const action = nextAction(state, config);
    assert.equal(state.stage, 'spec');
    assert.equal(action.type, 'work');
    assert.equal(action.type === 'work' && action.artifact, 'spec.md');
  });

  it('skips disabled gates and logs the skip', () => {
    const t = setup('service', { gates: { 'spec.approved': { enabled: false } } });
    work(t, 'spec');
    assert.equal(t.state.gates['spec.approved'].status, 'skipped');
    assert.equal(t.state.stage, 'decompose');
    assert.ok(t.ctx.events.some((e) => e.type === 'gate.skipped' && e.gate === 'spec.approved'));
  });
});

describe('plan and slices', () => {
  it('records the plan as slices when decompose is done', () => {
    const t = setup();
    work(t, 'spec');
    verdict(t, { gate: 'spec.approved' });
    assert.throws(() => work(t, 'decompose'), /requires a validated plan/);
    work(t, 'decompose', 'claude', { plan: [slice('S1'), slice('S2', ['S1'])] });
    assert.deepEqual(
      t.state.slices.map((s) => [s.def.id, s.phase]),
      [
        ['S1', 'work'],
        ['S2', 'work'],
      ],
    );
    assert.ok(t.ctx.events.some((e) => e.type === 'plan.recorded' && e.note === 'S1, S2'));
  });

  it('offers slice work in dependency order and passes implement once every slice has', () => {
    const t = setup();
    toImplement(t, [slice('S1'), slice('S2', ['S1'])]);
    let action = nextAction(t.state, t.config);
    assert.equal(action.type === 'work' && action.slice?.id, 'S1');
    assert.throws(() => work(t, 'implement', 'implementer', { slice: 'S2' }), /depends on S1, which hasn't passed/);

    work(t, 'implement', 'implementer');
    verify(t);
    review(t);
    assert.equal(findSlice(t.state, 'S1')?.phase, 'passed');
    assert.equal(t.state.stage, 'implement', 'S2 still to do');
    action = nextAction(t.state, t.config);
    assert.deepEqual(action.type === 'work' && action.slice, { ...slice('S2', ['S1']) });

    work(t, 'implement', 'implementer');
    verify(t);
    review(t);
    assert.equal(t.state.stages.implement.phase, 'passed');
    assert.equal(t.state.stage, 'integrate');
  });

  it('lists every ready slice for an orchestrator, with guided mode taking the first', () => {
    const t = setup();
    toImplement(t, [slice('A'), slice('B'), slice('C', ['A', 'B'])]);
    const ready = () => nextActions(t.state, t.config).map((a) => `${a.type}:${'slice' in a ? a.slice?.id : ''}`);
    assert.deepEqual(ready(), ['work:A', 'work:B']);

    assert.throws(() => work(t, 'implement', 'implementer'), /pass --slice <id> to say which slice is done \(ready: A, B\)/);
    work(t, 'implement', 'implementer', { slice: 'B' });
    assert.deepEqual(ready(), ['work:A', 'evaluate:B']);
    // With only A left to work on, --slice can be left out.
    work(t, 'implement', 'implementer');
    assert.equal(findSlice(t.state, 'A')?.phase, 'exit');
    verify(t, { slice: 'A' });
    verify(t, { slice: 'B' });
    review(t, { slice: 'A' });
    review(t, { slice: 'B' });
    assert.deepEqual(ready(), ['work:C']);
  });

  it('requires --slice when several slices await the same gate', () => {
    const t = setup();
    toImplement(t, [slice('A'), slice('B')]);
    work(t, 'implement', 'implementer', { slice: 'A' });
    work(t, 'implement', 'implementer', { slice: 'B' });
    assert.throws(() => verify(t), /pass --slice <id>: slice.verified is awaiting verdicts for A, B/);
    verify(t, { slice: 'B' });
    assert.equal(findSlice(t.state, 'B')?.gates['slice.verified'].status, 'pass');
    assert.equal(findSlice(t.state, 'A')?.gates['slice.verified'].status, 'pending');
    assert.throws(() => verify(t, { slice: 'B' }), /not awaiting a verdict for slice B \(current: slice.reviewed\)/);
  });

  it('reworks only the failing slice', () => {
    const t = setup();
    toImplement(t, [slice('A'), slice('B')]);
    work(t, 'implement', 'implementer', { slice: 'A' });
    work(t, 'implement', 'implementer', { slice: 'B' });
    verify(t, { slice: 'A' });
    verify(t, { slice: 'B', verdict: 'fail' });
    assert.equal(findSlice(t.state, 'B')?.phase, 'work');
    assert.equal(findSlice(t.state, 'B')?.gates['slice.verified'].failures, 1);
    assert.equal(findSlice(t.state, 'A')?.phase, 'exit');
    assert.ok(t.ctx.events.some((e) => e.type === 'slice.rework' && e.slice === 'B' && e.gate === 'slice.verified'));
  });

  it('adds a fix-up slice when a run-level gate sends the run back to implement', () => {
    const t = setup();
    toSliceGates(t);
    verify(t);
    review(t);
    work(t, 'integrate');
    verdict(t, { gate: 'integration.verified', source: 'automated', by: 'genie', verdict: 'fail', note: 'suite broke' });

    assert.equal(t.state.stage, 'implement');
    const fix = findSlice(t.state, 'F1');
    assert.equal(fix?.fixes, 'integration.verified');
    assert.equal(fix?.phase, 'work');
    assert.equal(findSlice(t.state, 'S1')?.phase, 'passed');
    const action = nextAction(t.state, t.config);
    assert.equal(action.type === 'work' && action.slice?.id, 'F1');

    // The fix goes through the same gates, then the run moves on.
    work(t, 'implement', 'implementer', { slice: 'F1' });
    verify(t);
    review(t);
    assert.equal(t.state.stage, 'integrate');
  });

  it('discards the slices when the run goes back to planning', () => {
    const t = setup();
    toSliceGates(t);
    verify(t);
    review(t);
    work(t, 'integrate');
    verdict(t, { gate: 'integration.verified', source: 'automated', by: 'genie' });
    work(t, 'pr');
    verdict(t, { gate: 'pr.ready', source: 'automated', by: 'genie' });
    verdict(t, { gate: 'intent.reviewed', source: 'agent', by: 'intent-reviewer', verdict: 'fail' });

    assert.equal(t.state.stage, 'spec');
    assert.deepEqual(t.state.slices, []);
    assert.ok(t.ctx.events.some((e) => e.type === 'plan.discarded'));
  });

  it('has no slices to work on if the plan was never recorded', () => {
    const t = setup();
    toImplement(t);
    t.state.slices = [];
    assert.throws(() => work(t, 'implement', 'implementer'), /no slices/);
  });
});

describe('recordVerdict invariants', () => {
  it('refuses agent verdicts on human gates', () => {
    const t = setup();
    work(t, 'spec');
    assert.throws(() => verdict(t, { gate: 'spec.approved', source: 'agent', by: 'spec-reviewer' }), /human gate/);
  });

  it('refuses verdicts from the slice author', () => {
    const t = setup();
    toSliceGates(t);
    verify(t);
    assert.throws(() => review(t, { by: 'implementer' }), /implementer authored slice S1/);
  });

  it('refuses verdicts for a gate that is not current', () => {
    const t = setup();
    assert.throws(() => verdict(t, { gate: 'plan.approved' }), /not awaiting/);
    assert.throws(() => verify(t), /not awaiting a verdict for any slice/);
  });

  it('refuses human verdicts on automated gates until escalated', () => {
    const t = setup();
    toSliceGates(t);
    assert.throws(() => verdict(t, { gate: 'slice.verified' }), /automated gate/);
  });
});

describe('failure routing', () => {
  it('sends a failed slice gate back to the slice', () => {
    const t = setup();
    toSliceGates(t);
    verify(t, { verdict: 'fail' });
    assert.equal(t.state.stage, 'implement');
    assert.equal(t.state.stages.implement.phase, 'work');
    assert.equal(findSlice(t.state, 'S1')?.phase, 'work');
    assert.equal(findSlice(t.state, 'S1')?.gates['slice.verified'].failures, 1);
  });

  it('escalates to a human once retries are exhausted, and the human can pass it', () => {
    const t = setup('service', { gates: { 'slice.verified': { retries: 1 } } });
    toSliceGates(t);
    verify(t, { verdict: 'fail' });
    work(t, 'implement', 'implementer');
    verify(t, { verdict: 'fail' });
    const gate = () => findSlice(t.state, 'S1')!.gates['slice.verified'];
    assert.equal(gate().status, 'needs_human');
    const action = nextAction(t.state, t.config);
    assert.equal(action.type, 'await_human');
    assert.equal(action.type === 'await_human' && action.slice?.id, 'S1');
    assert.throws(() => verify(t), /escalated/);
    verdict(t, { gate: 'slice.verified' });
    assert.equal(gate().status, 'pass');
  });

  it('halts instead of escalating when escalate_to is halt', () => {
    const t = setup('service', { gates: { 'slice.verified': { retries: 0, escalate_to: 'halt' } } });
    toSliceGates(t);
    verify(t, { verdict: 'fail' });
    assert.equal(t.state.status, 'halted');
    assert.match(t.state.haltReason!, /slice S1/);
    assert.equal(nextAction(t.state, t.config).type, 'halted');
  });

  it('records advisory failures without stopping the run', () => {
    const t = setup('prototype');
    toSliceGates(t);
    verify(t);
    review(t, { verdict: 'fail' });
    assert.equal(findSlice(t.state, 'S1')?.gates['slice.reviewed'].status, 'fail');
    assert.equal(t.state.stage, 'integrate');
  });

  it('skips disabled slice gates', () => {
    const t = setup('service', { gates: { 'slice.reviewed': { enabled: false } } });
    toSliceGates(t);
    verify(t);
    assert.equal(findSlice(t.state, 'S1')?.gates['slice.reviewed'].status, 'skipped');
    assert.ok(t.ctx.events.some((e) => e.type === 'gate.skipped' && e.gate === 'slice.reviewed' && e.slice === 'S1'));
    assert.equal(t.state.stage, 'integrate');
  });

  it('rewinds intermediate stages when a late gate routes back to spec', () => {
    const t = setup();
    toSliceGates(t);
    verify(t);
    review(t);
    work(t, 'integrate');
    verdict(t, { gate: 'integration.verified', source: 'automated', by: 'genie' });
    work(t, 'pr');
    verdict(t, { gate: 'pr.ready', source: 'automated', by: 'genie' });
    verdict(t, { gate: 'intent.reviewed', source: 'agent', by: 'intent-reviewer', verdict: 'fail' });

    assert.equal(t.state.stage, 'spec');
    assert.equal(t.state.stages.spec.phase, 'work');
    assert.equal(t.state.gates['spec.approved'].status, 'pending');
    assert.equal(t.state.stages.implement.phase, 'pending');
    assert.equal(t.state.gates['intent.reviewed'].failures, 1);
  });

  it('gives the work a fresh budget after a human rejection', () => {
    const t = setup();
    work(t, 'spec');
    verdict(t, { gate: 'spec.approved', verdict: 'fail' });
    assert.equal(t.state.stage, 'spec');
    assert.equal(t.state.stages.spec.phase, 'work');
    assert.equal(t.state.gates['spec.approved'].failures, 0);
  });
});

describe('agent+human gates', () => {
  it('collects the agent pre-review, then waits for the human', () => {
    const t = setup('service', { gates: { 'spec.approved': { kind: 'agent+human', evaluator: 'spec-reviewer' } } });
    work(t, 'spec');
    assert.equal(nextAction(t.state, t.config).type, 'evaluate');
    verdict(t, { gate: 'spec.approved', source: 'agent', by: 'spec-reviewer', note: 'looks complete' });
    const action = nextAction(t.state, t.config);
    assert.equal(action.type, 'await_human');
    assert.equal(action.type === 'await_human' && action.agentReview?.by, 'spec-reviewer');
    verdict(t, { gate: 'spec.approved' });
    assert.equal(t.state.stage, 'decompose');
  });
});

describe('end to end', () => {
  it('reaches done on the prototype profile', () => {
    const t = setup('prototype');
    toSliceGates(t);
    verify(t);
    review(t);
    work(t, 'integrate');
    verdict(t, { gate: 'integration.verified', source: 'automated', by: 'genie' });
    work(t, 'pr');
    verdict(t, { gate: 'pr.ready', source: 'automated', by: 'genie' });
    work(t, 'merge');
    verdict(t, { gate: 'build.passed', source: 'automated', by: 'genie' });
    assert.equal(t.state.status, 'done');
    assert.equal(nextAction(t.state, t.config).type, 'done');
    assert.deepEqual(
      ['deploy', 'release'].map((s) => t.state.stages[s as StageName].phase),
      ['skipped', 'skipped'],
    );
  });
});
