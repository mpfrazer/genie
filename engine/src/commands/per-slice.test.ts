import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { grant } from './test-helpers.ts';

const CLI = fileURLToPath(new URL('../cli.ts', import.meta.url));

// A stand-in for `gh`, backed by the bare repo that serves as origin. It keeps its PRs in
// <origin>/prs.json and squash-merges them there, the way GitHub would.
const FAKE_GH = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const origin = git(process.cwd(), ['remote', 'get-url', 'origin']).stdout.trim();
const store = origin + '/prs.json';
const prs = existsSync(store) ? JSON.parse(readFileSync(store, 'utf8')) : [];
const save = () => writeFileSync(store, JSON.stringify(prs));
const [group, verb, ...rest] = process.argv.slice(2);
const flag = (name) => rest[rest.indexOf(name) + 1];
const find = (sel) => [...prs].reverse().find((p) => String(p.number) === sel || p.headRefName === sel);
const mergeable = (p) => git(origin, ['merge-tree', '--write-tree', 'refs/heads/' + p.baseRefName, 'refs/heads/' + p.headRefName]);
if (group === 'repo' && verb === 'view') {
  console.log(JSON.stringify({ squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: false }));
} else if (group === 'pr' && verb === 'create') {
  const number = prs.length + 1;
  const pr = { number, url: 'https://github.test/pr/' + number, state: 'OPEN', title: flag('--title'), baseRefName: flag('--base'), headRefName: flag('--head') };
  prs.push(pr);
  save();
  console.log(pr.url);
} else if (group === 'pr' && verb === 'view') {
  const pr = find(rest[0]);
  if (!pr) { console.error('no pull requests found for branch "' + rest[0] + '"'); process.exit(1); }
  const state = pr.state === 'OPEN' ? (mergeable(pr).status === 0 ? 'MERGEABLE' : 'CONFLICTING') : 'UNKNOWN';
  console.log(JSON.stringify({ ...pr, mergeable: state, mergeCommit: pr.mergeCommit ? { oid: pr.mergeCommit } : null }));
} else if (group === 'pr' && verb === 'merge') {
  const pr = find(rest[0]);
  const tree = mergeable(pr);
  if (tree.status !== 0) { console.error('Pull request is not mergeable'); process.exit(1); }
  const env = { ...process.env, GIT_AUTHOR_NAME: 'gh', GIT_AUTHOR_EMAIL: 'gh@test', GIT_COMMITTER_NAME: 'gh', GIT_COMMITTER_EMAIL: 'gh@test' };
  const commit = spawnSync('git', ['commit-tree', tree.stdout.split('\\n')[0], '-p', 'refs/heads/' + pr.baseRefName, '-m', pr.title + ' (#' + pr.number + ')'], { cwd: origin, encoding: 'utf8', env }).stdout.trim();
  git(origin, ['update-ref', 'refs/heads/' + pr.baseRefName, commit]);
  pr.state = 'MERGED';
  pr.mergeCommit = commit;
  save();
}
`;

function sh(cwd: string, cmd: string[]) {
  const res = spawnSync(cmd[0]!, cmd.slice(1), { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `${cmd.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

/** A repo whose origin is a local bare repo, with the fake gh first on PATH. */
function repo(): { root: string; origin: string } {
  const base = mkdtempSync(join(tmpdir(), 'genie-perslice-'));
  const origin = join(base, 'origin.git');
  const root = join(base, 'work');
  const bin = join(base, 'bin');
  mkdirSync(root);
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'gh'), 0o755);
  sh(base, ['git', 'init', '-q', '--bare', '-b', 'main', origin]);
  sh(root, ['git', 'init', '-q', '-b', 'main']);
  sh(root, ['git', 'config', 'user.email', 'test@example.com']);
  sh(root, ['git', 'config', 'user.name', 'test']);
  // The test command fails in any checkout containing a file named `broken`.
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'test ! -f broken' } }));
  writeFileSync(join(root, 'shared.txt'), 'base\n');
  sh(root, ['git', 'add', '-A']);
  sh(root, ['git', 'commit', '-q', '-m', 'init']);
  sh(root, ['git', 'remote', 'add', 'origin', origin]);
  sh(root, ['git', 'push', '-q', '-u', 'origin', 'main']);
  return { root, origin };
}

