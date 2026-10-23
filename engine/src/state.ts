import { GenieError } from './errors.ts';
import { GATES, RUN_GATES, SLICE_GATES, STAGES, type RunGateName, type SliceGateName, type StageName } from './pipeline.ts';
import type { Mode } from './config/types.ts';
import type { PlanSlice } from './plan.ts';

export const STATE_VERSION = 2;

export type StagePhase = 'pending' | 'entry' | 'work' | 'exit' | 'passed' | 'skipped';
export type SlicePhase = 'work' | 'exit' | 'merge' | 'passed';
export type GateStatus = 'pending' | 'pass' | 'fail' | 'needs_human' | 'skipped';
export type Verdict = 'pass' | 'fail' | 'needs_human';
export type RunStatus = 'active' | 'halted' | 'done' | 'aborted';

export interface StageState {
  phase: StagePhase;
  /** Who did the stage's work; they may not evaluate its gates. */
  author?: string;
}

export interface GateState {
  status: GateStatus;
  /** Verdicts recorded so far, across rework loops. */
  attempts: number;
  /** Automatic failures counted against the gate's retry budget. */
  failures: number;
  /** For agent+human gates: the agent's pre-review, handed to the human. */
  agentReview?: { verdict: Verdict; by: string; note?: string };
}

export interface SliceState {
  /** The slice as planned: snapshotted from plan.yaml at `done decompose`, or synthesized for fix-ups. */
  def: PlanSlice;
  /**
   * `work` until its work is done, `exit` while its gates run, then `passed`. A slice with its own
   * worktree goes through `merge` first, until its branch lands on the run branch.
   */
  phase: SlicePhase;
  /** Who did the slice's work; they may not evaluate its gates. */
  author?: string;
  /** Rounds of work completed, counted against `budgets.max_iterations_per_slice`. */
  iterations?: number;
  /** On fix-up slices: the run-level gate whose failure sent the run back to implement. */
  fixes?: RunGateName;
  /** Orchestrated mode: the slice's own worktree and branch, while they exist. */
  worktree?: { path: string; branch: string };
  /** The merge commit that landed the slice on the run branch (orchestrated mode). */
  merged?: string;
  gates: Record<SliceGateName, GateState>;
}

export interface RunState {
  version: typeof STATE_VERSION;
  id: string;
  title: string;
  mode: Mode;
  status: RunStatus;
  haltReason?: string;
  stage: StageName;
  /** Branch the run's work is committed on, and the branch it lands in. */
  branch: string;
  base: string;
  createdAt: string;
  updatedAt: string;
  stages: Record<StageName, StageState>;
  gates: Record<RunGateName, GateState>;
  /** Orchestrated-mode budget accounting; absent until the run's first orchestrated step. */
  budget?: BudgetState;
  /** The plan's slices in plan order, followed by any fix-up slices. Empty until `done decompose`. */
  slices: SliceState[];
}

export interface BudgetState {
  /** Time spent orchestrated and not waiting on a human, in milliseconds. */
  activeMs: number;
  /** When `activeMs` was last brought up to date. */
  tickedAt: string;
  /** Cost charged to the run, in USD. */
  costUsd: number;
  /** The last cumulative cost reported for each Claude Code session, so each report charges only its increase. */
  sessions: Record<string, number>;
  /** Times a human extended the budget; each adds the configured limits again. */
  extensions: number;
  /** Set while the run is paused for exceeding a limit: which one, and by how much. */
  exceeded?: string;
}

export interface NewRun {
  id: string;
  title: string;
  mode: Mode;
  branch: string;
  base: string;
}

export function freshGate(): GateState {
  return { status: 'pending', attempts: 0, failures: 0 };
}

export function newSliceState(def: PlanSlice, fixes?: RunGateName): SliceState {
  return {
    def,
    phase: 'work',
    ...(fixes ? { fixes } : {}),
    gates: Object.fromEntries(SLICE_GATES.map((g) => [g, freshGate()])) as Record<SliceGateName, GateState>,
  };
}

export function newRunState({ id, title, mode, branch, base }: NewRun, now: string): RunState {
  return {
    version: STATE_VERSION,
    id,
    title,
    mode,
    branch,
    base,
    status: 'active',
    stage: STAGES[0],
    createdAt: now,
    updatedAt: now,
    stages: Object.fromEntries(STAGES.map((s) => [s, { phase: 'pending' }])) as Record<StageName, StageState>,
    gates: Object.fromEntries(RUN_GATES.map((g) => [g, freshGate()])) as Record<RunGateName, GateState>,
    slices: [],
  };
}

export function findSlice(state: RunState, id: string): SliceState | undefined {
  return state.slices.find((s) => s.def.id === id);
}

/** Why a v1 run past planning can't continue under per-slice state. */
export const V1_HALT_REASON =
  'started by an older genie (state v1) and already past planning, so it has no per-slice state to resume. ' +
  'Abort it (`genie abort`) and start a new run, or finish it with the genie version that started it.';

/**
 * Upgrades state written by older engines. v1 tracked slice gates once per run and had no plan.
 * - v1 runs still planning upgrade cleanly: their plan.yaml is validated at `done decompose`.
 * - Finished or aborted v1 runs upgrade cleanly: nothing more will happen to them.
 * - Active v1 runs past planning have no slices to resume, so they upgrade as halted with an
 *   explanation. `genie abort` still works on them.
 */
export function migrateState(raw: unknown, id: string): RunState {
  const state = raw as { version?: number };
  if (state.version === STATE_VERSION) return raw as RunState;
  if (state.version !== 1) {
    throw new GenieError(`run ${id} has state version ${String(state.version)}, which this genie doesn't understand`);
  }
  const v1 = raw as Omit<RunState, 'version' | 'slices' | 'gates'> & {
    version: 1;
    gates: Record<(typeof GATES)[number], GateState>;
  };
  const gates = Object.fromEntries(RUN_GATES.map((g) => [g, v1.gates[g] ?? freshGate()])) as Record<RunGateName, GateState>;
  const migrated: RunState = { ...v1, version: STATE_VERSION, gates, slices: [] };
  const planning =
    v1.stage === 'spec' || (v1.stage === 'decompose' && ['pending', 'entry', 'work'].includes(v1.stages.decompose.phase));
  if ((v1.status === 'active' || v1.status === 'halted') && !planning) {
    migrated.status = 'halted';
    migrated.haltReason = V1_HALT_REASON;
  }
  return migrated;
}
