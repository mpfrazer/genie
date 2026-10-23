// The deterministic core: pure transitions over RunState. No I/O; every change emits a log event.
import { GenieError } from './errors.ts';
import { GATE_DEFS, STAGE_DEFS, STAGES, stageOfGate, type GateName, type StageName } from './pipeline.ts';
import type { Config, GateConfig, GateKind } from './config/types.ts';
import type { GateState, RunState, Verdict } from './state.ts';
import type { LogEvent, LogEventBody } from './store.ts';

export interface Ctx {
  now: string;
  events: LogEvent[];
}

export type VerdictSource = 'automated' | 'agent' | 'human';

export type Action =
  | { type: 'work'; stage: StageName; instructions: string; artifact?: string; skill?: string; agent?: string }
  | { type: 'evaluate'; gate: GateName; kind: 'automated'; checks: string[] }
  | { type: 'evaluate'; gate: GateName; kind: 'agent' | 'agent+human'; evaluator?: string }
  | { type: 'await_human'; gate: GateName; reason: string; agentReview?: GateState['agentReview'] }
  | { type: 'halted'; reason: string }
  | { type: 'aborted' }
  | { type: 'done' };

export interface VerdictInput {
  gate: GateName;
  verdict: Verdict;
  source: VerdictSource;
  by: string;
  note?: string;
  evidence?: string[];
}

function emit(state: RunState, ctx: Ctx, event: LogEventBody): void {
  ctx.events.push({ ts: ctx.now, run: state.id, ...event });
}

function touch(state: RunState, ctx: Ctx): void {
  state.updatedAt = ctx.now;
}

function isResolved(gs: GateState, gc: GateConfig): boolean {
  return gs.status === 'pass' || gs.status === 'skipped' || (gs.status === 'fail' && !gc.blocking);
}

/** Skips disabled gates in `gates`, then returns the first one still needing a verdict. */
function resolveGates(state: RunState, config: Config, gates: GateName[], ctx: Ctx): GateName | undefined {
  for (const gate of gates) {
    const gs = state.gates[gate];
    const gc = config.gates[gate];
    if (gs.status === 'pending' && !gc.enabled) {
      gs.status = 'skipped';
      emit(state, ctx, { type: 'gate.skipped', gate, note: 'disabled by config' });
    }
    if (!isResolved(gs, gc)) return gate;
  }
  return undefined;
}

function gatesInPhase(state: RunState): GateName[] {
  const def = STAGE_DEFS[state.stage];
  const phase = state.stages[state.stage].phase;
  if (phase === 'entry') return def.entryGates;
  if (phase === 'exit') return def.exitGates;
  return [];
}

