// plan.yaml: the decompose stage's machine-readable contract, and the checks that make it trustworthy.
import { existsSync, readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import YAML from 'yaml';
import schema from '../../schema/plan.schema.json' with { type: 'json' };
import { GenieError } from './errors.ts';

export interface PlanSlice {
  id: string;
  title: string;
  goal: string;
  covers: string[];
  touches?: string[];
  tests: string[];
  depends_on: string[];
}

export interface Plan {
  slices: PlanSlice[];
}

const validateSchema = new Ajv({ allErrors: true }).compile(schema);

/** Requirement ids (R1, R2, …) mentioned anywhere in spec.md, in first-seen order. */
export function requirementIds(specText: string): string[] {
  return [...new Set(specText.match(/\bR\d+\b/g) ?? [])];
}

/** Returns a dependency cycle as a path (`S1 → S2 → S1`), or undefined if the graph is acyclic. */
function findCycle(slices: PlanSlice[]): string[] | undefined {
  const deps = new Map(slices.map((s) => [s.id, s.depends_on]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === 'done') return undefined;
    if (state.get(id) === 'visiting') return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 'visiting');
    stack.push(id);
    for (const dep of deps.get(id) ?? []) {
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, 'done');
    return undefined;
  };
  for (const s of slices) {
    const cycle = visit(s.id);
    if (cycle) return cycle;
  }
  return undefined;
}

/** Every problem with `plan`, checked against the requirement ids in spec.md. Empty means valid. */
export function planProblems(plan: unknown, specText: string): string[] {
  if (!validateSchema(plan)) {
    return (validateSchema.errors ?? []).map((e) => {
      const extra = e.keyword === 'additionalProperties' ? ` "${String(e.params.additionalProperty)}"` : '';
      return `${e.instancePath || '(root)'}: ${e.message}${extra}`;
    });
  }
  const { slices } = plan as unknown as Plan;
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const s of slices) {
    if (ids.has(s.id)) problems.push(`duplicate slice id ${s.id}`);
    ids.add(s.id);
  }
  for (const s of slices) {
    for (const dep of s.depends_on) {
      if (dep === s.id) problems.push(`${s.id} depends on itself`);
      else if (!ids.has(dep)) problems.push(`${s.id} depends on unknown slice ${dep}`);
    }
  }
  if (problems.length === 0) {
    const cycle = findCycle(slices);
    if (cycle) problems.push(`dependency cycle: ${cycle.join(' → ')}`);
  }

  const required = requirementIds(specText);
  if (required.length > 0) {
    const known = new Set(required);
    const covered = new Set(slices.flatMap((s) => s.covers));
    const uncovered = required.filter((r) => !covered.has(r));
    if (uncovered.length > 0) problems.push(`requirements not covered by any slice: ${uncovered.join(', ')}`);
    for (const s of slices) {
      const unknown = s.covers.filter((r) => !known.has(r));
      if (unknown.length > 0) problems.push(`${s.id} covers requirements not in spec.md: ${unknown.join(', ')}`);
    }
  }
  return problems;
}

/** Reads and validates plan.yaml, throwing one error that lists every problem. */
export function loadPlan(planPath: string, specPath: string): Plan {
  if (!existsSync(planPath)) throw new GenieError(`stage decompose requires plan.yaml in the run directory`);
  let parsed: unknown;
  try {
    parsed = YAML.parse(readFileSync(planPath, 'utf8'));
  } catch (err) {
    throw new GenieError(`plan.yaml: invalid YAML: ${(err as Error).message}`);
  }
  const spec = existsSync(specPath) ? readFileSync(specPath, 'utf8') : '';
  const problems = planProblems(parsed, spec);
  if (problems.length > 0) {
    throw new GenieError(`plan.yaml is invalid:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  }
  return parsed as Plan;
}
