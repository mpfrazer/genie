import type { GateConfig, Config, ConfigLayer, ProfileName } from './types.ts';

const VERIFY_CHECKS = ['commands.build', 'commands.lint', 'commands.typecheck', 'commands.test'];

function human(): GateConfig {
  return { enabled: true, kind: 'human', blocking: true, retries: 0, escalate_to: 'human' };
}

function automated(checks: string[], retries: number): GateConfig {
  return { enabled: true, kind: 'automated', checks, blocking: true, retries, escalate_to: 'human' };
}

function agent(evaluator: string, retries: number): GateConfig {
  return { enabled: true, kind: 'agent', evaluator, blocking: true, retries, escalate_to: 'human' };
}

/** The strictest sensible baseline. Profiles and repo config relax it. */
export function defaultConfig(): Config {
  return {
    version: 1,
    profile: 'service',
    mode: { default: 'guided', max_parallel_slices: 4 },
    commands: {},
    forge: { provider: 'github', base_branch: 'main', branch_prefix: 'genie/' },
    stages: {
      spec: { enabled: true },
      decompose: { enabled: true },
      implement: { enabled: true },
      integrate: { enabled: true },
      pr: { enabled: true },
      merge: { enabled: true },
      build: { enabled: true },
      deploy: { enabled: true },
      release: { enabled: true },
    },
    gates: {
      'spec.approved': human(),
      'plan.approved': human(),
      'slice.verified': automated(VERIFY_CHECKS, 3),
      'slice.reviewed': agent('adversarial-reviewer', 3),
      'integration.verified': automated(VERIFY_CHECKS, 2),
      'pr.ready': automated([], 2),
      'intent.reviewed': agent('intent-reviewer', 1),
      'pr.approved': human(),
      'build.passed': automated(['commands.build'], 0),
      'deploy.approved': human(),
      'deploy.healthy': automated(['deploy.health_check'], 0),
      'release.approved': human(),
    },
    deploy: { environments: ['staging', 'production'] },
    release: { versioning: 'semver', changelog: 'conventional-commits' },
    enforcement: { enabled: true, protect_base_branch: true, outside_run: 'allow' },
    budgets: { max_iterations_per_slice: 5, max_run_duration: '4h', max_cost_usd: 50 },
  };
}

// Disabling a stage means "don't do it"; disabling a gate means "do it without checking".
// Profiles turn off deploy/release as stages, never by dropping their approval gates.
export const PROFILE_OVERLAYS: Record<ProfileName, ConfigLayer> = {
  prototype: {
    stages: { deploy: { enabled: false }, release: { enabled: false } },
    gates: {
      'intent.reviewed': { enabled: false },
      'slice.reviewed': { blocking: false },
      'pr.approved': { enabled: false },
    },
  },
  'internal-tool': {
    stages: { release: { enabled: false } },
    gates: { 'intent.reviewed': { enabled: false } },
  },
  service: {},
  library: {
    stages: { deploy: { enabled: false } },
  },
};
