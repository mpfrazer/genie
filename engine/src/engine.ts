// The deterministic core: pure transitions over RunState. No I/O; every change emits a log event.
import { GenieError } from './errors.ts';
import {
  DELIVERY_GATES,
  GATE_DEFS,
  SLICE_GATES,
  STAGE_DEFS,
  STAGES,
  isDeliveryGate,
  isSliceGate,
  stageOfGate,
  type DeliveryGateName,
  type GateName,
  type RunGateName,
  type SliceGateName,
  type StageDef,
  type StageName,
} from './pipeline.ts';
import type { Config, GateConfig, GateKind } from './config/types.ts';
import type { PlanSlice } from './plan.ts';
import { findSlice, newSliceState, sliceGate, type GateState, type RunState, type SliceState, type Verdict } from './state.ts';
import type { LogEvent, LogEventBody } from './store.ts';

export interface Ctx {
  now: string;
  events: LogEvent[];
}

export type VerdictSource = 'automated' | 'agent' | 'human';

/** The slice an action applies to, as planned, with its PR once it has one. */
export type SliceInfo = PlanSlice & { fixes?: RunGateName; pr?: SliceState['pr'] };

/** A gate evaluated once per slice: the slice gates, and with a PR per slice, the delivery gates. */
export type PerSliceGate = SliceGateName | DeliveryGateName;

export type Action =
  | { type: 'work'; stage: StageName; instructions: string; artifact?: string; skill?: string; agent?: string; slice?: SliceInfo }
  | { type: 'evaluate'; gate: GateName; kind: 'automated'; checks: string[]; slice?: SliceInfo }
  | { type: 'evaluate'; gate: GateName; kind: 'agent' | 'agent+human'; evaluator?: string; slice?: SliceInfo }
  | { type: 'await_human'; gate: GateName; reason: string; agentReview?: GateState['agentReview']; slice?: SliceInfo }
  | { type: 'halted'; reason: string }
  | { type: 'over_budget'; reason: string }
  | { type: 'aborted' }
  | { type: 'done' };

export interface VerdictInput {
  gate: GateName;
  /** Required for slice gates when more than one slice awaits the gate. */
  slice?: string;
  verdict: Verdict;
  source: VerdictSource;
  by: string;
  note?: string;
  evidence?: string[];
  /** For human verdicts: the grant (grants.ts) the user's typed command carried. */
  grant?: string;
}

export interface WorkOptions {
  /** The slice whose work is done (implement stage). Inferred when only one slice is ready. */
  slice?: string;
  /** The validated plan, recorded when the decompose stage's work is done. */
  plan?: PlanSlice[];
  /** With a PR per slice: the pull request opened for the slice (`done pr --slice`). */
  pr?: { number: number; url: string };
}

function emit(state: RunState, ctx: Ctx, event: LogEventBody): void {
  ctx.events.push({ ts: ctx.now, run: state.id, ...event });
}

function touch(state: RunState, ctx: Ctx): void {
  state.updatedAt = ctx.now;
}

/** A gate's configuration for this run: orchestrated runs apply the gate's `orchestrated` overrides. */
export function gateConfig(state: RunState, config: Config, gate: GateName): GateConfig {
  const { orchestrated, ...base } = config.gates[gate];
  return state.mode === 'orchestrated' && orchestrated ? { ...base, ...orchestrated } : base;
}

/**
 * A stage as this run does it. With a PR per slice, every slice's PR has been checked, approved,
 * and merged by the end of implement: integrate only brings the main checkout up to date with the
 * base branch, and the pr stage only holds the final intent review over everything that merged.
 */
export function stageDef(state: RunState, stage: StageName): StageDef {
  const def = STAGE_DEFS[stage];
  if (state.delivery !== 'slice') return def;
  if (stage === 'integrate') {
    return { ...def, onRunBranch: false, instructions: `Every slice has merged into ${state.base}: bring the main checkout up to date with it.` };
  }
  if (stage === 'pr') return { ...def, hasWork: false, instructions: 'Review everything the run merged against the original intent.' };
  return def;
}

/** Where a slice's work lands: the run branch, or with a PR per slice, the base branch. */
export function landsOn(state: RunState): string {
  return state.delivery === 'slice' ? state.base : state.branch;
}

