import { gateConfig, type Action } from './engine.ts';
import { DELIVERY_GATES, SLICE_GATES, STAGE_DEFS, STAGES } from './pipeline.ts';
import type { Config } from './config/types.ts';
import { describeBudget } from './budget.ts';
import { findSlice, type GateState, type RunState, type SlicePhase, type StagePhase } from './state.ts';
import type { CheckResult } from './checks.ts';
import type { Feedback } from './commands/run.ts';

const PHASE_MARK: Record<StagePhase, string> = {
  pending: '·',
  entry: '▶',
  work: '▶',
  exit: '▶',
  passed: '✓',
  skipped: '–',
};

/** Why work was sent back: a failed gate (with its note) or a merge conflict. */
export function describeRework(feedback: Feedback): string {
  const cause = feedback.conflict ? 'a merge conflict' : `${feedback.gate} failed`;
  return `${cause}${feedback.note ? `: ${feedback.note}` : ''}`;
}

/** One line telling the reader what happens next, including the command to run. */
export function describeAction(action: Action): string {
  const slice = 'slice' in action && action.slice ? action.slice : undefined;
  const of = slice ? ` slice ${slice.id} (${slice.title})` : '';
  const flag = slice ? ` --slice ${slice.id}` : '';
  switch (action.type) {
    case 'work': {
      const what = slice && action.stage === 'implement' ? slice.goal : action.instructions;
      return `Work on ${action.stage}${of}${action.agent ? ` (${action.agent} subagent)` : ''}: ${what}${action.artifact ? ` (write ${action.artifact})` : ''}\n  then: genie done ${action.stage}${flag}${action.agent ? ` --by ${action.agent}` : ''}`;
    }
    case 'evaluate':
      return action.kind === 'automated'
        ? `Evaluate ${action.gate}${of} (automated: ${action.checks.join(', ') || 'no checks'})\n  run: genie gate ${action.gate}${flag} --run`
        : `Evaluate ${action.gate}${of} with the ${action.evaluator ?? 'configured'} agent\n  then: genie gate ${action.gate}${flag} --verdict pass|fail --by ${action.evaluator ?? '<agent>'} --findings <file>`;
    case 'await_human': {
      const review = action.agentReview
        ? `\n  agent pre-review by ${action.agentReview.by}: ${action.agentReview.verdict}${action.agentReview.note ? ` (${action.agentReview.note})` : ''}`
        : '';
      const pr = slice?.pr ? `\n  PR: ${slice.pr.url}` : '';
      return `Waiting for a human decision on ${action.gate}${of}: ${action.reason}${pr}${review}\n  human: /genie:approve ${action.gate}${flag}  (or --reject)`;
    }
    case 'halted':
      return `Run halted: ${action.reason}`;
    case 'over_budget':
      return `Run paused, over budget: ${action.reason}\n  human: /genie:approve budget to carry on (or /genie:abort)`;
    case 'aborted':
      return 'Run aborted.';
    case 'done':
      return 'Run complete.';
  }
}

export function describeRun(state: RunState, config: Config, action: Action, dir: string, rework: Record<string, Feedback> = {}): string {
  const lines = [`${state.id}  [${state.status}, ${state.mode}]`, `  ${state.title}`, `  ${dir}`, ''];
  for (const stage of STAGES) {
    const ss = state.stages[stage];
    const current = stage === state.stage && state.status === 'active';
    const gates = [...STAGE_DEFS[stage].entryGates, ...STAGE_DEFS[stage].exitGates]
      .map((g) => {
        const gs = state.gates[g];
        const mark = !gateConfig(state, config, g).enabled && gs.status === 'pending' ? 'off' : gs.status;
        return `${g}:${mark}${gs.failures ? `(${gs.failures}✗)` : ''}`;
      })
      .join('  ');
    lines.push(`  ${PHASE_MARK[ss.phase]} ${stage.padEnd(10)} ${(current ? ss.phase : '').padEnd(6)} ${gates}`);
    if (stage === 'implement') lines.push(...describeSlices(state, config, rework));
  }
  const budget = describeBudget(state, config);
  if (budget) lines.push('', `  ${budget}`);
  lines.push('', describeAction(action));
  return lines.join('\n');
}

const SLICE_MARK: Record<SlicePhase, string> = { work: '▶', exit: '▶', pr: '▶', review: '▶', merge: '▶', passed: '✓' };

/**
 * One line per slice under the implement stage: progress and its gates. With a PR per slice, the
 * delivery gates follow on the same line, and the PR on the next. A slice sent back to work says why.
 */
function describeSlices(state: RunState, config: Config, rework: Record<string, Feedback>): string[] {
  return state.slices.flatMap((slice) => {
    const deps = slice.def.depends_on.filter((d) => findSlice(state, d)?.phase !== 'passed');
    const phase = slice.phase === 'passed' ? '' : deps.length > 0 ? `waits:${deps.join(',')}` : slice.phase;
    const gates = [...SLICE_GATES, ...DELIVERY_GATES].flatMap((g) => {
      const gs: GateState | undefined = slice.gates[g];
      if (!gs) return [];
      const mark = !gateConfig(state, config, g).enabled && gs.status === 'pending' ? 'off' : gs.status;
      return [`${g}:${mark}${gs.failures ? `(${gs.failures}✗)` : ''}`];
    }).join('  ');
    const mark = deps.length > 0 ? '·' : SLICE_MARK[slice.phase];
    const line = `      ${mark} ${slice.def.id.padEnd(4)} ${phase.padEnd(10)} ${gates}  ${slice.def.title}`;
    const why = rework[slice.def.id];
    return [
      line,
      ...(slice.pr ? [`             PR ${slice.pr.url}${slice.phase === 'passed' ? ' (merged)' : ''}`] : []),
      ...(why ? [`             reworking after ${describeRework(why)}`] : []),
    ];
  });
}

export function describeChecks(results: CheckResult[]): string {
  return results
    .map((r) =>
      r.status === 'missing'
        ? `  – ${r.check}: not configured`
        : `  ${r.status === 'pass' ? '✓' : '✗'} ${r.check}: ${r.command} (${r.durationMs}ms)${r.status === 'fail' ? `\n      log: ${r.log}` : ''}`,
    )
    .join('\n');
}

const STATUSLINE_TITLE = 24;

/** The compact one-line form `genie statusline` prints; empty once the run is over. */
export function describeStatusline(state: RunState, action: Action): string {
  const title = state.title.length > STATUSLINE_TITLE ? `${state.title.slice(0, STATUSLINE_TITLE - 1)}…` : state.title;
  const slice = 'slice' in action && action.slice ? action.slice.id : undefined;
  const where = `${state.stage}/${state.stages[state.stage].phase}${slice ? ` ${slice}` : ''}`;
  switch (action.type) {
    case 'work':
      return `genie ${title} ▸ ${where} · /genie:next`;
    case 'evaluate':
      return `genie ${title} ▸ ${where} · checking ${action.gate}`;
    case 'await_human':
      return `genie ${title} ▸ ${where} · ⏸ /genie:approve ${action.gate}${slice ? ` --slice ${slice}` : ''}`;
    case 'halted':
      return `genie ${title} ▸ halted: ${action.reason}`;
    case 'over_budget':
      return `genie ${title} ▸ over budget · ⏸ /genie:approve budget`;
    case 'aborted':
    case 'done':
      return '';
  }
}