const env = (root: string) => ({
  ...process.env,
  GENIE_HOME: join(root, '.genie-home'),
  PATH: `${join(root, '..', 'bin')}:${process.env.PATH}`,
});

function genie(cwd: string, root: string, args: string[]) {
  if (args[0] === 'approve' || args[0] === 'abort') grant(cwd, join(root, '.genie-home'), args);
  return spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8', env: env(root) });
}

function ok(root: string, args: string[], cwd = root) {
  const res = genie(cwd, root, args);
  assert.equal(res.status, 0, `genie ${args.join(' ')}: ${res.stderr}${res.stdout}`);
  return res.stdout;
}

const nextJson = (root: string) => JSON.parse(ok(root, ['next', '--json']));

/** The actions `next` offers, as `<slice>:<work stage or gate>`. */
const offered = (root: string) =>
  nextJson(root).actions.map((a: { action: { slice?: { id: string }; stage?: string; gate?: string; type: string } }) =>
    `${a.action.slice?.id ?? 'run'}:${a.action.type === 'work' ? a.action.stage : a.action.gate}`,
  );

function commit(cwd: string, file: string, text: string, message: string) {
  writeFileSync(join(cwd, file), text);
  sh(cwd, ['git', 'add', file]);
  sh(cwd, ['git', 'commit', '-q', '-m', message]);
}

function agentVerdict(root: string, dir: string, gate: string, by: string, verdict: string, slice?: string) {
  const findings = join(dir, 'review', `${gate}.${slice ?? 'run'}.md`);
  mkdirSync(join(dir, 'review'), { recursive: true });
  writeFileSync(findings, `${verdict}: reviewed.`);
  return ok(root, ['gate', gate, ...(slice ? ['--slice', slice] : []), '--verdict', verdict, '--by', by, '--findings', findings]);
}

function hook(root: string, command: string, cwd = root) {
  const out = spawnSync('node', [CLI, 'hook', 'pre-tool-use'], {
    cwd: root,
    encoding: 'utf8',
    env: env(root),
    input: JSON.stringify({ cwd, tool_name: 'Bash', tool_input: { command } }),
  }).stdout;
  return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'allow';
}

/** Takes a slice through implement, verify, and review, starting in its worktree. */
function build(root: string, dir: string, id: string, file: string, text: string) {
  const wt = nextJson(root).actions.find((a: { action: { slice?: { id: string } } }) => a.action.slice?.id === id).worktree;
  commit(wt.path, file, text, `feat: ${id}`);
  ok(root, ['done', 'implement', '--slice', id, '--by', 'implementer']);
  ok(root, ['gate', 'slice.verified', '--slice', id, '--run']);
  agentVerdict(root, dir, 'slice.reviewed', 'adversarial-reviewer', 'pass', id);
  return wt as { path: string; branch: string; base: string };
}

/** Pushes the slice's branch, opens (or reuses) its PR, and checks it: CI, then the intent reviewer. */
function openPr(root: string, dir: string, id: string, wt: { path: string; branch: string }) {
  sh(wt.path, ['git', 'push', '-q', '-u', 'origin', wt.branch]);
  if (spawnSync('gh', ['pr', 'view', wt.branch], { cwd: wt.path, env: env(root) }).status !== 0) {
    spawnSync('gh', ['pr', 'create', '--base', 'main', '--head', wt.branch, '--title', `feat: ${id}`], { cwd: wt.path, env: env(root) });
  }
  ok(root, ['done', 'pr', '--slice', id]);
  ok(root, ['gate', 'pr.ready', '--slice', id, '--run']);
  agentVerdict(root, dir, 'intent.reviewed', 'intent-reviewer', 'pass', id);
}