/** Whether a verdict on `gate` is for a slice: always for slice gates, and for the delivery gates while a run with a PR per slice is implementing. */
export function isPerSliceGate(state: RunState, gate: GateName): gate is PerSliceGate {
  return isSliceGate(gate) || (state.delivery === 'slice' && state.stage === 'implement' && isDeliveryGate(gate));
}

function isResolved(gs: GateState, gc: GateConfig): boolean {
  return gs.status === 'pass' || gs.status === 'skipped' || (gs.status === 'fail' && !gc.blocking);
}

/** Skips disabled gates in `gates`, then returns the first one still needing a verdict. */
function resolveGates<G extends GateName>(
  state: RunState,
  config: Config,
  gates: readonly G[],
  gateState: (g: G) => GateState,
  ctx: Ctx,
  slice?: string,
): G | undefined {
  for (const gate of gates) {
    const gs = gateState(gate);
    const gc = gateConfig(state, config, gate);
    if (gs.status === 'pending' && !gc.enabled) {
      gs.status = 'skipped';
      emit(state, ctx, { type: 'gate.skipped', gate, ...(slice ? { slice } : {}), note: 'disabled by config' });
    }
    if (!isResolved(gs, gc)) return gate;
  }
  return undefined;
}

function gatesInPhase(state: RunState): RunGateName[] {
  const def = stageDef(state, state.stage);
  const phase = state.stages[state.stage].phase;
  if (phase === 'entry') return def.entryGates;
  if (phase === 'exit') return def.exitGates;
  return [];
}

function sliceReady(state: RunState, slice: SliceState): boolean {
  return slice.def.depends_on.every((dep) => findSlice(state, dep)?.phase === 'passed');
}

/**
 * Passes every slice whose gates have all resolved, or queues it to merge when it has its own
 * branch. With a PR per slice, a slice that passes its gates needs its PR opened next, and one
 * whose PR passes the delivery gates is queued to merge. Returns true once all slices have passed.
 */
function advanceSlices(state: RunState, config: Config, ctx: Ctx): boolean {
  for (const slice of state.slices) {
    const id = slice.def.id;
    if (slice.phase === 'review') {
      if (resolveGates(state, config, DELIVERY_GATES, (g) => sliceGate(slice, g), ctx, id)) continue;
      slice.phase = 'merge';
      emit(state, ctx, { type: 'slice.merging', stage: 'implement', slice: id, note: slice.pr?.url });
      continue;
    }
    if (slice.phase !== 'exit') continue;
    if (resolveGates(state, config, SLICE_GATES, (g) => slice.gates[g], ctx, id)) continue;
    if (state.delivery === 'slice') {
      slice.phase = 'pr';
      emit(state, ctx, { type: 'slice.pr_due', stage: 'implement', slice: id });
      continue;
    }
    if (slice.worktree) {
      slice.phase = 'merge';
      emit(state, ctx, { type: 'slice.merging', stage: 'implement', slice: slice.def.id });
      continue;
    }
    slice.phase = 'passed';
    emit(state, ctx, { type: 'slice.passed', stage: 'implement', slice: slice.def.id });
  }
  return state.slices.length > 0 && state.slices.every((s) => s.phase === 'passed');
}

/** Applies every transition that needs no outside input, stopping at work or a gate verdict. */
export function advance(state: RunState, config: Config, ctx: Ctx): void {
  while (state.status === 'active') {
    const stage = state.stage;
    const def = stageDef(state, stage);
    const ss = state.stages[stage];

    switch (ss.phase) {
      case 'pending': {
        // With a PR per slice, each slice's PR was approved and merged on its own: there's no run PR.
        const merged = state.delivery === 'slice' && stage === 'merge';
        if (!config.stages[stage].enabled || merged) {
          ss.phase = 'skipped';
          for (const gate of [...def.entryGates, ...def.exitGates]) state.gates[gate].status = 'skipped';
          emit(state, ctx, { type: 'stage.skipped', stage, note: merged ? 'each slice merged through its own PR' : 'disabled by config' });
        } else {
          ss.phase = 'entry';
          emit(state, ctx, { type: 'stage.started', stage });
          if (state.delivery === 'slice' && stage === 'pr' && state.gates['pr.ready'].status === 'pending') {
            state.gates['pr.ready'].status = 'skipped';
            emit(state, ctx, { type: 'gate.skipped', gate: 'pr.ready', note: "checked on each slice's PR" });
          }
        }
        break;
      }
      case 'entry':
        if (resolveGates(state, config, def.entryGates, (g) => state.gates[g], ctx)) return;
        ss.phase = def.hasWork ? 'work' : 'exit';
        break;
      case 'work':
        // The implement stage's work is its slices: it finishes when the last one passes.
        if (stage !== 'implement' || !advanceSlices(state, config, ctx)) return;
        ss.phase = 'exit';
        break;
      case 'exit':
        if (resolveGates(state, config, def.exitGates, (g) => state.gates[g], ctx)) return;
        ss.phase = 'passed';
        emit(state, ctx, { type: 'stage.passed', stage });
        break;
      case 'passed':
      case 'skipped': {
        const next = STAGES[STAGES.indexOf(stage) + 1];
        if (next) {
          state.stage = next;
        } else {
          state.status = 'done';
          emit(state, ctx, { type: 'run.done' });
        }
        break;
      }
    }
    touch(state, ctx);
  }
}

