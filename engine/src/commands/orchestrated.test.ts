import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../cli.ts', import.meta.url));

function sh(cwd: string, cmd: string[]) {
  const res = spawnSync(cmd[0]!, cmd.slice(1), { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `${cmd.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'genie-orch-'));
  sh(root, ['git', 'init', '-q', '-b', 'main']);
  sh(root, ['git', 'config', 'user.email', 'test@example.com']);
  sh(root, ['git', 'config', 'user.name', 'test']);
  // The test command fails in any checkout containing a file named `broken`.
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'test ! -f broken' } }));
  writeFileSync(join(root, 'shared.txt'), 'base\n');
  sh(root, ['git', 'add', '-A']);
  sh(root, ['git', 'commit', '-q', '-m', 'init']);
  return root;
}

const env = (root: string) => ({ ...process.env, GENIE_HOME: join(root, '.genie-home') });

function genie(cwd: string, root: string, args: string[]) {
  return spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8', env: env(root) });
}

function ok(root: string, args: string[], cwd = root) {
  const res = genie(cwd, root, args);
  assert.equal(res.status, 0, `genie ${args.join(' ')}: ${res.stderr}${res.stdout}`);
  return res.stdout;
}

/** Runs genie asynchronously, so several can race for the run lock. */
function genieAsync(cwd: string, root: string, args: string[]): Promise<{ status: number | null; stderr: string }> {
  return new Promise((done) => {
    const child = spawn('node', [CLI, ...args], { cwd, env: env(root) });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => done({ status, stderr }));
  });
}

const nextJson = (root: string) => JSON.parse(ok(root, ['next', '--json']));

function commit(cwd: string, file: string, text: string, message: string) {
  writeFileSync(join(cwd, file), text);
  sh(cwd, ['git', 'add', file]);
  sh(cwd, ['git', 'commit', '-q', '-m', message]);
}

function review(root: string, dir: string, slice: string) {
  const findings = join(dir, 'review', `slice.reviewed.${slice}.md`);
  mkdirSync(join(dir, 'review'), { recursive: true });
  writeFileSync(findings, 'No blocking findings.');
  return ok(root, ['gate', 'slice.reviewed', '--slice', slice, '--verdict', 'pass', '--by', 'adversarial-reviewer', '--findings', findings]);
}

/** Orchestrated runs have the plan-reviewer agent decide plan.approved. */
function planReview(root: string, dir: string) {
  const findings = join(dir, 'review', 'plan.approved.md');
  mkdirSync(join(dir, 'review'), { recursive: true });
  writeFileSync(findings, 'The slices cover R1-R3 and the DAG is sound.');
  return ok(root, ['gate', 'plan.approved', '--verdict', 'pass', '--by', 'plan-reviewer', '--findings', findings]);
}

describe('orchestrated run through the CLI', () => {
  it('runs ready slices in parallel worktrees, merges them, and routes conflicts back', async () => {
    const root = repo();
    ok(root, ['init', '--profile', 'internal-tool']);
    ok(root, ['new', '--mode', 'orchestrated', 'Three parts']);
    let view = nextJson(root);
    const dir: string = view.run.dir;
    const branch: string = view.run.branch;

    writeFileSync(join(dir, 'spec.md'), '# spec\n\n- R1: one\n- R2: two\n- R3: three\n');
    ok(root, ['done', 'spec']);
    ok(root, ['approve', 'spec.approved']);
    const slice = (id: string, covers: string, depends_on: string[] = []) => ({
      id, title: `Part ${id}`, goal: `Write ${id}`, covers: [covers], tests: ['it exists'], depends_on,
    });
    writeFileSync(join(dir, 'plan.yaml'), JSON.stringify({ slices: [slice('S1', 'R1'), slice('S2', 'R2'), slice('S3', 'R3', ['S1', 'S2'])] }));
    ok(root, ['done', 'decompose']);
    assert.deepEqual(nextJson(root).action, { type: 'evaluate', gate: 'plan.approved', kind: 'agent', evaluator: 'plan-reviewer' });
    assert.notEqual(genie(root, root, ['approve', 'plan.approved']).status, 0, 'an agent gate in orchestrated mode');
    planReview(root, dir);

    // S1 and S2 are independent: both are dispatched, each in its own worktree off the run branch.
    view = nextJson(root);
    assert.equal(view.parallel, 4);
    assert.deepEqual(view.actions.map((a: { action: { slice: { id: string } } }) => a.action.slice.id), ['S1', 'S2']);
    const [w1, w2] = view.actions.map((a: { worktree: { path: string; branch: string; base: string } }) => a.worktree);
    assert.deepEqual([w1.branch, w2.branch, w1.base], [`${branch}--S1`, `${branch}--S2`, branch]);
    assert.ok(existsSync(join(w1.path, 'shared.txt')));
    assert.equal(sh(root, ['git', 'branch', '--show-current']), 'main', "the user's checkout is left alone");
    assert.deepEqual(nextJson(root).actions[1].worktree, w2, 'dispatch is idempotent');

    const premature = genie(root, root, ['done', 'implement', '--slice', 'S1', '--by', 'implementer']);
    assert.match(premature.stderr, /no commits ahead of genie\/.*; commit slice S1's work in/);

    // Both slices change the same line, so whichever lands second conflicts.
    commit(w1.path, 'shared.txt', 'one\n', 'feat: one');
    commit(w2.path, 'shared.txt', 'two\n', 'feat: two');
    // Both finish at once (one from inside its worktree): the run lock keeps both updates.
    const results = await Promise.all([
      genieAsync(root, root, ['done', 'implement', '--slice', 'S1', '--by', 'implementer']),
      genieAsync(w2.path, root, ['done', 'implement', '--slice', 'S2', '--by', 'implementer']),
    ]);
    assert.deepEqual(results.map((r) => r.status), [0, 0], results.map((r) => r.stderr).join('\n'));

    // Automated checks run in the slice's worktree.
    writeFileSync(join(w2.path, 'broken'), '');
    assert.equal(genie(root, root, ['gate', 'slice.verified', '--slice', 'S1', '--run']).status, 0);
    assert.equal(genie(root, root, ['gate', 'slice.verified', '--slice', 'S2', '--run']).status, 2, 'S2 checks see its own tree');
    view = nextJson(root);
    const s2 = view.actions.find((a: { action: { slice: { id: string } } }) => a.action.slice.id === 'S2');
    assert.equal(s2.feedback.gate, 'slice.verified');
    sh(w2.path, ['rm', 'broken']);
    ok(root, ['done', 'implement', '--slice', 'S2', '--by', 'implementer']);
    ok(root, ['gate', 'slice.verified', '--slice', 'S2', '--run']);

    // S1 passes review and lands on the run branch; its worktree goes away.
    review(root, dir, 'S1');
    assert.equal(sh(root, ['git', 'show', `${branch}:shared.txt`]), 'one');
    assert.ok(!existsSync(w1.path));
    assert.match(sh(root, ['git', 'log', '-1', '--format=%s', branch]), /^Merge slice S1: Part S1$/);

    // S2 passes review but conflicts with S1, so it goes back to its implementer with the files.
    review(root, dir, 'S2');
    view = nextJson(root);
    assert.deepEqual(view.actions.map((a: { action: { slice: { id: string } } }) => a.action.slice.id), ['S2']);
    assert.deepEqual(view.feedback.conflict, ['shared.txt']);
    assert.deepEqual(view.worktree, w2);
    assert.match(ok(root, ['next']), /Reworking after a merge conflict: merge conflict onto genie\/.* in shared\.txt/);

    // The implementer merges the run branch into its slice and resolves the conflict.
    spawnSync('git', ['merge', branch], { cwd: w2.path });
    commit(w2.path, 'shared.txt', 'one\ntwo\n', 'merge run branch');
    ok(root, ['done', 'implement', '--slice', 'S2', '--by', 'implementer']);
    ok(root, ['gate', 'slice.verified', '--slice', 'S2', '--run']);
    review(root, dir, 'S2');
    assert.equal(sh(root, ['git', 'show', `${branch}:shared.txt`]), 'one\ntwo');

    // S3 depended on both, so its worktree starts from the run branch with their work in it.
    view = nextJson(root);
    assert.equal(view.action.slice.id, 'S3');
    assert.equal(readFileSync(join(view.worktree.path, 'shared.txt'), 'utf8'), 'one\ntwo\n');
    commit(view.worktree.path, 'three.txt', '3\n', 'feat: three');
    ok(root, ['done', 'implement', '--slice', 'S3', '--by', 'implementer']);
    ok(root, ['gate', 'slice.verified', '--slice', 'S3', '--run']);
    review(root, dir, 'S3');

    // With every slice landed, the run moves on and nothing is left behind.
    view = nextJson(root);
    assert.equal(view.run.stage, 'integrate');
    assert.ok(!existsSync(join(root, '.genie', 'worktrees', view.run.id)));
    assert.equal(sh(root, ['git', 'worktree', 'list']).split('\n').length, 1);
    assert.equal(sh(root, ['git', 'for-each-ref', '--format=%(refname:short)', `refs/heads/${branch}--*`]), '');
    const status = ok(root, ['status']);
    assert.match(status, /✓ S2 .*slice\.verified:pass\(1✗\)/);
    const events = readFileSync(join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).type);
    assert.equal(events.filter((t) => t === 'slice.merged').length, 3);
    assert.ok(events.includes('worktrees.pruned'));
  });

  it('switches modes and keeps unmerged work when aborted', () => {
    const root = repo();
    ok(root, ['init', '--profile', 'internal-tool']);
    ok(root, ['new', 'One part']);
    assert.match(ok(root, ['mode', 'orchestrated']), /\[active, orchestrated\]/);
    const dir = nextJson(root).run.dir;
    writeFileSync(join(dir, 'spec.md'), '# spec\n\n- R1: one\n');
    ok(root, ['done', 'spec']);
    ok(root, ['approve', 'spec.approved']);
    writeFileSync(join(dir, 'plan.yaml'), JSON.stringify({ slices: [{ id: 'S1', title: 'One', goal: 'g', covers: ['R1'], tests: ['t'], depends_on: [] }] }));
    ok(root, ['done', 'decompose']);
    planReview(root, dir);
    const wt = nextJson(root).worktree;
    commit(wt.path, 'one.txt', '1\n', 'feat: one');

    const aborted = ok(root, ['abort', '--note', 'changed my mind']);
    assert.match(aborted, /note: kept the run's worktrees in .*has commits not merged/);
    assert.ok(existsSync(join(wt.path, 'one.txt')), 'unmerged work is never deleted');
  });

  it('escalates a slice past its iteration budget, and pauses the run when the status line reports it over its cost budget', () => {
    const root = repo();
    ok(root, ['init', '--profile', 'internal-tool']);
    appendFileSync(join(root, '.genie', 'config.yaml'), 'budgets:\n  max_iterations_per_slice: 1\n  max_cost_usd: 5\n');
    ok(root, ['new', '--mode', 'orchestrated', 'One part']);
    const dir = nextJson(root).run.dir;
    writeFileSync(join(dir, 'spec.md'), '# spec\n\n- R1: one\n');
    ok(root, ['done', 'spec']);
    ok(root, ['approve', 'spec.approved']);
    writeFileSync(join(dir, 'plan.yaml'), JSON.stringify({ slices: [{ id: 'S1', title: 'One', goal: 'g', covers: ['R1'], tests: ['t'], depends_on: [] }] }));
    ok(root, ['done', 'decompose']);
    planReview(root, dir);

    // The first round fails its checks, and that was the slice's only round: a human decides.
    const wt = nextJson(root).worktree;
    commit(wt.path, 'broken', 'x\n', 'feat: one, broken');
    ok(root, ['done', 'implement', '--slice', 'S1', '--by', 'implementer'], wt.path);
    assert.equal(genie(root, root, ['gate', 'slice.verified', '--slice', 'S1', '--run']).status, 2);
    let view = nextJson(root);
    assert.equal(view.action.type, 'await_human');
    assert.equal(view.action.gate, 'slice.verified');
    const log = readFileSync(join(dir, 'log.jsonl'), 'utf8');
    assert.match(log, /slice S1 used its budget of 1 rounds of work/);

    // A human rejection gives the slice a fresh budget.
    ok(root, ['approve', 'slice.verified', '--slice', 'S1', '--reject', '--note', 'try again']);
    assert.equal(nextJson(root).action.type, 'work');

    // Cost arrives through the status line; over the limit, nothing new starts until a human says so.
    const status = (usd: number) =>
      spawnSync('node', [CLI, 'statusline'], {
        cwd: tmpdir(),
        encoding: 'utf8',
        env: env(root),
        input: JSON.stringify({ workspace: { current_dir: root }, session_id: 'sess-1', cost: { total_cost_usd: usd } }),
      }).stdout;
    assert.match(status(2), /implement\/work S1/);
    assert.match(status(6.5), /over budget · ⏸ \/genie:approve budget/);
    view = nextJson(root);
    assert.deepEqual(view.action, { type: 'over_budget', reason: 'spent $6.50, over the $5.00 budget' });
    assert.match(ok(root, ['status']), /budget: \dm of 4h · \$6\.50 of \$5\.00 · paused/);
    assert.match(genie(root, root, ['approve', 'budget', '--reject']).stderr, /abort it/);
    ok(root, ['approve', 'budget']);
    assert.equal(nextJson(root).action.type, 'work');
    assert.match(readFileSync(join(dir, 'log.jsonl'), 'utf8'), /"type":"budget.extended","by":"human"/);
  });
});
