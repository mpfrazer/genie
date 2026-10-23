import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { advance, completeWork, recordVerdict, type Ctx } from '../engine.ts';
import { resolveConfig } from '../config/load.ts';
import type { Config, ConfigLayer } from '../config/types.ts';
import { newRunState, type RunState } from '../state.ts';
import { classify, isStatePath } from './classify.ts';
import { callerFrom, decide, type PolicyInput } from './policy.ts';
import { simpleCommands } from './shell.ts';

const BASE: ConfigLayer = {
  stages: { deploy: { enabled: true } },
  deploy: { command: './scripts/deploy.sh {env}' },
  release: { publish: 'make publish' },
};

function config(layer: ConfigLayer = {}): Config {
  return resolveConfig('service', [BASE, layer]);
}

function check(
  command: string,
  opts: { config?: Config | null; run?: RunState; agent?: string; branch?: string } = {},
) {
  const cfg = opts.config === null ? undefined : (opts.config ?? config());
  const input: PolicyInput = {
    actions: simpleCommands(command).flatMap((argv) => classify(argv, cfg)),
    caller: callerFrom(opts.agent),
    config: cfg,
    run: opts.run,
    currentBranch: () => opts.branch ?? 'genie/feature',
  };
  return decide(input);
}

/** A run advanced to the given stage's work phase, with every earlier gate passed. */
function runAt(stage: 'implement' | 'pr' | 'merge', cfg = config()): RunState {
  const ctx: Ctx = { now: '2026-10-22T00:00:00.000Z', events: [] };
  const run = newRunState('r1', 'test', 'guided', ctx.now);
  advance(run, cfg, ctx);
  const human = (gate: Parameters<typeof recordVerdict>[2]['gate']) =>
    recordVerdict(run, cfg, { gate, verdict: 'pass', source: 'human', by: 'human' }, ctx);
  const auto = (gate: Parameters<typeof recordVerdict>[2]['gate'], source: 'automated' | 'agent', by: string) =>
    recordVerdict(run, cfg, { gate, verdict: 'pass', source, by }, ctx);
  const work = (s: Parameters<typeof completeWork>[2]) => completeWork(run, cfg, s, 'claude', () => true, ctx);

  work('spec');
  human('spec.approved');
  work('decompose');
  human('plan.approved');
  if (stage === 'implement') return run;
  work('implement');
  auto('slice.verified', 'automated', 'genie');
  auto('slice.reviewed', 'agent', 'adversarial-reviewer');
  work('integrate');
  auto('integration.verified', 'automated', 'genie');
  if (stage === 'pr') return run;
  work('pr');
  auto('pr.ready', 'automated', 'genie');
  auto('intent.reviewed', 'agent', 'intent-reviewer');
  return run;
}

describe('invariants (always on)', () => {
  it('denies the model approving gates, however it is invoked', () => {
    for (const cmd of [
      'genie approve spec.approved',
      'node /plugins/genie/engine/dist/genie.mjs approve spec.approved',
      `bash -c "genie approve plan.approved"`,
      'cd repo && env X=1 genie --run-id r1 approve spec.approved',
    ]) {
      assert.equal(check(cmd)?.decision, 'deny', cmd);
    }
  });

  it('denies writes to engine-owned run state, but not stage artifacts', () => {
    assert.equal(check('echo {} > .genie/runs/r1/state.json')?.decision, 'deny');
    assert.equal(check('sed -i s/pending/pass/ .genie/runs/r1/state.json')?.decision, 'deny');
    assert.equal(check('rm -rf .genie/runs/r1')?.decision, 'deny');
    assert.equal(check('mv /tmp/x .genie/runs/CURRENT')?.decision, 'deny');
    assert.equal(check('cat .genie/runs/r1/state.json')?.decision, undefined);
    assert.equal(check('cat > .genie/runs/r1/spec.md')?.decision, undefined);
    assert.ok(isStatePath('/repo/.genie/runs/r1/evidence/x.log'));
    assert.ok(isStatePath('/repo/.genie/runs/r1/state.json.123.tmp'));
    assert.ok(!isStatePath('/repo/.genie/runs/r1/plan.md'));
  });

  it('asks before the config is edited', () => {
    assert.equal(check(`sed -i 's/true/false/' .genie/config.yaml`)?.decision, 'ask');
    assert.equal(check('grep enabled .genie/config.yaml')?.decision, undefined);
  });

  it('binds verdict and done identities to the caller', () => {
    const gate = 'genie gate slice.reviewed --verdict pass --by adversarial-reviewer';
    assert.equal(check(gate)?.decision, 'deny');
    assert.equal(check(gate, { agent: 'implementer' })?.decision, 'deny');
    assert.equal(check(gate, { agent: 'genie:adversarial-reviewer' })?.decision, undefined);
    assert.equal(check('genie done implement --by implementer')?.decision, 'deny');
    assert.equal(check('genie done implement', { agent: 'genie:implementer' })?.decision, 'deny');
    assert.equal(check('genie done implement --by implementer', { agent: 'genie:implementer' })?.decision, undefined);
    assert.equal(check('genie done spec')?.decision, undefined);
  });
});