/** The run-level gate awaiting a verdict, if the run is currently at one. Call after `advance`. */
export function currentGate(state: RunState, config: Config): RunGateName | undefined {
  if (state.status !== 'active') return undefined;
  return gatesInPhase(state).find((g) => !isResolved(state.gates[g], gateConfig(state, config, g)));
}

/**
 * The gate awaiting a verdict for `slice`: one of its slice gates once its work is done, or with a
 * PR per slice, one of the delivery gates once its PR is open.
 */
export function currentSliceGate(state: RunState, config: Config, slice: SliceState): PerSliceGate | undefined {
  if (state.status !== 'active' || state.stage !== 'implement') return undefined;
  const gates: readonly PerSliceGate[] | undefined = slice.phase === 'exit' ? SLICE_GATES : slice.phase === 'review' ? DELIVERY_GATES : undefined;
  return gates?.find((g) => !isResolved(sliceGate(slice, g), gateConfig(state, config, g)));
}

function sliceInfo(slice: SliceState): SliceInfo {
  return { ...slice.def, ...(slice.fixes ? { fixes: slice.fixes } : {}), ...(slice.pr ? { pr: slice.pr } : {}) };
}

function gateAction(gate: GateName, gs: GateState, gc: GateConfig, slice?: SliceInfo): Action {
  const s = slice ? { slice } : {};
  if (gs.status === 'needs_human') {
    return { type: 'await_human', gate, reason: 'escalated: automatic evaluation could not decide', ...s };
  }
  switch (gc.kind) {
    case 'automated':
      return { type: 'evaluate', gate, kind: 'automated', checks: gc.checks ?? [], ...s };
    case 'agent':
      return { type: 'evaluate', gate, kind: 'agent', evaluator: gc.evaluator, ...s };
    case 'human':
      return { type: 'await_human', gate, reason: GATE_DEFS[gate].description, ...s };
    case 'agent+human':
      return gs.agentReview
        ? { type: 'await_human', gate, reason: GATE_DEFS[gate].description, agentReview: gs.agentReview, ...s }
        : { type: 'evaluate', gate, kind: 'agent+human', evaluator: gc.evaluator, ...s };
  }
}

function sliceAction(state: RunState, config: Config, slice: SliceState): Action | undefined {
  if (slice.phase === 'work') {
    if (!sliceReady(state, slice)) return undefined;
    const def = STAGE_DEFS.implement;
    return { type: 'work', stage: 'implement', instructions: def.instructions, skill: def.skill, agent: def.agent, slice: sliceInfo(slice) };
  }
  if (slice.phase === 'pr') {
    const instructions = `Push this slice's branch and open (or update) its pull request into ${state.base}.`;
    return { type: 'work', stage: 'pr', instructions, skill: STAGE_DEFS.pr.skill, slice: sliceInfo(slice) };
  }
  const gate = currentSliceGate(state, config, slice);
  return gate ? gateAction(gate, sliceGate(slice, gate), gateConfig(state, config, gate), sliceInfo(slice)) : undefined;
}

/**
 * Everything that can be acted on right now, in plan order. Outside the implement stage that is
 * exactly one action. Inside it, there is one per slice that is ready: its dependencies have passed
 * and it has work to do or a gate awaiting a verdict. Guided mode takes the first; an orchestrator
 * can run them concurrently.
 */
