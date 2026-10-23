import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { deepMerge, loadConfig } from './load.ts';

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
});

describe('deepMerge', () => {
  it('replaces arrays instead of concatenating them', () => {
    assert.deepEqual(deepMerge({ a: [1, 2], b: { c: 1 } }, { a: [3], b: { d: 2 } }), { a: [3], b: { c: 1, d: 2 } });
  });
});
