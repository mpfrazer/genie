import type { GateName, StageName } from '../pipeline.ts';

export const PROFILES = ['prototype', 'internal-tool', 'service', 'library'] as const;
export type ProfileName = (typeof PROFILES)[number];

export type Mode = 'guided' | 'orchestrated';
export type GateKind = 'automated' | 'agent' | 'human' | 'agent+human';

export interface GateConfig {
  /** Disabled gates are skipped, and the skip is logged. */
  enabled: boolean;
  kind: GateKind;
  /** Subagent that evaluates agent gates. */
  evaluator?: string;
  /** Dotted config paths (e.g. `commands.test`) whose commands an automated gate runs. */
  checks?: string[];
  /** Advisory gates record failures without stopping the run. */
  blocking: boolean;
  /** Automatic fix → re-evaluate loops before escalating. */
  retries: number;
  escalate_to: 'human' | 'halt';
  /** Overrides that apply while the run is in orchestrated mode (e.g. an agent decides instead of a human). */
  orchestrated?: Partial<Omit<GateConfig, 'orchestrated'>>;
}

export interface Config {
  version: 1;
  profile: ProfileName;
  mode: { default: Mode; max_parallel_slices: number };
  commands: Record<string, string>;
  forge: {
    provider: 'github' | 'gitlab' | 'none';
    base_branch: string;
    branch_prefix: string;
    pr_draft_until?: GateName;
    /** Waits for the run branch's CI and exits non-zero if it fails; evaluated by pr.ready. */
    ci_command?: string;
    /**
     * `run`: the slices land on the run branch, which becomes one PR. `slice`: in orchestrated
     * mode, each slice gets its own PR into the base branch, checked, approved, and merged on its own.
     */
    pr_per: 'run' | 'slice';
  };
  stages: Record<StageName, { enabled: boolean }>;
  gates: Record<GateName, GateConfig>;
  deploy: {
    command?: string;
    health_check?: string;
    rollback?: string;
    environments: string[];
  };
  release: {
    versioning: 'semver' | 'calver' | 'none';
    changelog: 'conventional-commits' | 'none';
    publish?: string;
  };
  /** What the PreToolUse hook enforces. Core invariants (no model approvals, no state tampering) always apply. */
  enforcement: {
    /** Gate outward actions (push, PR, merge, deploy, release) on run progress. */
    enabled: boolean;
    /** Refuse pushes that update forge.base_branch: changes land through PRs. */
    protect_base_branch: boolean;
    /** Whether outward actions are allowed when no run is active. */
    outside_run: 'allow' | 'deny';
  };
  /** Orchestrated-mode safety rails. Exceeding one pauses the run for a human (§7). */
  budgets: {
    /** Rounds of work a slice may take before a failed gate escalates instead of reworking. */
    max_iterations_per_slice: number;
    /** Time the run may spend orchestrated and not waiting on a human, e.g. `4h`. */
    max_run_duration: string;
    /** Cost the run's orchestrated sessions may spend, as reported to the status line. */
    max_cost_usd: number;
  };
}

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export type ConfigLayer = DeepPartial<Config>;