/** Applies every transition that needs no outside input, stopping at work or a gate verdict. */
export function advance(state: RunState, config: Config, ctx: Ctx): void {
  while (state.status === 'active') {
    const stage = state.stage;
    const def = STAGE_DEFS[stage];
    const ss = state.stages[stage];

    switch (ss.phase) {
      case 'pending':
        if (!config.stages[stage].enabled) {
          ss.phase = 'skipped';
          for (const gate of [...def.entryGates, ...def.exitGates]) state.gates[gate].status = 'skipped';
          emit(state, ctx, { type: 'stage.skipped', stage, note: 'disabled by config' });
        } else {
          ss.phase = 'entry';
          emit(state, ctx, { type: 'stage.started', stage });
        }
        break;
      case 'entry':
        if (resolveGates(state, config, def.entryGates, ctx)) return;
        ss.phase = def.hasWork ? 'work' : 'exit';
        break;
      case 'work':
        return;
      case 'exit':
        if (resolveGates(state, config, def.exitGates, ctx)) return;
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

/** The gate awaiting a verdict, if the run is currently at one. Call after `advance`. */
export function currentGate(state: RunState, config: Config): GateName | undefined {
  if (state.status !== 'active') return undefined;
  return gatesInPhase(state).find((g) => !isResolved(state.gates[g], config.gates[g]));
}

export function nextAction(state: RunState, config: Config): Action {
  if (state.status === 'done') return { type: 'done' };
  if (state.status === 'aborted') return { type: 'aborted' };
  if (state.status === 'halted') return { type: 'halted', reason: state.haltReason ?? 'halted' };

  const stage = state.stage;
  if (state.stages[stage].phase === 'work') {
    const def = STAGE_DEFS[stage];
    return { type: 'work', stage, instructions: def.instructions, artifact: def.artifact, skill: def.skill, agent: def.agent };
  }

  const gate = currentGate(state, config);
  if (!gate) throw new Error(`run ${state.id} is at ${stage} with nothing to do; call advance() first`);
  const gs = state.gates[gate];
  const gc = config.gates[gate];

  if (gs.status === 'needs_human') {
    return { type: 'await_human', gate, reason: 'escalated: automatic evaluation could not decide' };
  }
  switch (gc.kind) {
    case 'automated':
      return { type: 'evaluate', gate, kind: 'automated', checks: gc.checks ?? [] };
    case 'agent':
      return { type: 'evaluate', gate, kind: 'agent', evaluator: gc.evaluator };
    case 'human':
      return { type: 'await_human', gate, reason: GATE_DEFS[gate].description };
    case 'agent+human':
      return gs.agentReview
        ? { type: 'await_human', gate, reason: GATE_DEFS[gate].description, agentReview: gs.agentReview }
        : { type: 'evaluate', gate, kind: 'agent+human', evaluator: gc.evaluator };
  }
}

/** Marks the current stage's work complete and moves on to its exit gates. */
export function completeWork(
  state: RunState,
  config: Config,
  stage: StageName,
  by: string,
  artifactExists: (relPath: string) => boolean,
  ctx: Ctx,
): void {
  requireActive(state);
  if (state.stage !== stage || state.stages[stage].phase !== 'work') {
    throw new GenieError(`stage ${stage} is not in progress (run is at ${state.stage}/${state.stages[state.stage].phase})`);
  }
  const artifact = STAGE_DEFS[stage].artifact;
  if (artifact && !artifactExists(artifact)) {
    throw new GenieError(`stage ${stage} requires ${artifact} in the run directory`);
  }
  state.stages[stage].author = by;
  state.stages[stage].phase = 'exit';
  emit(state, ctx, { type: 'stage.work_done', stage, by });
  touch(state, ctx);
  advance(state, config, ctx);
}

const SOURCE_FOR_KIND: Record<GateKind, VerdictSource[]> = {
  automated: ['automated'],
  agent: ['agent'],
  human: ['human'],
  'agent+human': ['agent', 'human'],
};

export function recordVerdict(state: RunState, config: Config, input: VerdictInput, ctx: Ctx): void {
  requireActive(state);
  const { gate, verdict, source, by } = input;
  const current = currentGate(state, config);
  if (current !== gate) {
    throw new GenieError(`gate ${gate} is not awaiting a verdict (current: ${current ?? 'none'})`);
  }
  const gs = state.gates[gate];
  const gc = config.gates[gate];

  // Invariants: nothing but a human resolves a human decision, and authors don't grade their own work.
  if (gs.status === 'needs_human' && source !== 'human') {
    throw new GenieError(`gate ${gate} was escalated and needs a human decision`);
  }
  if (gs.status !== 'needs_human' && !SOURCE_FOR_KIND[gc.kind].includes(source)) {
    throw new GenieError(`gate ${gate} is a ${gc.kind} gate and cannot take a verdict from ${source}`);
  }
  const author = state.stages[stageOfGate(gate)].author;
  if (source === 'agent' && author && author === by) {
    throw new GenieError(`${by} authored stage ${stageOfGate(gate)} and cannot evaluate ${gate}`);
  }

  gs.attempts += 1;
  const logged = { gate, verdict, by, attempt: gs.attempts, note: input.note, evidence: input.evidence, source, gateConfig: gc };

  if (gc.kind === 'agent+human' && source === 'agent') {
    gs.agentReview = { verdict, by, note: input.note };
    emit(state, ctx, { type: 'gate.agent_review', ...logged });
    touch(state, ctx);
    return;
  }

  emit(state, ctx, { type: 'gate.verdict', ...logged });
  touch(state, ctx);

  if (verdict === 'pass') {
    gs.status = 'pass';
  } else if (verdict === 'needs_human') {
    gs.status = 'needs_human';
  } else if (source === 'human') {
    // A human rejection sends the work back with a fresh automatic budget.
    gs.failures = 0;
    rework(state, gate, ctx);
  } else if (!gc.blocking) {
    gs.status = 'fail';
  } else {
    gs.failures += 1;
    if (gs.failures <= gc.retries) {
      rework(state, gate, ctx);
    } else if (gc.escalate_to === 'human') {
      gs.status = 'needs_human';
      emit(state, ctx, { type: 'gate.escalated', gate, note: `failed ${gs.failures} times (retries: ${gc.retries})` });
    } else {
      halt(state, `${gate} failed ${gs.failures} times`, ctx);
    }
  }
  advance(state, config, ctx);
}

/** Routes a failed gate back to the stage that should redo the work. */
function rework(state: RunState, gate: GateName, ctx: Ctx): void {
  const target = GATE_DEFS[gate].onFail;
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
  state.stage = target;
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
