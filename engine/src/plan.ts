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

const PROSE_FIELDS = new Set(['title', 'goal', 'tests']);

/**
 * Prose values that a `#` cut short. In YAML, ` #` starts a comment even mid-sentence, so
 * `goal: add ## Usage docs` parses as "add". Comments are fine elsewhere (the example plan
 * annotates ids), but on a title, goal, or test they're almost always lost text.
 */
export function truncatedProse(text: string): string[] {
  const doc = YAML.parseDocument(text);
  const slices = doc.get('slices');
  if (!YAML.isSeq(slices)) return [];
  const problems: string[] = [];
  const cut = (node: unknown): boolean => {
    if (!YAML.isScalar(node) || !node.range || typeof node.value !== 'string') return false;
    const [, end] = node.range;
    const lineEnd = text.indexOf('\n', end);
    return text.slice(end, lineEnd === -1 ? undefined : lineEnd).trimStart().startsWith('#');
  };
  slices.items.forEach((slice, i) => {
    if (!YAML.isMap(slice)) return;
    for (const pair of slice.items) {
      const key = YAML.isScalar(pair.key) ? String(pair.key.value) : '';
      if (!PROSE_FIELDS.has(key)) continue;
      const values = YAML.isSeq(pair.value) ? pair.value.items.map((v, j) => [`/${j}`, v] as const) : [['', pair.value] as const];
      for (const [where, node] of values) {
        if (cut(node)) {
          problems.push(`/slices/${i}/${key}${where}: a "#" starts a YAML comment here, cutting the text short; quote the value`);
        }
      }
    }
  });
  return problems;
}

/** Reads and validates plan.yaml, throwing one error that lists every problem. */
export function loadPlan(planPath: string, specPath: string): Plan {
  if (!existsSync(planPath)) throw new GenieError(`stage decompose requires plan.yaml in the run directory`);
  const text = readFileSync(planPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch (err) {
    throw new GenieError(`plan.yaml: invalid YAML: ${(err as Error).message}`);
  }
  const spec = existsSync(specPath) ? readFileSync(specPath, 'utf8') : '';
  const problems = [...truncatedProse(text), ...planProblems(parsed, spec)];
  if (problems.length > 0) {
    throw new GenieError(`plan.yaml is invalid:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  }
  return parsed as Plan;
}
