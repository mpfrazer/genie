import { GATES, STAGES, type GateName, type StageName } from './pipeline.ts';
import type { Mode } from './config/types.ts';

export type StagePhase = 'pending' | 'entry' | 'work' | 'exit' | 'passed' | 'skipped';
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

export interface RunState {
  version: 1;
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
  gates: Record<GateName, GateState>;
}

export interface NewRun {
  id: string;
  title: string;
  mode: Mode;
  branch: string;
  base: string;
}

export function newRunState({ id, title, mode, branch, base }: NewRun, now: string): RunState {
  return {
    version: 1,
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
    gates: Object.fromEntries(GATES.map((g) => [g, { status: 'pending', attempts: 0, failures: 0 }])) as Record<
      GateName,
      GateState
    >,
  };
}
