import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  createSliceWorktree,
  listSliceWorktrees,
  mergeSlice,
  pruneRunWorktrees,
  removeSliceWorktree,
  sliceBranch,
  type RunRef,
} from './worktree.ts';

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

const RUN: RunRef = { id: '20261023-120000-add-greeting', branch: 'genie/20261023-120000-add-greeting' };

/** A repo on main with one commit, plus the run branch checked out like guided mode leaves it. */
function repo(opts: { checkoutRun?: boolean } = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'genie-wt-')));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'test');
  mkdirSync(join(root, '.genie'));
  writeFileSync(join(root, '.genie', '.gitignore'), 'runs/\nworktrees/\n');
  writeFileSync(join(root, 'shared.txt'), 'base\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'branch', RUN.branch);
  if (opts.checkoutRun ?? true) git(root, 'switch', '-q', RUN.branch);
  return root;
}

function commitIn(path: string, file: string, contents: string, message = `edit ${file}`): void {
  writeFileSync(join(path, file), contents);
  git(path, 'add', file);
  git(path, 'commit', '-q', '-m', message);
}

describe('sliceBranch', () => {
  it('appends --<slice> so it never nests under the run branch', () => {
    assert.equal(sliceBranch(RUN.branch, 'S1'), `${RUN.branch}--S1`);
  });

  it('rejects ids that are unsafe or ambiguous', () => {
    for (const bad of ['', '-S1', 'S--1', 'a/b', 'S 1', '_integration', 'S1.lock~']) {
      assert.throws(() => sliceBranch(RUN.branch, bad), /invalid slice id/, bad);
    }
  });
});

