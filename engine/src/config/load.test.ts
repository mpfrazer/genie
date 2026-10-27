import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { deepMerge, loadConfig } from './load.ts';
import { defaultConfig } from './defaults.ts';
import type { Config } from './types.ts';
import { configDiff } from '../session.ts';

function repo(repoYaml?: string, userYaml?: string): { root: string; userDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'genie-config-'));
  const userDir = join(root, 'user-home');
  mkdirSync(join(root, '.genie'));
  mkdirSync(userDir);
  if (repoYaml !== undefined) writeFileSync(join(root, '.genie', 'config.yaml'), repoYaml);
  if (userYaml !== undefined) writeFileSync(join(userDir, 'config.yaml'), userYaml);
  return { root, userDir };
}

const NO_DEPLOY = 'stages:\n  deploy:\n    enabled: false\n';

describe('loadConfig', () => {
  it('applies the profile overlay', () => {
    const { config } = loadConfig(repo('profile: internal-tool\n' + NO_DEPLOY));
    assert.equal(config.profile, 'internal-tool');
    assert.equal(config.gates['intent.reviewed'].enabled, false);
    assert.equal(config.stages.release.enabled, false);
    assert.equal(config.gates['slice.reviewed'].enabled, true);
  });

  it('lets the repo override a single gate field without losing the rest', () => {
    const { config } = loadConfig(repo(NO_DEPLOY + 'gates:\n  slice.reviewed:\n    retries: 7\n'));
    assert.equal(config.gates['slice.reviewed'].retries, 7);
    assert.equal(config.gates['slice.reviewed'].evaluator, 'adversarial-reviewer');
  });

  it('layers defaults < user < repo < flags', () => {
    const opts = repo(NO_DEPLOY + 'mode:\n  max_parallel_slices: 2\n', 'mode:\n  default: orchestrated\n  max_parallel_slices: 8\n');
    const { config, sources } = loadConfig(opts);
    assert.equal(config.mode.default, 'orchestrated');
    assert.equal(config.mode.max_parallel_slices, 2);
    assert.equal(sources.length, 2);
    const flagged = loadConfig({ ...opts, flags: { mode: { max_parallel_slices: 1 } } }).config;
    assert.equal(flagged.mode.max_parallel_slices, 1);
  });

  it('takes the profile from the user layer when the repo sets none', () => {
    const { config } = loadConfig(repo('', 'profile: prototype\n'));
    assert.equal(config.profile, 'prototype');
    assert.equal(config.gates['pr.approved'].enabled, false);
  });

  it('rejects unknown gates with the offending key', () => {
    assert.throws(() => loadConfig(repo(NO_DEPLOY + 'gates:\n  intent.reviewd:\n    enabled: false\n')), /intent\.reviewd/);
  });

  it('rejects wrongly typed values', () => {
    assert.throws(() => loadConfig(repo(NO_DEPLOY + 'gates:\n  spec.approved:\n    enabled: nope\n')), /must be boolean/);
  });

  it('requires a deploy command when the deploy stage is enabled', () => {
    assert.throws(() => loadConfig(repo('profile: service\n')), /deploy\.command/);
    const { config } = loadConfig(repo('deploy:\n  command: ./deploy.sh {env}\n'));
    assert.equal(config.stages.deploy.enabled, true);
  });

  it('allows a PR per slice only when PRs are opened and merged, on GitHub', () => {
    const slice = `${NO_DEPLOY}forge:\n  pr_per: slice\n`;
    assert.equal(loadConfig(repo(slice)).config.forge.pr_per, 'slice');
    assert.throws(() => loadConfig(repo(`${slice}  provider: gitlab\n`)), /needs forge\.provider: github \(it is gitlab\)/);
    assert.throws(() => loadConfig(repo(`${NO_DEPLOY}  merge:\n    enabled: false\nforge:\n  pr_per: slice\n`)), /stages\.merge is disabled/);
  });
});

describe('deepMerge', () => {
  it('replaces arrays instead of concatenating them', () => {
    assert.deepEqual(deepMerge({ a: [1, 2], b: { c: 1 } }, { a: [3], b: { d: 2 } }), { a: [3], b: { c: 1, d: 2 } });
  });
});

describe('configDiff', () => {
  it("doesn't report settings a run's older snapshot predates, unless they differ from the default", () => {
    const current = defaultConfig();
    const older = structuredClone(current) as unknown as { forge: Record<string, unknown> };
    delete older.forge.pr_per;
    assert.deepEqual(configDiff(older as unknown as Config, current), []);
    assert.deepEqual(configDiff(older as unknown as Config, { ...current, forge: { ...current.forge, pr_per: 'slice' } }), ['forge.pr_per']);
  });
});
