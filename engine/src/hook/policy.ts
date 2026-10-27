// Decides whether a tool call may proceed, from the actions it contains and the run's progress.
// Pure: callers supply config, run state, and a branch lookup.
import { describeAction } from '../format.ts';
import { nextAction } from '../engine.ts';
import { STAGES, type StageName } from '../pipeline.ts';
import type { Config } from '../config/types.ts';
import type { RunState } from '../state.ts';
import type { ProtectedAction, PushRefs } from './classify.ts';

export interface Decision {
  decision: 'deny' | 'ask';
  reason: string;
}

export interface Caller {
  /** `claude` for the main session, otherwise the subagent's name without its plugin prefix. */
  identity: string;
  subagent: boolean;
}

export function callerFrom(agentType: string | undefined): Caller {
  if (!agentType) return { identity: 'claude', subagent: false };
  return { identity: stripNamespace(agentType), subagent: true };
}

function stripNamespace(name: string): string {
  return name.slice(name.lastIndexOf(':') + 1);
}

export interface PolicyInput {
  actions: ProtectedAction[];
  caller: Caller;
  /** Undefined when the repo hasn't run `genie init`. */
  config?: Config;
  /** The active (or halted) run, if any. */
  run?: RunState;
  /** Current branch for a push's working directory. */
  currentBranch: (cwd?: string) => string | undefined;
}

/** The stage a run must have reached (entry gates passed) before each outward action is allowed. */
const ACTION_STAGE: Record<'push' | 'pr_create' | 'merge' | 'deploy' | 'release', StageName> = {
  push: 'pr',
  pr_create: 'pr',
  merge: 'merge',
  deploy: 'deploy',
  release: 'release',
};

const LABEL: Record<keyof typeof ACTION_STAGE, string> = {
  push: 'Pushing',
  pr_create: 'Opening a pull request',
  merge: 'Merging',
  deploy: 'Deploying',
  release: 'Releasing (tags, GitHub releases, publishing)',
};

/** Whether `run` is at `stage` with its entry gates passed, or beyond it. */
export function reached(run: RunState, stage: StageName): boolean {
  const at = STAGES.indexOf(run.stage);
  const want = STAGES.indexOf(stage);
  if (run.status === 'done') return true;
  if (at !== want) return at > want;
  return ['work', 'exit', 'passed'].includes(run.stages[stage].phase);
}

/**
 * With a PR per slice, while the run implements: the branches of slices whose PR is being opened.
 * Those may be pushed, and PRs opened, before the run reaches the pr stage.
 */
function slicesOpeningPrs(run: RunState): string[] {
  if (run.delivery !== 'slice' || run.stage !== 'implement' || run.status !== 'active') return [];
  return run.slices.flatMap((s) => (s.phase === 'pr' && s.worktree ? [s.worktree.branch] : []));
}

function touchesBase(refs: PushRefs, base: string, currentBranch: PolicyInput['currentBranch']): boolean {
  if (refs.everything || refs.branches.includes(base)) return true;
  return refs.current && currentBranch(refs.cwd) === base;
}

function decideOne(action: ProtectedAction, input: PolicyInput): Decision | undefined {
  const { caller, config, run } = input;
  switch (action.kind) {
    case 'approve':
      return {
        decision: 'deny',
        reason:
          'genie: human gates can only be approved by the user. Ask them to run `/genie:approve <gate>` (or `--reject`).',
      };
    case 'abort':
      return {
        decision: 'deny',
        reason: 'genie: aborting a run is the user\'s decision. Ask them to run `/genie:abort` (optionally with `--note "why"`).',
      };
    case 'state_write':
      return {
        decision: 'deny',
        reason: `genie: ${action.path} is engine-owned run state. Change it only through the genie CLI (done, gate, approve, abort).`,
      };
    case 'key_access':
      return {
        decision: 'deny',
        reason: `genie: ${action.path} is the key that seals run state. Nothing in a session needs to read or change it.`,
      };
    case 'config_write':
      if (!config) return undefined;
      return {
        decision: 'ask',
        reason: `genie: editing ${action.path} changes which gates apply${run ? ` to the active run ${run.id}` : ''}.`,
      };
    case 'record': {
      const by = action.by ?? (action.subcommand === 'done' ? 'claude' : undefined);
      if (by === undefined || stripNamespace(by) === caller.identity) return undefined;
      return {
        decision: 'deny',
        reason:
          action.subcommand === 'gate'
            ? `genie: a gate verdict for --by ${by} must be recorded by the ${by} subagent itself (you are ${caller.identity}).`
            : `genie: work must be marked done by whoever did it: pass --by ${caller.identity}, not ${by}.`,
      };
    }
    default:
      return decideOutward(action, input);
  }
}

function decideOutward(
  action: Extract<ProtectedAction, { kind: keyof typeof ACTION_STAGE }>,
  input: PolicyInput,
): Decision | undefined {
  const { config, run } = input;
  if (!config) return undefined;

  if (action.kind === 'push' && config.enforcement.protect_base_branch) {
    const base = config.forge.base_branch;
    if (touchesBase(action.refs, base, input.currentBranch)) {
      return {
        decision: 'deny',
        reason: `genie: pushing to ${base} is not allowed. Push a branch and land it through a pull request.`,
      };
    }
  }
  if (!config.enforcement.enabled) return undefined;

  const stage = ACTION_STAGE[action.kind];
  if (!run) {
    return config.enforcement.outside_run === 'deny'
      ? { decision: 'deny', reason: `genie: ${LABEL[action.kind].toLowerCase()} requires an active run (enforcement.outside_run: deny).` }
      : undefined;
  }
  if (run.status === 'halted') {
    return { decision: 'deny', reason: `genie: run ${run.id} is halted (${run.haltReason ?? 'no reason recorded'}).` };
  }
  if (!config.stages[stage].enabled) {
    return { decision: 'deny', reason: `genie: ${LABEL[action.kind]} is disabled for this repo (stages.${stage}.enabled: false).` };
  }
  if (reached(run, stage)) return undefined;
  const opening = slicesOpeningPrs(run);
  if (opening.length > 0 && action.kind === 'pr_create') return undefined;
  if (opening.length > 0 && action.kind === 'push') {
    const { refs } = action;
    const pushed = [...refs.branches, ...(refs.current ? [input.currentBranch(refs.cwd) ?? 'HEAD'] : [])];
    if (!refs.everything && !refs.tags && pushed.length > 0 && pushed.every((b) => opening.includes(b))) return undefined;
    return {
      decision: 'deny',
      reason: `genie: while run ${run.id} implements, only the branches of slices whose PR is being opened may be pushed (${opening.join(', ')}).`,
    };
  }
  const next = describeAction(nextAction(run, config)).replace(/\n\s*/g, ' ');
  return {
    decision: 'deny',
    reason: `genie: ${LABEL[action.kind]} isn't allowed until run ${run.id} reaches the ${stage} stage (it is at ${run.stage}/${run.stages[run.stage].phase}). Next: ${next}`,
  };
}

/** The strictest decision across all actions in the call: any deny wins over ask. */
export function decide(input: PolicyInput): Decision | undefined {
  let ask: Decision | undefined;
  for (const action of input.actions) {
    const d = decideOne(action, input);
    if (d?.decision === 'deny') return d;
    ask ??= d;
  }
  return ask;
}