const onOrigin = (origin: string, file: string) => sh(origin, ['git', 'show', `main:${file}`]);

describe('a PR per slice (forge.pr_per: slice)', () => {
  it('opens, checks, approves, and merges each slice on its own, then reviews the whole run', () => {
    const { root, origin } = repo();
    ok(root, ['init', '--profile', 'internal-tool']);
    appendFileSync(
      join(root, '.genie', 'config.yaml'),
      'gates:\n  intent.reviewed:\n    enabled: true\n',
    );
    const config = readFileSync(join(root, '.genie', 'config.yaml'), 'utf8').replace('provider: none', 'provider: github').replace('forge:\n', 'forge:\n  pr_per: slice\n  ci_command: "true"\n');
    writeFileSync(join(root, '.genie', 'config.yaml'), config);
    ok(root, ['new', '--mode', 'orchestrated', 'Three parts']);
    const dir: string = nextJson(root).run.dir;
    writeFileSync(join(dir, 'spec.md'), '# spec\n\n- R1: one\n- R2: two\n- R3: three\n');
    ok(root, ['done', 'spec']);
    ok(root, ['approve', 'spec.approved']);
    const slice = (id: string, covers: string, depends_on: string[] = []) => ({
      id, title: `Part ${id}`, goal: `Write ${id}`, covers: [covers], tests: ['it exists'], depends_on,
    });
    writeFileSync(join(dir, 'plan.yaml'), JSON.stringify({ slices: [slice('S1', 'R1'), slice('S2', 'R2'), slice('S3', 'R3', ['S1'])] }));
    ok(root, ['done', 'decompose']);
    agentVerdict(root, dir, 'plan.approved', 'plan-reviewer', 'pass');

    // The independent slices start from main on origin; the run gets no branch of its own.
    let view = nextJson(root);
    assert.equal(view.run.delivery, 'slice');
    assert.equal(view.run.since, sh(root, ['git', 'rev-parse', 'origin/main']));
    assert.deepEqual(offered(root), ['S1:implement', 'S2:implement']);
    assert.equal(view.worktree.base, 'origin/main');
    assert.equal(spawnSync('git', ['rev-parse', '--verify', '--quiet', view.run.branch], { cwd: root }).status, 1);

    // Both change the same line, so whichever merges second conflicts.
    const w1 = build(root, dir, 'S1', 'shared.txt', 'one\n');
    const w2 = build(root, dir, 'S2', 'shared.txt', 'two\n');
    assert.deepEqual(offered(root), ['S1:pr', 'S2:pr']);
    assert.match(ok(root, ['next']), /Work on pr slice S1 \(Part S1\): Push this slice's branch and open .* into main\.\n  then: genie done pr --slice S1/);

    // While their PRs are being opened, only those slices' branches may be pushed.
    assert.equal(hook(root, `git -C ${w1.path} push -u origin ${w1.branch}`), 'allow');
    assert.equal(hook(root, 'git push -u origin HEAD', w2.path), 'allow');
    assert.equal(hook(root, `git push origin ${w1.branch} ${view.run.branch}`), 'deny');
    assert.equal(hook(root, 'git push origin main'), 'deny');
    assert.equal(hook(root, 'gh pr create --fill'), 'allow');
    assert.equal(hook(root, 'gh pr merge 1 --squash'), 'deny', 'only the engine merges slice PRs');

    assert.match(genie(root, root, ['done', 'pr', '--slice', 'S1']).stderr, /isn't on origin yet; push it first/);
    sh(w1.path, ['git', 'push', '-q', '-u', 'origin', w1.branch]);
    assert.match(genie(root, root, ['done', 'pr', '--slice', 'S1']).stderr, /no open pull request for .*--S1; open one into main first/);
    openPr(root, dir, 'S1', w1);
    openPr(root, dir, 'S2', w2);
    assert.match(genie(root, root, ['mode', 'guided']).stderr, /opens a PR per slice, which needs orchestrated mode until every slice has merged into main/);

    // Each PR waits for the user, who sees where it is.
    view = nextJson(root);
    assert.deepEqual(offered(root), ['S1:pr.approved', 'S2:pr.approved']);
    assert.deepEqual(view.action.slice.pr, { number: 1, url: 'https://github.test/pr/1' });
    assert.match(ok(root, ['next']), /Waiting for a human decision on pr\.approved slice S1 \(Part S1\): .*\n  PR: https:\/\/github\.test\/pr\/1\n  human: \/genie:approve pr\.approved --slice S1/);
    assert.match(ok(root, ['status']), /S1 +review .*pr\.ready:pass  intent\.reviewed:pass  pr\.approved:pending  Part S1\n +PR https:\/\/github\.test\/pr\/1\n/);

    // Approving S1 merges its PR into main; S3, which depends on it, starts from there.
    ok(root, ['approve', 'pr.approved', '--slice', 'S1']);
    assert.equal(onOrigin(origin, 'shared.txt'), 'one');
    assert.match(sh(origin, ['git', 'log', '-1', '--format=%s', 'main']), /^feat: S1 \(#1\)$/);
    assert.ok(!existsSync(w1.path));
    assert.equal(spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${w1.branch}`], { cwd: origin }).status, 1, 'remote branch deleted');
    assert.deepEqual(offered(root), ['S2:pr.approved', 'S3:implement']);
    const w3 = nextJson(root).actions[1].worktree;
    assert.equal(readFileSync(join(w3.path, 'shared.txt'), 'utf8'), 'one\n');

    // S2's PR now conflicts with main: back to its implementer, and its PR is checked and approved again.
    ok(root, ['approve', 'pr.approved', '--slice', 'S2']);
    view = nextJson(root);
    assert.deepEqual(offered(root), ['S2:implement', 'S3:implement']);
    assert.deepEqual(view.feedback.conflict, ['shared.txt']);
    assert.match(ok(root, ['next']), /Reworking after a merge conflict: merge conflict onto main in shared\.txt/);
    assert.match(ok(root, ['status']), /S2 +work +slice\.verified:pending  slice\.reviewed:pending  pr\.ready:pending  intent\.reviewed:pending  pr\.approved:pending/);
    sh(w2.path, ['git', 'fetch', '-q', 'origin']);
    spawnSync('git', ['merge', 'origin/main'], { cwd: w2.path });
    commit(w2.path, 'shared.txt', 'one\ntwo\n', 'merge main');
    ok(root, ['done', 'implement', '--slice', 'S2', '--by', 'implementer']);
    ok(root, ['gate', 'slice.verified', '--slice', 'S2', '--run']);
    agentVerdict(root, dir, 'slice.reviewed', 'adversarial-reviewer', 'pass', 'S2');
    openPr(root, dir, 'S2', w2);
    ok(root, ['approve', 'pr.approved', '--slice', 'S2']);
    assert.equal(onOrigin(origin, 'shared.txt'), 'one\ntwo');

    build(root, dir, 'S3', 'three.txt', '3\n');
    openPr(root, dir, 'S3', w3);
    ok(root, ['approve', 'pr.approved', '--slice', 'S3']);

    // Every slice merged: integrate brings the main checkout up to date, and the suite runs there.
    view = nextJson(root);
    assert.equal(view.run.stage, 'integrate');
    assert.match(view.action.instructions, /Every slice has merged into main/);
    assert.equal(sh(root, ['git', 'worktree', 'list']).split('\n').length, 1);
    sh(root, ['git', 'pull', '-q', '--ff-only', 'origin', 'main']);
    ok(root, ['done', 'integrate']);
    ok(root, ['gate', 'integration.verified', '--run']);

    // The final intent review covers everything that merged. What it finds is fixed by a fix-up slice with its own PR.
    assert.deepEqual(offered(root), ['run:intent.reviewed']);
    agentVerdict(root, dir, 'intent.reviewed', 'intent-reviewer', 'fail');
    view = nextJson(root);
    assert.equal(view.run.stage, 'implement');
    assert.deepEqual(offered(root), ['F1:implement']);
    assert.equal(view.feedback.gate, 'intent.reviewed');
    assert.equal(view.worktree.base, 'origin/main');
    const f1 = build(root, dir, 'F1', 'fix.txt', 'fixed\n');
    openPr(root, dir, 'F1', f1);
    ok(root, ['approve', 'pr.approved', '--slice', 'F1']);
    assert.equal(onOrigin(origin, 'fix.txt'), 'fixed');

    sh(root, ['git', 'pull', '-q', '--ff-only', 'origin', 'main']);
    ok(root, ['done', 'integrate']);
    ok(root, ['gate', 'integration.verified', '--run']);
    agentVerdict(root, dir, 'intent.reviewed', 'intent-reviewer', 'pass');

    // No run PR to open or merge: those stages say why they were skipped.
    view = nextJson(root);
    assert.equal(view.run.stage, 'build');
    const log = readFileSync(join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(log.some((e) => e.type === 'gate.skipped' && e.gate === 'pr.ready' && e.note === "checked on each slice's PR"));
    assert.ok(log.some((e) => e.type === 'stage.skipped' && e.stage === 'merge' && e.note === 'each slice merged through its own PR'));
    assert.equal(log.filter((e) => e.type === 'slice.merged').length, 4);
    assert.ok(log.some((e) => e.type === 'gate.verdict' && e.gate === 'pr.approved' && e.slice === 'S2' && e.by === 'human' && e.grant));
  });

  it('keeps one PR for the run when guided mode already started its slices', () => {
    const { root } = repo();
    ok(root, ['init', '--profile', 'internal-tool']);
    appendFileSync(join(root, '.genie', 'config.yaml'), 'mode:\n  default: guided\n');
    const config = readFileSync(join(root, '.genie', 'config.yaml'), 'utf8').replace('provider: none', 'provider: github').replace('forge:\n', 'forge:\n  pr_per: slice\n');
    writeFileSync(join(root, '.genie', 'config.yaml'), config);
    ok(root, ['new', 'Two parts']);
    const view = nextJson(root);
    const dir: string = view.run.dir;
    writeFileSync(join(dir, 'spec.md'), '# spec\n\n- R1: one\n- R2: two\n');
    ok(root, ['done', 'spec']);
    ok(root, ['approve', 'spec.approved']);
    const slice = (id: string, covers: string) => ({ id, title: id, goal: id, covers: [covers], tests: ['t'], depends_on: [] });
    writeFileSync(join(dir, 'plan.yaml'), JSON.stringify({ slices: [slice('S1', 'R1'), slice('S2', 'R2')] }));
    ok(root, ['done', 'decompose']);
    ok(root, ['approve', 'plan.approved']);

    // Guided mode works S1 on the run branch, then the user switches to orchestrated.
    sh(root, ['git', 'switch', '-q', '-c', view.run.branch]);
    commit(root, 'one.txt', '1\n', 'feat: one');
    ok(root, ['done', 'implement', '--slice', 'S1']);
    ok(root, ['mode', 'orchestrated']);
    const after = nextJson(root);
    assert.equal(after.run.delivery, 'run');
    const s2 = after.actions.find((a: { action: { slice?: { id: string } } }) => a.action.slice?.id === 'S2');
    assert.equal(s2.worktree.base, view.run.branch);
    assert.match(readFileSync(join(dir, 'log.jsonl'), 'utf8'), /"type":"run.delivery".*one PR for the run: slices were already worked on/);
  });
});
