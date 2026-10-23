import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { advance, completeWork, nextAction, recordVerdict, type Ctx, type VerdictInput } from './engine.ts';
import { resolveConfig } from './config/load.ts';
import type { Config, ConfigLayer, ProfileName } from './config/types.ts';
import { newRunState, type RunState } from './state.ts';
import type { StageName } from './pipeline.ts';

const NO_DEPLOY: ConfigLayer = { stages: { deploy: { enabled: false } } };

function setup(profile: ProfileName = 'service', layer: ConfigLayer = {}): { state: RunState; config: Config; ctx: Ctx } {
  const config = resolveConfig(profile, [NO_DEPLOY, layer]);
  const ctx: Ctx = { now: '2026-10-22T00:00:00.000Z', events: [] };
  const state = newRunState('r1', 'test run', 'guided', ctx.now);
  advance(state, config, ctx);
  return { state, config, ctx };
}

const always = () => true;

function work(t: ReturnType<typeof setup>, stage: StageName, by = 'claude') {
  completeWork(t.state, t.config, stage, by, always, t.ctx);
}

function verdict(t: ReturnType<typeof setup>, input: Partial<VerdictInput> & Pick<VerdictInput, 'gate'>) {
  recordVerdict(t.state, t.config, { verdict: 'pass', source: 'human', by: 'human', ...input }, t.ctx);
}

/** Drives a run through spec and decompose to implement's exit gates. */
function toImplementGates(t: ReturnType<typeof setup>) {
  work(t, 'spec');
  verdict(t, { gate: 'spec.approved' });
  work(t, 'decompose');
  verdict(t, { gate: 'plan.approved' });
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

describe('recordVerdict invariants', () => {
  it('refuses agent verdicts on human gates', () => {
    const t = setup();
    work(t, 'spec');
    assert.throws(() => verdict(t, { gate: 'spec.approved', source: 'agent', by: 'spec-reviewer' }), /human gate/);
  });

  it('refuses verdicts from the stage author', () => {
    const t = setup();
    toImplementGates(t);
    verdict(t, { gate: 'slice.verified', source: 'automated', by: 'genie' });
    assert.throws(() => verdict(t, { gate: 'slice.reviewed', source: 'agent', by: 'implementer' }), /authored/);
  });

  it('refuses verdicts for a gate that is not current', () => {
    const t = setup();
    assert.throws(() => verdict(t, { gate: 'plan.approved' }), /not awaiting/);
  });

  it('refuses human verdicts on automated gates until escalated', () => {
    const t = setup();
    toImplementGates(t);
    assert.throws(() => verdict(t, { gate: 'slice.verified' }), /automated gate/);
  });
});

describe('failure routing', () => {
  it('sends a failed automated gate back to its stage', () => {
    const t = setup();
    toImplementGates(t);
    verdict(t, { gate: 'slice.verified', source: 'automated', by: 'genie', verdict: 'fail' });
    assert.equal(t.state.stage, 'implement');
    assert.equal(t.state.stages.implement.phase, 'work');
    assert.equal(t.state.gates['slice.verified'].failures, 1);
  });

  it('escalates to a human once retries are exhausted, and the human can pass it', () => {
    const t = setup('service', { gates: { 'slice.verified': { retries: 1 } } });
    toImplementGates(t);
    verdict(t, { gate: 'slice.verified', source: 'automated', by: 'genie', verdict: 'fail' });
    work(t, 'implement', 'implementer');
    verdict(t, { gate: 'slice.verified', source: 'automated', by: 'genie', verdict: 'fail' });
    assert.equal(t.state.gates['slice.verified'].status, 'needs_human');
    assert.equal(nextAction(t.state, t.config).type, 'await_human');
    assert.throws(() => verdict(t, { gate: 'slice.verified', source: 'automated', by: 'genie' }), /escalated/);
    verdict(t, { gate: 'slice.verified' });
    assert.equal(t.state.gates['slice.verified'].status, 'pass');
  });

  it('halts instead of escalating when escalate_to is halt', () => {
    const t = setup('service', { gates: { 'slice.verified': { retries: 0, escalate_to: 'halt' } } });
    toImplementGates(t);
    verdict(t, { gate: 'slice.verified', source: 'automated', by: 'genie', verdict: 'fail' });
    assert.equal(t.state.status, 'halted');
    assert.equal(nextAction(t.state, t.config).type, 'halted');
  });

  it('records advisory failures without stopping the run', () => {
    const t = setup('prototype');
    toImplementGates(t);
    verdict(t, { gate: 'slice.verified', source: 'automated', by: 'genie' });
    verdict(t, { gate: 'slice.reviewed', source: 'agent', by: 'adversarial-reviewer', verdict: 'fail' });
    assert.equal(t.state.gates['slice.reviewed'].status, 'fail');
    assert.equal(t.state.stage, 'integrate');
  });

  it('rewinds intermediate stages when a late gate routes back to spec', () => {
    const t = setup();
    toImplementGates(t);
    verdict(t, { gate: 'slice.verified', source: 'automated', by: 'genie' });
    verdict(t, { gate: 'slice.reviewed', source: 'agent', by: 'adversarial-reviewer' });
    work(t, 'integrate');
    verdict(t, { gate: 'integration.verified', source: 'automated', by: 'genie' });
    work(t, 'pr');
    verdict(t, { gate: 'pr.ready', source: 'automated', by: 'genie' });
    verdict(t, { gate: 'intent.reviewed', source: 'agent', by: 'intent-reviewer', verdict: 'fail' });

    assert.equal(t.state.stage, 'spec');
    assert.equal(t.state.stages.spec.phase, 'work');
    assert.equal(t.state.gates['spec.approved'].status, 'pending');
    assert.equal(t.state.stages.implement.phase, 'pending');
    assert.equal(t.state.gates['slice.verified'].status, 'pending');
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
    toImplementGates(t);
    verdict(t, { gate: 'slice.verified', source: 'automated', by: 'genie' });
    verdict(t, { gate: 'slice.reviewed', source: 'agent', by: 'adversarial-reviewer' });
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
