import type { Action } from './engine.ts';
import { SLICE_GATES, STAGE_DEFS, STAGES } from './pipeline.ts';
import type { Config } from './config/types.ts';
import { findSlice, type RunState, type SlicePhase, type StagePhase } from './state.ts';
import type { CheckResult } from './checks.ts';

const PHASE_MARK: Record<StagePhase, string> = {
  pending: '·',
  entry: '▶',
  work: '▶',
  exit: '▶',
  passed: '✓',
  skipped: '–',
};

/** One line telling the reader what happens next, including the command to run. */
export function describeAction(action: Action): string {
  const slice = 'slice' in action && action.slice ? action.slice : undefined;
  const of = slice ? ` slice ${slice.id} (${slice.title})` : '';
  const flag = slice ? ` --slice ${slice.id}` : '';
  switch (action.type) {
    case 'work': {
      const what = slice ? slice.goal : action.instructions;
      return `Work on ${action.stage}${of}${action.agent ? ` (${action.agent} subagent)` : ''}: ${what}${action.artifact ? ` (write ${action.artifact})` : ''}\n  then: genie done ${action.stage}${flag}${action.agent ? ` --by ${action.agent}` : ''}`;
    }
    case 'evaluate':
      return action.kind === 'automated'
        ? `Evaluate ${action.gate}${of} (automated: ${action.checks.join(', ') || 'no checks'})\n  run: genie gate ${action.gate}${flag} --run`
        : `Evaluate ${action.gate}${of} with the ${action.evaluator ?? 'configured'} agent\n  then: genie gate ${action.gate}${flag} --verdict pass|fail --by ${action.evaluator ?? '<agent>'} [--findings <file>]`;
    case 'await_human': {
      const review = action.agentReview
        ? `\n  agent pre-review by ${action.agentReview.by}: ${action.agentReview.verdict}${action.agentReview.note ? ` (${action.agentReview.note})` : ''}`
        : '';
      return `Waiting for a human decision on ${action.gate}${of}: ${action.reason}${review}\n  human: /genie:approve ${action.gate}${flag}  (or --reject)`;
    }
    case 'halted':
      return `Run halted: ${action.reason}`;
    case 'aborted':
      return 'Run aborted.';
    case 'done':
      return 'Run complete.';
  }
}

export function describeRun(state: RunState, config: Config, action: Action, dir: string): string {
  const lines = [`${state.id}  [${state.status}, ${state.mode}]`, `  ${state.title}`, `  ${dir}`, ''];
  for (const stage of STAGES) {
    const ss = state.stages[stage];
    const current = stage === state.stage && state.status === 'active';
    const gates = [...STAGE_DEFS[stage].entryGates, ...STAGE_DEFS[stage].exitGates]
      .map((g) => {
        const gs = state.gates[g];
        const mark = !config.gates[g].enabled && gs.status === 'pending' ? 'off' : gs.status;
        return `${g}:${mark}${gs.failures ? `(${gs.failures}✗)` : ''}`;
      })
      .join('  ');
    lines.push(`  ${PHASE_MARK[ss.phase]} ${stage.padEnd(10)} ${(current ? ss.phase : '').padEnd(6)} ${gates}`);
    if (stage === 'implement') lines.push(...describeSlices(state, config));
  }
  lines.push('', describeAction(action));
  return lines.join('\n');
}

const SLICE_MARK: Record<SlicePhase, string> = { work: '▶', exit: '▶', passed: '✓' };

/** One line per slice under the implement stage: progress and its gates. */
function describeSlices(state: RunState, config: Config): string[] {
  return state.slices.map((slice) => {
    const deps = slice.def.depends_on.filter((d) => findSlice(state, d)?.phase !== 'passed');
    const phase = slice.phase === 'passed' ? '' : deps.length > 0 ? `waits:${deps.join(',')}` : slice.phase;
    const gates = SLICE_GATES.map((g) => {
      const gs = slice.gates[g];
      const mark = !config.gates[g].enabled && gs.status === 'pending' ? 'off' : gs.status;
      return `${g}:${mark}${gs.failures ? `(${gs.failures}✗)` : ''}`;
    }).join('  ');
    const mark = deps.length > 0 ? '·' : SLICE_MARK[slice.phase];
    return `      ${mark} ${slice.def.id.padEnd(4)} ${phase.padEnd(10)} ${gates}  ${slice.def.title}`;
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
  const where = `${state.stage}/${state.stages[state.stage].phase}`;
  switch (action.type) {
    case 'work':
      return `genie ${title} ▸ ${where} · /genie:next`;
    case 'evaluate':
      return `genie ${title} ▸ ${where} · checking ${action.gate}`;
    case 'await_human':
      return `genie ${title} ▸ ${where} · ⏸ /genie:approve ${action.gate}`;
    case 'halted':
      return `genie ${title} ▸ halted: ${action.reason}`;
    case 'aborted':
    case 'done':
      return '';
  }
}