export function nextActions(state: RunState, config: Config): Action[] {
  if (state.status === 'done') return [{ type: 'done' }];
  if (state.status === 'aborted') return [{ type: 'aborted' }];
  if (state.status === 'halted') return [{ type: 'halted', reason: state.haltReason ?? 'halted' }];
  // Work already under way can still report back, but nothing new starts until a human extends the budget.
  if (state.budget?.exceeded) return [{ type: 'over_budget', reason: state.budget.exceeded }];

  const stage = state.stage;
  if (state.stages[stage].phase === 'work') {
    if (stage === 'implement' && state.slices.length > 0) {
      const actions = state.slices.flatMap((s) => sliceAction(state, config, s) ?? []);
      if (actions.length > 0) return actions;
      const merging = state.slices.filter((s) => s.phase === 'merge').map((s) => s.def.id);
      if (merging.length > 0) {
        // Merges are settled after every mutation; this is only reached when one couldn't run.
        throw new GenieError(`slice ${merging.join(', ')} is waiting to merge onto ${landsOn(state)}; see the error above`);
      }
      throw new Error(`run ${state.id}: no slice is actionable; call advance() first`);
    }
    const def = stageDef(state, stage);
    return [{ type: 'work', stage, instructions: def.instructions, artifact: def.artifact, skill: def.skill, agent: def.agent }];
  }

  const gate = currentGate(state, config);
  if (!gate) throw new Error(`run ${state.id} is at ${stage} with nothing to do; call advance() first`);
  return [gateAction(gate, state.gates[gate], gateConfig(state, config, gate))];
}

/** The single next action: the first of `nextActions`. */
export function nextAction(state: RunState, config: Config): Action {
  return nextActions(state, config)[0]!;
}

/** Marks work complete: a stage's (moving it to its exit gates) or, in implement, one slice's. */
export function completeWork(
  state: RunState,
  config: Config,
  stage: StageName,
  by: string,
  artifactExists: (relPath: string) => boolean,
  ctx: Ctx,
  opts: WorkOptions = {},
): void {
  requireActive(state);
  if (stage === 'pr' && state.delivery === 'slice' && state.stage === 'implement') {
    completeSlicePr(state, config, by, opts.slice, opts.pr, ctx);
    return;
  }
  if (state.stage !== stage || state.stages[stage].phase !== 'work') {
    throw new GenieError(`stage ${stage} is not in progress (run is at ${state.stage}/${state.stages[state.stage].phase})`);
  }
  if (stage === 'implement') {
    completeSlice(state, config, by, opts.slice, ctx);
    return;
  }
  const artifact = STAGE_DEFS[stage].artifact;
  if (artifact && !artifactExists(artifact)) {
    throw new GenieError(`stage ${stage} requires ${artifact} in the run directory`);
  }
  if (stage === 'decompose') {
    if (!opts.plan || opts.plan.length === 0) throw new GenieError('stage decompose requires a validated plan');
    state.slices = opts.plan.map((def) => newSliceState(def));
    emit(state, ctx, { type: 'plan.recorded', stage, note: state.slices.map((s) => s.def.id).join(', ') });
  }
  state.stages[stage].author = by;
  state.stages[stage].phase = 'exit';
  emit(state, ctx, { type: 'stage.work_done', stage, by });
  touch(state, ctx);
  advance(state, config, ctx);
}

function completeSlice(state: RunState, config: Config, by: string, sliceId: string | undefined, ctx: Ctx): void {
  if (state.slices.length === 0) {
    throw new GenieError('the implement stage has no slices: the plan was never recorded (redo decompose)');
  }
  const ready = state.slices.filter((s) => s.phase === 'work' && sliceReady(state, s)).map((s) => s.def.id);
  const id = sliceId ?? (ready.length === 1 ? ready[0] : undefined);
  if (!id) {
    throw new GenieError(`pass --slice <id> to say which slice is done (ready: ${ready.join(', ') || 'none'})`);
  }
  const slice = findSlice(state, id);
  if (!slice) throw new GenieError(`unknown slice ${id} (slices: ${state.slices.map((s) => s.def.id).join(', ')})`);
  if (slice.phase !== 'work') throw new GenieError(`slice ${id} is not in progress (it is ${slice.phase})`);
  if (!sliceReady(state, slice)) {
    const waiting = slice.def.depends_on.filter((dep) => findSlice(state, dep)?.phase !== 'passed');
    throw new GenieError(`slice ${id} depends on ${waiting.join(', ')}, which ${waiting.length === 1 ? "hasn't" : "haven't"} passed yet`);
  }
  slice.author = by;
  slice.iterations = (slice.iterations ?? 0) + 1;
  slice.phase = 'exit';
  emit(state, ctx, { type: 'slice.work_done', stage: 'implement', slice: id, by });
  touch(state, ctx);
  advance(state, config, ctx);
}

