import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runChecks } from './checks.ts';
import { resolveConfig } from './config/load.ts';

function setup(layer: Parameters<typeof resolveConfig>[1][number]) {
  const root = mkdtempSync(join(tmpdir(), 'genie-checks-'));
  const config = resolveConfig('service', [{ stages: { deploy: { enabled: false } } }, layer]);
  return { root, config, evidence: join(root, 'evidence') };
}

describe('runChecks', () => {
  it('stops at the first failure and keeps its log', () => {
    const { root, config, evidence } = setup({ commands: { lint: 'echo linted', test: 'echo boom >&2; exit 3', build: 'echo never' } });
    const out = runChecks(root, config, ['commands.lint', 'commands.test', 'commands.build'], evidence, 'g.1');
    assert.equal(out.verdict, 'fail');
    assert.equal(out.note, 'commands.test failed (exit 3)');
    assert.deepEqual(out.results.map((r) => r.status), ['pass', 'fail']);
    assert.match(readFileSync(out.results[1]!.log!, 'utf8'), /boom/);
  });

  it('needs a human when nothing is configured', () => {
    const { root, config, evidence } = setup({});
    assert.equal(runChecks(root, config, ['commands.test'], evidence, 'g.1').verdict, 'needs_human');
  });

  it('runs {env} checks once per deploy environment', () => {
    const { root, config, evidence } = setup({
      deploy: { health_check: 'test {env} != production', environments: ['staging', 'production'] },
    });
    const out = runChecks(root, config, ['deploy.health_check'], evidence, 'g.1');
    assert.equal(out.verdict, 'fail');
    assert.deepEqual(
      out.results.map((r) => [r.command, r.status]),
      [
        ['test staging != production', 'pass'],
        ['test production != production', 'fail'],
      ],
    );
    assert.ok(out.results[1]!.log!.endsWith('g.1.deploy-health_check-production.log'));
  });
});