describe('createSliceWorktree / listSliceWorktrees', () => {
  it('creates a worktree on a new slice branch from the run tip, idempotently', () => {
    const root = repo();
    const runTip = git(root, 'rev-parse', RUN.branch);
    const wt = createSliceWorktree(root, RUN, 'S1');
    assert.equal(wt.path, join(root, '.genie', 'worktrees', RUN.id, 'S1'));
    assert.equal(wt.branch, `${RUN.branch}--S1`);
    assert.equal(wt.head, runTip);
    assert.equal(wt.dirty, false);
    assert.deepEqual(createSliceWorktree(root, RUN, 'S1'), wt);
  });

  it('lists slices sorted, with dirty status, and leaves the main checkout clean', () => {
    const root = repo();
    for (const s of ['S10', 'S2', 'S1']) createSliceWorktree(root, RUN, s);
    writeFileSync(join(root, '.genie', 'worktrees', RUN.id, 'S2', 'wip.txt'), 'wip');
    const list = listSliceWorktrees(root, RUN);
    assert.deepEqual(list.map((w) => [w.slice, w.dirty]), [['S1', false], ['S2', true], ['S10', false]]);
    assert.equal(git(root, 'status', '--porcelain'), '');
    assert.deepEqual(listSliceWorktrees(root, { id: 'other', branch: 'genie/other' }), []);
  });

  it('reuses an existing slice branch after its worktree was removed', () => {
    const root = repo();
    const wt = createSliceWorktree(root, RUN, 'S1');
    commitIn(wt.path, 'a.txt', 'a');
    const head = git(wt.path, 'rev-parse', 'HEAD');
    git(root, 'worktree', 'remove', wt.path);
    assert.equal(createSliceWorktree(root, RUN, 'S1').head, head);
  });

  it('fails clearly when the run branch is missing', () => {
    const root = repo();
    assert.throws(() => createSliceWorktree(root, { id: 'x', branch: 'genie/x' }, 'S1'), /run branch genie\/x doesn't exist/);
  });
});

describe('mergeSlice', () => {
  it('merges a slice with a merge commit where the run branch is checked out', () => {
    const root = repo();
    const wt = createSliceWorktree(root, RUN, 'S1');
    commitIn(wt.path, 'feature.txt', 'feature\n');
    const result = mergeSlice(root, RUN, 'S1');
    assert.equal(result.status, 'merged');
    assert.equal(result.worktree, root);
    assert.equal(git(root, 'rev-list', '--count', '--merges', `main..${RUN.branch}`), '1');
    assert.ok(existsSync(join(root, 'feature.txt')));
    assert.equal(mergeSlice(root, RUN, 'S1').status, 'up_to_date');
  });

  it('uses an integration worktree when the run branch is not checked out', () => {
    const root = repo({ checkoutRun: false });
    const wt = createSliceWorktree(root, RUN, 'S1');
    commitIn(wt.path, 'feature.txt', 'feature\n');
    const result = mergeSlice(root, RUN, 'S1');
    assert.equal(result.status, 'merged');
    assert.equal(result.worktree, join(root, '.genie', 'worktrees', RUN.id, '_integration'));
    assert.equal(git(root, 'symbolic-ref', '--short', 'HEAD'), 'main', 'user checkout untouched');
    assert.deepEqual(listSliceWorktrees(root, RUN).map((w) => w.slice), ['S1'], 'integration worktree is not a slice');
  });

  it('reports conflicting files and aborts, leaving everything recoverable', () => {
    const root = repo();
    const s1 = createSliceWorktree(root, RUN, 'S1');
    const s2 = createSliceWorktree(root, RUN, 'S2');
    commitIn(s1.path, 'shared.txt', 'from S1\n');
    commitIn(s2.path, 'shared.txt', 'from S2\n');
    assert.equal(mergeSlice(root, RUN, 'S1').status, 'merged');
    const runTip = git(root, 'rev-parse', RUN.branch);

    const result = mergeSlice(root, RUN, 'S2');
    assert.deepEqual(result, { status: 'conflict', files: ['shared.txt'], worktree: root });
    assert.equal(git(root, 'rev-parse', RUN.branch), runTip, 'run branch unchanged');
    assert.equal(git(root, 'status', '--porcelain'), '', 'no merge in progress, tree clean');
    assert.ok(!existsSync(join(root, '.git', 'MERGE_HEAD')));
  });

  it('refuses to merge a slice with uncommitted work', () => {
    const root = repo();
    const wt = createSliceWorktree(root, RUN, 'S1');
    commitIn(wt.path, 'a.txt', 'a');
    writeFileSync(join(wt.path, 'b.txt'), 'not committed');
    assert.throws(() => mergeSlice(root, RUN, 'S1'), /uncommitted changes/);
  });
});

describe('removeSliceWorktree', () => {
  it('refuses to delete unmerged or uncommitted work unless forced', () => {
    const root = repo();
    const wt = createSliceWorktree(root, RUN, 'S1');
    commitIn(wt.path, 'a.txt', 'a');
    assert.throws(() => removeSliceWorktree(root, RUN, 'S1'), /not merged into/);
    assert.ok(existsSync(wt.path), 'nothing removed on refusal');

    writeFileSync(join(wt.path, 'wip.txt'), 'wip');
    assert.throws(() => removeSliceWorktree(root, RUN, 'S1'), /uncommitted changes/);

    removeSliceWorktree(root, RUN, 'S1', { force: true });
    assert.ok(!existsSync(wt.path));
    assert.equal(git(root, 'branch', '--list', `${RUN.branch}--S1`), '');
  });

  it('removes a merged slice and its branch', () => {
    const root = repo();
    const wt = createSliceWorktree(root, RUN, 'S1');
    commitIn(wt.path, 'a.txt', 'a');
    mergeSlice(root, RUN, 'S1');
    removeSliceWorktree(root, RUN, 'S1');
    assert.ok(!existsSync(wt.path));
    assert.equal(git(root, 'branch', '--list', `${RUN.branch}--S1`), '');
  });
});

describe('pruneRunWorktrees', () => {
  it('checks every slice before removing anything, then prunes all of them', () => {
    const root = repo({ checkoutRun: false });
    const s1 = createSliceWorktree(root, RUN, 'S1');
    const s2 = createSliceWorktree(root, RUN, 'S2');
    commitIn(s1.path, 'a.txt', 'a');
    commitIn(s2.path, 'b.txt', 'b');
    mergeSlice(root, RUN, 'S1');

    assert.throws(() => pruneRunWorktrees(root, RUN), /--S2 has commits not merged/);
    assert.equal(listSliceWorktrees(root, RUN).length, 2, 'nothing removed on refusal');

    mergeSlice(root, RUN, 'S2');
    assert.deepEqual(pruneRunWorktrees(root, RUN).sort(), ['S1', 'S2']);
    assert.ok(!existsSync(join(root, '.genie', 'worktrees', RUN.id)), 'run worktree dir removed');
    assert.equal(git(root, 'worktree', 'list').split('\n').length, 1);
    assert.equal(git(root, 'for-each-ref', `refs/heads/${RUN.branch}--*`), '');
    assert.ok(git(root, 'rev-parse', RUN.branch), 'run branch kept');
  });

  it('force-prunes unmerged work', () => {
    const root = repo();
    const s1 = createSliceWorktree(root, RUN, 'S1');
    commitIn(s1.path, 'a.txt', 'a');
    assert.deepEqual(pruneRunWorktrees(root, RUN, { force: true }), ['S1']);
    assert.equal(listSliceWorktrees(root, RUN).length, 0);
  });
});