/** With a PR per slice: the slice's PR is open, so its delivery gates can run. */
function completeSlicePr(
  state: RunState,
  config: Config,
  by: string,
  sliceId: string | undefined,
  pr: WorkOptions['pr'],
  ctx: Ctx,
): void {
  const waiting = state.slices.filter((s) => s.phase === 'pr').map((s) => s.def.id);
  const id = sliceId ?? (waiting.length === 1 ? waiting[0] : undefined);
  if (!id) throw new GenieError(`pass --slice <id> to say whose PR is open (waiting for a PR: ${waiting.join(', ') || 'none'})`);
  const slice = findSlice(state, id);
  if (!slice) throw new GenieError(`unknown slice ${id} (slices: ${state.slices.map((s) => s.def.id).join(', ')})`);
  if (slice.phase !== 'pr') throw new GenieError(`slice ${id} isn't waiting for its pull request (it is ${slice.phase})`);
  if (!pr) throw new GenieError(`slice ${id} needs its pull request opened first`);
  slice.pr = pr;
  slice.phase = 'review';
  emit(state, ctx, { type: 'slice.pr', stage: 'implement', slice: id, by, note: pr.url });
  touch(state, ctx);
  advance(state, config, ctx);
}

const SOURCE_FOR_KIND: Record<GateKind, VerdictSource[]> = {
  automated: ['automated'],
  agent: ['agent'],
  human: ['human'],
  'agent+human': ['agent', 'human'],
};

/** The slice a slice-gate verdict is for: as given, or the only slice awaiting that gate. */
export function resolveVerdictSlice(state: RunState, config: Config, gate: PerSliceGate, sliceId?: string): SliceState {
  if (sliceId) {
    const slice = findSlice(state, sliceId);
    if (!slice) throw new GenieError(`unknown slice ${sliceId} (slices: ${state.slices.map((s) => s.def.id).join(', ') || 'none'})`);
    const current = currentSliceGate(state, config, slice);
    if (current !== gate) {
      throw new GenieError(`gate ${gate} is not awaiting a verdict for slice ${sliceId} (current: ${current ?? 'none'})`);
    }
    return slice;
  }
  const awaiting = state.slices.filter((s) => currentSliceGate(state, config, s) === gate);
  if (awaiting.length === 1) return awaiting[0]!;
  throw new GenieError(
    awaiting.length === 0
      ? `gate ${gate} is not awaiting a verdict for any slice`
      : `pass --slice <id>: ${gate} is awaiting verdicts for ${awaiting.map((s) => s.def.id).join(', ')}`,
  );
}

type Outcome = 'pass' | 'needs_human' | 'advisory' | 'rework' | 'escalated' | 'halt';

/** The rules every verdict follows, whether the gate belongs to the run or to a slice. */
function judge(gs: GateState, gc: GateConfig, input: VerdictInput, author: string | undefined, where: string): Outcome | 'review' {
  const { gate, source, by, verdict } = input;
  // Invariants: nothing but a human resolves a human decision, and authors don't grade their own work.
  if (gs.status === 'needs_human' && source !== 'human') {
    throw new GenieError(`gate ${gate} was escalated and needs a human decision`);
  }
  if (gs.status !== 'needs_human' && !SOURCE_FOR_KIND[gc.kind].includes(source)) {
    throw new GenieError(`gate ${gate} is a ${gc.kind} gate and cannot take a verdict from ${source}`);
  }
  if (source === 'agent' && author && author === by) {
    throw new GenieError(`${by} authored ${where} and cannot evaluate ${gate}`);
  }
  gs.attempts += 1;
  if (gc.kind === 'agent+human' && source === 'agent') {
    gs.agentReview = { verdict, by, note: input.note };
    return 'review';
  }
  if (verdict === 'pass') {
    gs.status = 'pass';
    return 'pass';
  }
  if (verdict === 'needs_human') {
    gs.status = 'needs_human';
    return 'needs_human';
  }
  if (source === 'human') {
    // A human rejection sends the work back with a fresh automatic budget.
    gs.failures = 0;
    return 'rework';
  }
  if (!gc.blocking) {
    gs.status = 'fail';
    return 'advisory';
  }
  gs.failures += 1;
  if (gs.failures <= gc.retries) return 'rework';
  if (gc.escalate_to === 'human') {
    gs.status = 'needs_human';
    return 'escalated';
  }
  return 'halt';
}

