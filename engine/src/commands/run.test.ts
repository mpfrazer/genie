import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../cli.ts', import.meta.url));

function sh(root: string, cmd: string[]) {
  const res = spawnSync(cmd[0]!, cmd.slice(1), { cwd: root, encoding: 'utf8' });
  assert.equal(res.status, 0, `${cmd.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'genie-run-'));
  sh(root, ['git', 'init', '-q', '-b', 'main']);
  sh(root, ['git', 'config', 'user.email', 'test@example.com']);
  sh(root, ['git', 'config', 'user.name', 'test']);
  // The test command passes once a file named `fixed` exists.
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'test -f fixed' } }));
  sh(root, ['git', 'add', '-A']);
  sh(root, ['git', 'commit', '-q', '-m', 'init']);
  return root;
}

function genie(root: string, args: string[], input?: string) {
  return spawnSync('node', [CLI, ...args], {
    cwd: root,
    input,
    encoding: 'utf8',
    env: { ...process.env, GENIE_HOME: join(root, '.genie-home') },
  });
}

function ok(root: string, args: string[], input?: string) {
  const res = genie(root, args, input);
  assert.equal(res.status, 0, `genie ${args.join(' ')}: ${res.stderr}${res.stdout}`);
  return res.stdout;
}

const nextJson = (root: string) => JSON.parse(ok(root, ['next', '--json']));

describe('guided run through the CLI', () => {
  it('records the run branch, enforces it on done, and surfaces rework feedback', () => {
    const root = repo();
    ok(root, ['init', '--profile', 'internal-tool']);
    ok(root, ['new', '--file', '-'], 'Add a greeting\n\nSo users feel welcome.');

    let view = nextJson(root);
    assert.match(view.run.branch, /^genie\/\d{8}-\d{6}-add-a-greeting$/);
    assert.equal(view.run.base, 'main');
    assert.deepEqual(
      { type: view.action.type, stage: view.action.stage, skill: view.action.skill },
      { type: 'work', stage: 'spec', skill: 'genie:spec' },
    );

    writeFileSync(join(view.run.dir, 'spec.md'), '# spec');
    ok(root, ['done', 'spec']);
    ok(root, ['approve', 'spec.approved']);
    writeFileSync(join(view.run.dir, 'plan.md'), '# plan');
    ok(root, ['done', 'decompose']);
    ok(root, ['approve', 'plan.approved']);

    view = nextJson(root);
    assert.equal(view.action.agent, 'implementer');
    const offBranch = genie(root, ['done', 'implement', '--by', 'implementer']);
    assert.equal(offBranch.status, 1);
    assert.match(offBranch.stderr, /run branch genie\/.* \(currently on main\)/);

    sh(root, ['git', 'switch', '-q', '-c', view.run.branch]);
    const noCommits = genie(root, ['done', 'implement', '--by', 'implementer']);
    assert.match(noCommits.stderr, /no commits ahead of main/);

    writeFileSync(join(root, 'greeting.txt'), 'hello');
    sh(root, ['git', 'add', 'greeting.txt']);
    sh(root, ['git', 'commit', '-q', '-m', 'feat: greeting']);
    ok(root, ['done', 'implement', '--by', 'implementer']);

    assert.equal(genie(root, ['gate', 'slice.verified', '--run']).status, 2, 'test fails without `fixed`');
    view = nextJson(root);
    assert.equal(view.action.stage, 'implement');
    assert.equal(view.feedback.gate, 'slice.verified');
    assert.match(view.feedback.note, /commands\.test failed/);
    assert.ok(view.feedback.evidence.some((e: string) => e.endsWith('slice.verified.1.commands-test.log')));

    writeFileSync(join(root, 'fixed'), '');
    sh(root, ['git', 'add', 'fixed']);
    sh(root, ['git', 'commit', '-q', '-m', 'fix: make tests pass']);
    ok(root, ['done', 'implement', '--by', 'implementer']);
    assert.equal(nextJson(root).feedback, undefined, 'feedback clears once the rework is done');
    assert.equal(genie(root, ['gate', 'slice.verified', '--run']).status, 0);
    assert.equal(nextJson(root).action.evaluator, 'adversarial-reviewer');
  });
});
