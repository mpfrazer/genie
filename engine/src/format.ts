import type { Action } from './engine.ts';
import { STAGE_DEFS, STAGES } from './pipeline.ts';
import type { Config } from './config/types.ts';
import type { RunState, StagePhase } from './state.ts';
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
  switch (action.type) {
    case 'work':
      return `Work on ${action.stage}${action.agent ? ` (${action.agent} subagent)` : ''}: ${action.instructions}${action.artifact ? ` (write ${action.artifact})` : ''}\n  then: genie done ${action.stage}${action.agent ? ` --by ${action.agent}` : ''}`;
    case 'evaluate':
      return action.kind === 'automated'
        ? `Evaluate ${action.gate} (automated: ${action.checks.join(', ') || 'no checks'})\n  run: genie gate ${action.gate} --run`
        : `Evaluate ${action.gate} with the ${action.evaluator ?? 'configured'} agent\n  then: genie gate ${action.gate} --verdict pass|fail --by ${action.evaluator ?? '<agent>'} [--findings <file>]`;
    case 'await_human': {
      const review = action.agentReview
        ? `\n  agent pre-review by ${action.agentReview.by}: ${action.agentReview.verdict}${action.agentReview.note ? ` (${action.agentReview.note})` : ''}`
        : '';
      return `Waiting for a human decision on ${action.gate}: ${action.reason}${review}\n  human: /genie:approve ${action.gate}  (or --reject)`;
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
  }
  lines.push('', describeAction(action));
  return lines.join('\n');
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
