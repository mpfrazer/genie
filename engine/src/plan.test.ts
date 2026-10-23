import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import YAML from 'yaml';
import { loadPlan, planProblems, requirementIds, truncatedProse } from './plan.ts';

const SPEC = '# Spec\n\n- R1: greet by name\n- R2: reject empty names (see R1)\n';

function slice(id: string, extra: Record<string, unknown> = {}) {
  return { id, title: `t ${id}`, goal: `g ${id}`, covers: [], tests: [`test ${id}`], depends_on: [], ...extra };
}

describe('requirementIds', () => {
  it('finds R-ids once each, in order, ignoring longer words', () => {
    assert.deepEqual(requirementIds('R2 then R1, R2 again; R2D2 and FOR10 are not ids'), ['R2', 'R1']);
  });
});

describe('planProblems', () => {
  it('accepts a valid plan', () => {
    const plan = { slices: [slice('S1', { covers: ['R1'] }), slice('S2', { covers: ['R2'], depends_on: ['S1'] })] };
    assert.deepEqual(planProblems(plan, SPEC), []);
  });

  it('reports schema violations with their location', () => {
    const problems = planProblems({ slices: [{ id: 'S1', title: 'x' }] }, '');
    assert.ok(problems.some((p) => p.includes("/slices/0: must have required property 'goal'")), problems.join('\n'));
    assert.ok(planProblems({ slices: [] }, '').some((p) => p.includes('must NOT have fewer than 1 items')));
    assert.ok(planProblems({ slices: [slice('has space')] }, '').some((p) => p.includes('/slices/0/id')));
  });

  it('reports duplicate ids, unknown and self dependencies', () => {
    const problems = planProblems({ slices: [slice('S1', { depends_on: ['S1'] }), slice('S1'), slice('S2', { depends_on: ['S9'] })] }, '');
    assert.deepEqual(problems, ['duplicate slice id S1', 'S1 depends on itself', 'S2 depends on unknown slice S9']);
  });

  it('reports a dependency cycle as a path', () => {
    const plan = {
      slices: [slice('A', { depends_on: ['C'] }), slice('B', { depends_on: ['A'] }), slice('C', { depends_on: ['B'] })],
    };
    assert.deepEqual(planProblems(plan, ''), ['dependency cycle: A → C → B → A']);
  });

  it('requires every spec requirement to be covered, and only those', () => {
    const plan = { slices: [slice('S1', { covers: ['R1', 'R7'] })] };
    assert.deepEqual(planProblems(plan, SPEC), [
      'requirements not covered by any slice: R2',
      'S1 covers requirements not in spec.md: R7',
    ]);
  });

  it('skips coverage when the spec numbers no requirements', () => {
    assert.deepEqual(planProblems({ slices: [slice('S1', { covers: ['R3'] })] }, '# spec without ids'), []);
  });
});

describe('truncatedProse', () => {
  it('flags titles, goals and tests that a # comment cut short, and nothing else', () => {
    const text = [
      'slices:',
      '  - id: S1  # branch-safe',
      '    title: Docs',
      '    goal: README gets ## modulo sections',
      '    # a full-line comment is fine',
      '    covers: [R1] # so is this',
      '    tests:',
      '      - has ## headings',
      '      - "quoted ## is fine"',
      '      - fine',
      '    depends_on: []',
    ].join('\n');
    assert.deepEqual(truncatedProse(text), [
      '/slices/0/goal: a "#" starts a YAML comment here, cutting the text short; quote the value',
      '/slices/0/tests/0: a "#" starts a YAML comment here, cutting the text short; quote the value',
    ]);
    assert.deepEqual(truncatedProse('slices: nope'), []);
  });
});

describe('loadPlan', () => {
  function dir(plan?: string, spec = SPEC) {
    const d = mkdtempSync(join(tmpdir(), 'genie-plan-'));
    if (plan !== undefined) writeFileSync(join(d, 'plan.yaml'), plan);
    writeFileSync(join(d, 'spec.md'), spec);
    return { plan: join(d, 'plan.yaml'), spec: join(d, 'spec.md') };
  }

  it('reads a valid plan', () => {
    const p = dir(YAML.stringify({ slices: [slice('S1', { covers: ['R1', 'R2'] })] }));
    assert.equal(loadPlan(p.plan, p.spec).slices[0]?.id, 'S1');
  });

  it('lists every problem in one error', () => {
    const p = dir(YAML.stringify({ slices: [slice('S1', { depends_on: ['S2'] })] }));
    assert.throws(
      () => loadPlan(p.plan, p.spec),
      /plan.yaml is invalid:\n {2}S1 depends on unknown slice S2\n {2}requirements not covered by any slice: R1, R2/,
    );
  });

  it('explains a missing or unparseable plan', () => {
    const missing = dir();
    assert.throws(() => loadPlan(missing.plan, missing.spec), /requires plan.yaml/);
    const broken = dir('slices: [unclosed');
    assert.throws(() => loadPlan(broken.plan, broken.spec), /plan.yaml: invalid YAML/);
  });
});