export function recordVerdict(state: RunState, config: Config, input: VerdictInput, ctx: Ctx): void {
  requireActive(state);
  const { gate, verdict, source, by } = input;
  const gc = gateConfig(state, config, gate);

  let gs: GateState;
  let slice: SliceState | undefined;
  if (isPerSliceGate(state, gate)) {
    slice = resolveVerdictSlice(state, config, gate, input.slice);
    gs = sliceGate(slice, gate);
  } else {
    const current = currentGate(state, config);
    if (current !== gate) {
      throw new GenieError(`gate ${gate} is not awaiting a verdict (current: ${current ?? 'none'})`);
    }
    gs = state.gates[gate];
  }
  const sliceId = slice?.def.id;
  const author = slice ? slice.author : state.stages[stageOfGate(gate)].author;
  let outcome = judge(gs, gc, input, author, slice ? `slice ${sliceId}` : `stage ${stageOfGate(gate)}`);
  // Orchestrated runs cap the rounds of work per slice: past the cap, a failure asks a human instead.
  const cap = config.budgets.max_iterations_per_slice;
  const capped = outcome === 'rework' && slice && source !== 'human' && state.mode === 'orchestrated' && (slice.iterations ?? 0) >= cap;
  if (capped) {
    gs.status = 'needs_human';
    outcome = 'escalated';
  }
  // A human rejection is a fresh start for the slice, as it is for the gate's retries.
  if (outcome === 'rework' && slice && source === 'human') slice.iterations = 0;

  const logged = {
    gate,
    ...(sliceId ? { slice: sliceId } : {}),
    verdict,
    by,
    attempt: gs.attempts,
    note: input.note,
    evidence: input.evidence,
    ...(input.grant ? { grant: input.grant } : {}),
    source,
    gateConfig: gc,
  };
  if (outcome === 'review') {
    emit(state, ctx, { type: 'gate.agent_review', ...logged });
    touch(state, ctx);
    return;
  }
  emit(state, ctx, { type: 'gate.verdict', ...logged });
  touch(state, ctx);

  if (outcome === 'rework') {
    if (slice) reworkSlice(state, slice, gate, ctx);
    else rework(state, gate as RunGateName, ctx);
  } else if (outcome === 'escalated') {
    emit(state, ctx, {
      type: 'gate.escalated',
      gate,
      ...(sliceId ? { slice: sliceId } : {}),
      note: capped
        ? `slice ${sliceId} used its budget of ${cap} rounds of work (budgets.max_iterations_per_slice)`
        : `failed ${gs.failures} times (retries: ${gc.retries})`,
    });
  } else if (outcome === 'halt') {
    halt(state, `${gate}${sliceId ? ` (slice ${sliceId})` : ''} failed ${gs.failures} times`, ctx);
  }
  advance(state, config, ctx);
}

/** Sends one slice back to work: its gates reset (keeping their attempt and failure counts). */
function reworkSlice(state: RunState, slice: SliceState, gate: GateName, ctx: Ctx): void {
  resetSlice(slice);
  emit(state, ctx, { type: 'slice.rework', stage: 'implement', slice: slice.def.id, gate });
  touch(state, ctx);
}

/** Back to work, every gate pending again: with a PR per slice, its PR is checked and approved again too. */
function resetSlice(slice: SliceState): void {
  slice.phase = 'work';
  for (const gs of Object.values(slice.gates)) {
    gs.status = 'pending';
    delete gs.agentReview;
  }
}

function mergingSlice(state: RunState, id: string): SliceState {
  requireActive(state);
  const slice = findSlice(state, id);
  if (!slice) throw new GenieError(`unknown slice ${id}`);
  if (slice.phase !== 'merge') throw new GenieError(`slice ${id} is not waiting to merge (it is ${slice.phase})`);
  return slice;
}

