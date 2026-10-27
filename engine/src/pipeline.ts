// The fixed shape of the genie pipeline: stages, the gates around them, and where failures route.
// Configuration can enable/disable stages and tune gates, but never reorder or rewire them.

export const STAGES = [
  'spec',
  'decompose',
  'implement',
  'integrate',
  'pr',
  'merge',
  'build',
  'deploy',
  'release',
] as const;
export type StageName = (typeof STAGES)[number];

export const GATES = [
  'spec.approved',
  'plan.approved',
  'slice.verified',
  'slice.reviewed',
  'integration.verified',
  'pr.ready',
  'intent.reviewed',
  'pr.approved',
  'build.passed',
  'deploy.approved',
  'deploy.healthy',
  'release.approved',
] as const;
export type GateName = (typeof GATES)[number];

/** Gates evaluated once per slice of the plan, inside the implement stage. */
export const SLICE_GATES = ['slice.verified', 'slice.reviewed'] as const;
export type SliceGateName = (typeof SLICE_GATES)[number];
/**
 * With a PR per slice (`forge.pr_per: slice`), these gates are also evaluated once per slice, on
 * that slice's own pull request, while the run is in the implement stage.
 */
export const DELIVERY_GATES = ['pr.ready', 'intent.reviewed', 'pr.approved'] as const;
export type DeliveryGateName = (typeof DELIVERY_GATES)[number];

export function isDeliveryGate(gate: GateName): gate is DeliveryGateName {
  return (DELIVERY_GATES as readonly string[]).includes(gate);
}

/** Gates evaluated once per run. */
export type RunGateName = Exclude<GateName, SliceGateName>;
export const RUN_GATES = GATES.filter((g): g is RunGateName => !(SLICE_GATES as readonly string[]).includes(g));

export function isSliceGate(gate: GateName): gate is SliceGateName {
  return (SLICE_GATES as readonly string[]).includes(gate);
}

export interface StageDef {
  name: StageName;
  /** False for stages that consist only of gates. */
  hasWork: boolean;
  /** File (relative to the run directory) that must exist before the stage's work counts as done. */
  artifact?: string;
  /** Short instruction handed to whoever performs the stage's work. */
  instructions: string;
  /** Plugin skill holding the stage playbook, for work done in the main session. */
  skill?: string;
  /** Subagent that performs the work instead of the main session. */
  agent?: string;
  /** Work must be committed on the run branch, ahead of the base branch, before it counts as done. */
  onRunBranch?: boolean;
  /** Gates that must resolve before work starts (e.g. approval to deploy). */
  entryGates: RunGateName[];
  /** Gates that must resolve before the stage passes. */
  exitGates: RunGateName[];
}

export interface GateDef {
  name: GateName;
  description: string;
  /** Stage to rework when the gate fails, or 'halt' to stop the run. */
  onFail: StageName | 'halt';
}

export const STAGE_DEFS: Record<StageName, StageDef> = {
  spec: {
    name: 'spec',
    hasWork: true,
    artifact: 'spec.md',
    instructions:
      'Elaborate intent.md into spec.md: requirements, acceptance criteria, constraints, non-goals, risks.',
    skill: 'genie:spec',
    entryGates: [],
    exitGates: ['spec.approved'],
  },
  decompose: {
    name: 'decompose',
    hasWork: true,
    artifact: 'plan.yaml',
    instructions:
      'Decompose spec.md into independently implementable, testable slices with dependencies, written to plan.yaml.',
    skill: 'genie:decompose',
    entryGates: [],
    exitGates: ['plan.approved'],
  },
  // Work happens per slice: each slice of plan.yaml is implemented and passes the SLICE_GATES on its
  // own. The stage passes once every slice has.
  implement: {
    name: 'implement',
    hasWork: true,
    instructions: 'Implement this slice of plan.yaml, with tests, committed on the run branch.',
    agent: 'implementer',
    onRunBranch: true,
    entryGates: [],
    exitGates: [],
  },
  integrate: {
    name: 'integrate',
    hasWork: true,
    instructions: 'Integrate completed slices onto the run branch and resolve conflicts.',
    skill: 'genie:integrate',
    onRunBranch: true,
    entryGates: [],
    exitGates: ['integration.verified'],
  },
  pr: {
    name: 'pr',
    hasWork: true,
    instructions: 'Push the run branch and open a pull request with a generated description.',
    skill: 'genie:pr',
    entryGates: [],
    exitGates: ['pr.ready', 'intent.reviewed'],
  },
  merge: {
    name: 'merge',
    hasWork: true,
    instructions: 'Merge the approved pull request into the base branch.',
    skill: 'genie:merge',
    entryGates: ['pr.approved'],
    exitGates: [],
  },
  build: {
    name: 'build',
    hasWork: false,
    instructions: 'Produce the release build artifact.',
    entryGates: [],
    exitGates: ['build.passed'],
  },
  deploy: {
    name: 'deploy',
    hasWork: true,
    instructions: 'Deploy using deploy.command for each configured environment.',
    skill: 'genie:deploy',
    entryGates: ['deploy.approved'],
    exitGates: ['deploy.healthy'],
  },
  release: {
    name: 'release',
    hasWork: true,
    instructions: 'Version, write the changelog, tag, and publish.',
    skill: 'genie:release',
    entryGates: ['release.approved'],
    exitGates: [],
  },
};

export const GATE_DEFS: Record<GateName, GateDef> = {
  'spec.approved': { name: 'spec.approved', description: 'Spec is complete and matches intent', onFail: 'spec' },
  'plan.approved': {
    name: 'plan.approved',
    description: 'Slices cover the spec, are independent, acyclic, and reasonably sized',
    onFail: 'decompose',
  },
  'slice.verified': { name: 'slice.verified', description: 'Build, lint, typecheck, and tests pass', onFail: 'implement' },
  'slice.reviewed': {
    name: 'slice.reviewed',
    description: 'Adversarial review: correctness, security, test adequacy, scope',
    onFail: 'implement',
  },
  'integration.verified': {
    name: 'integration.verified',
    description: 'Full suite passes on the integrated branch',
    onFail: 'implement',
  },
  'pr.ready': { name: 'pr.ready', description: 'PR exists with description and green CI', onFail: 'pr' },
  'intent.reviewed': {
    name: 'intent.reviewed',
    description: 'Final diff matches the original intent',
    onFail: 'spec',
  },
  'pr.approved': { name: 'pr.approved', description: 'Required reviewers approved the PR', onFail: 'implement' },
  'build.passed': { name: 'build.passed', description: 'Release build artifact produced', onFail: 'halt' },
  'deploy.approved': { name: 'deploy.approved', description: 'Approval to deploy', onFail: 'halt' },
  'deploy.healthy': { name: 'deploy.healthy', description: 'Post-deploy health checks pass', onFail: 'halt' },
  'release.approved': { name: 'release.approved', description: 'Approval to version, tag, and publish', onFail: 'halt' },
};

/** The stage whose entry or exit gates include the given gate (slice gates belong to implement). */
export function stageOfGate(gate: GateName): StageName {
  if (isSliceGate(gate)) return 'implement';
  for (const stage of STAGES) {
    const def = STAGE_DEFS[stage];
    if (def.entryGates.includes(gate) || def.exitGates.includes(gate)) return stage;
  }
  throw new Error(`gate ${gate} is not attached to any stage`);
}
