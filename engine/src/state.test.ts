import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GATES, STAGES } from './pipeline.ts';
import { migrateState, STATE_VERSION, V1_HALT_REASON } from './state.ts';

/** A state.json as written by genie ≤0.3 (state v1). */
function v1(stage: string, phase: string, status = 'active') {
  return {
    version: 1,
    id: 'old',
    title: 'old run',
    mode: 'guided',
    status,
    stage,
    branch: 'genie/old',
    base: 'main',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    stages: Object.fromEntries(STAGES.map((s) => [s, { phase: s === stage ? phase : 'pending' }])),
    gates: Object.fromEntries(GATES.map((g) => [g, { status: g === 'spec.approved' ? 'pass' : 'pending', attempts: 1, failures: 0 }])),
  };
}

describe('migrateState', () => {
  it('leaves current state alone', () => {
    const current = { ...v1('spec', 'work'), version: STATE_VERSION, slices: [] };
    assert.equal(migrateState(current, 'x'), current);
  });

  it('upgrades a v1 run that is still planning', () => {
    const state = migrateState(v1('decompose', 'work'), 'old');
    assert.equal(state.version, STATE_VERSION);
    assert.equal(state.status, 'active');
    assert.deepEqual(state.slices, []);
    assert.equal(state.gates['spec.approved'].status, 'pass', 'run-level gate history is kept');
    assert.ok(!('slice.verified' in state.gates), 'run-level slice gates are dropped');
  });

  it('halts, with an explanation, a v1 run that is past planning', () => {
    for (const [stage, phase] of [
      ['decompose', 'exit'],
      ['implement', 'work'],
      ['pr', 'exit'],
    ] as const) {
      const state = migrateState(v1(stage, phase), 'old');
      assert.equal(state.status, 'halted', `${stage}/${phase}`);
      assert.equal(state.haltReason, V1_HALT_REASON);
    }
  });

  it('upgrades finished and aborted v1 runs as they are', () => {
    assert.equal(migrateState(v1('implement', 'work', 'aborted'), 'old').status, 'aborted');
    assert.equal(migrateState(v1('release', 'passed', 'done'), 'old').status, 'done');
  });

  it('rejects unknown versions', () => {
    assert.throws(() => migrateState({ version: 9 }, 'future'), /state version 9/);
  });
});