/** Records that a slice's branch landed on the run branch (or its PR merged into the base), passing the slice. */
export function sliceMerged(state: RunState, config: Config, id: string, commit: string, ctx: Ctx): void {
  const slice = mergingSlice(state, id);
  slice.phase = 'passed';
  slice.merged = commit;
  emit(state, ctx, { type: 'slice.merged', stage: 'implement', slice: id, note: commit });
  emit(state, ctx, { type: 'slice.passed', stage: 'implement', slice: id });
  touch(state, ctx);
  advance(state, config, ctx);
}

/**
 * A slice's branch conflicts with where it lands (another slice landed first). It goes back to
 * work to resolve the conflict, and its gates run again on the result.
 */
export function sliceConflict(state: RunState, id: string, files: string[], ctx: Ctx): void {
  const slice = mergingSlice(state, id);
  resetSlice(slice);
  emit(state, ctx, {
    type: 'slice.rework',
    stage: 'implement',
    slice: id,
    note: `merge conflict onto ${landsOn(state)}${files.length > 0 ? ` in ${files.join(', ')}` : ''}`,
    conflict: files,
  });
  touch(state, ctx);
}

/** A slice appended when a run-level gate sends the run back to implement. */
function addFixupSlice(state: RunState, gate: RunGateName, ctx: Ctx): void {
  const n = state.slices.filter((s) => s.fixes).length + 1;
  const id = `F${n}`;
  const slice = newSliceState(
    {
      id,
      title: `Fix: ${gate} failed`,
      goal: `Address the ${gate} failure (see feedback) without regressing the slices already done.`,
      covers: [],
      tests: [`A test that fails before the fix and passes after it, where the failure allows one`],
      depends_on: [],
    },
    gate,
    state.delivery,
  );
  state.slices.push(slice);
  emit(state, ctx, { type: 'slice.rework', stage: 'implement', slice: id, gate, note: 'fix-up slice added' });
}

/**
 * Where a failed run-level gate sends the run. With a PR per slice, what the final intent review
 * finds has already merged, so a fix-up slice fixes it, through a PR of its own.
 */
function reworkTarget(state: RunState, gate: RunGateName): StageName | 'halt' {
  if (state.delivery === 'slice' && gate === 'intent.reviewed') return 'implement';
  return GATE_DEFS[gate].onFail;
}

/** Routes a failed run-level gate back to the stage that should redo the work. */
function rework(state: RunState, gate: RunGateName, ctx: Ctx): void {
  const target = reworkTarget(state, gate);
  if (target === 'halt') {
    halt(state, `${gate} failed`, ctx);
    return;
  }
  const from = STAGES.indexOf(target);
  const to = STAGES.indexOf(state.stage);
  for (let i = from; i <= to; i++) {
    const stage = STAGES[i]!;
    const def = STAGE_DEFS[stage];
    const resetGates = i === from ? def.exitGates : [...def.entryGates, ...def.exitGates];
    for (const g of resetGates) {
      state.gates[g].status = 'pending';
      delete state.gates[g].agentReview;
    }
    state.stages[stage].phase = i === from ? 'work' : 'pending';
  }
  emit(state, ctx, { type: 'stage.rework', stage: target, gate, note: `from ${state.stage}` });
  // Replanning (spec, decompose) discards the slices; the new plan replaces them.
  if (from <= STAGES.indexOf('decompose') && state.slices.length > 0) {
    state.slices = [];
    emit(state, ctx, { type: 'plan.discarded', stage: target, gate });
  }
  state.stage = target;
  if (target === 'implement') addFixupSlice(state, gate, ctx);
  touch(state, ctx);
}

function halt(state: RunState, reason: string, ctx: Ctx): void {
  state.status = 'halted';
  state.haltReason = reason;
  emit(state, ctx, { type: 'run.halted', note: reason });
  touch(state, ctx);
}

export function abort(state: RunState, reason: string | undefined, ctx: Ctx): void {
  if (state.status === 'done' || state.status === 'aborted') {
    throw new GenieError(`run ${state.id} is already ${state.status}`);
  }
  state.status = 'aborted';
  emit(state, ctx, { type: 'run.aborted', note: reason });
  touch(state, ctx);
}

function requireActive(state: RunState): void {
  if (state.status !== 'active') throw new GenieError(`run ${state.id} is ${state.status}`);
}