describe('base branch protection', () => {
  it('denies pushes that update the base branch', () => {
    for (const cmd of [
      'git push origin main',
      'git push origin HEAD:main',
      'git push origin +feature:refs/heads/main',
      'git push --all',
      'git push --mirror origin',
      'git push origin --delete main',
      'git -C ../other push origin main',
    ]) {
      assert.equal(check(cmd)?.decision, 'deny', cmd);
    }
  });

  it('denies an implicit push while main is checked out', () => {
    assert.equal(check('git push', { branch: 'main' })?.decision, 'deny');
    assert.equal(check('git push origin HEAD', { branch: 'main' })?.decision, 'deny');
    assert.equal(check('git push --tags', { branch: 'main' })?.decision, undefined);
  });

  it('can be turned off', () => {
    const cfg = config({ enforcement: { protect_base_branch: false } });
    assert.equal(check('git push origin main', { config: cfg })?.decision, undefined);
  });
});

describe('outward actions', () => {
  it('allows everything outside a run by default', () => {
    for (const cmd of ['git push origin feature', 'gh pr create --fill', 'gh pr merge 3', 'npm publish']) {
      assert.equal(check(cmd)?.decision, undefined, cmd);
    }
  });

  it('denies outward actions outside a run when configured to', () => {
    const cfg = config({ enforcement: { outside_run: 'deny' } });
    assert.equal(check('gh pr create --fill', { config: cfg })?.decision, 'deny');
  });

  it('is a no-op in repos without genie', () => {
    assert.equal(check('git push origin main', { config: null })?.decision, undefined);
    assert.equal(check('gh release create v1', { config: null })?.decision, undefined);
  });

  it('gates each action on the stage it belongs to', () => {
    const implementing = runAt('implement');
    assert.equal(check('git push -u origin genie/r1', { run: implementing })?.decision, 'deny');
    assert.match(check('gh pr create --fill', { run: implementing })?.reason ?? '', /reaches the pr stage/);

    const atPr = runAt('pr');
    assert.equal(check('git push -u origin genie/r1', { run: atPr })?.decision, undefined);
    assert.equal(check('gh pr create --fill', { run: atPr })?.decision, undefined);
    assert.equal(check('gh pr merge --squash', { run: atPr })?.decision, 'deny');

    // At merge, pr.approved (an entry gate) is still pending.
    const awaitingApproval = runAt('merge');
    assert.equal(check('gh pr merge --squash', { run: awaitingApproval })?.decision, 'deny');
    assert.equal(check('./scripts/deploy.sh staging', { run: awaitingApproval })?.decision, 'deny');
  });

  it('treats tags, GitHub releases, and publishing as releases', () => {
    const run = runAt('pr');
    for (const cmd of ['git tag v1.0.0', 'git push origin --tags', 'git push origin refs/tags/v1', 'gh release create v1', 'npm publish', 'make publish']) {
      assert.equal(check(cmd, { run })?.decision, 'deny', cmd);
    }
    assert.equal(check('git tag -l', { run })?.decision, undefined);
  });

  it('denies outward actions for disabled stages', () => {
    const cfg = config({ stages: { release: { enabled: false } } });
    assert.match(check('gh release create v1', { config: cfg, run: runAt('pr', cfg) })?.reason ?? '', /disabled/);
  });

  it('can be turned off, leaving the invariants', () => {
    const cfg = config({ enforcement: { enabled: false } });
    const run = runAt('implement', cfg);
    assert.equal(check('gh pr merge 3', { config: cfg, run })?.decision, undefined);
    assert.equal(check('genie approve spec.approved', { config: cfg, run })?.decision, 'deny');
  });
});
