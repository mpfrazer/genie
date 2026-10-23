// Per-slice git worktrees for orchestrated mode: each slice gets its own checkout and branch so
// implementers can work in parallel, and finished slices merge back onto the run branch.
//
// Layout and naming:
//   run branch     genie/<run-id>                      (state.branch)
//   slice branch   genie/<run-id>--<slice-id>          (sibling ref, never nested under the run branch)
//   slice worktree .genie/worktrees/<run-id>/<slice-id>
//   integration    .genie/worktrees/<run-id>/_integration (only when the run branch isn't checked out)
//
// Git can't hold both `genie/<run>` and `genie/<run>/S1` (a ref can't be both a file and a
// directory), so slice branches append `--<slice-id>`. Run ids never contain `--` (slugify
// collapses dash runs), so a slice branch can't be mistaken for another run's branch.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, rmdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { GenieError } from './errors.ts';
import type { RunState } from './state.ts';

export type RunRef = Pick<RunState, 'id' | 'branch'>;

export interface SliceWorktree {
  slice: string;
  path: string;
  branch: string;
  head: string;
  dirty: boolean;
}

export type MergeResult =
  | { status: 'merged'; commit: string; worktree: string }
  | { status: 'up_to_date'; worktree: string }
  | { status: 'conflict'; files: string[]; worktree: string };

const SLICE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9_]|-(?!-))*$/;
const INTEGRATION = '_integration';

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: string[]): GitResult {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: res.status === 0, stdout: (res.stdout ?? '').trim(), stderr: (res.stderr ?? '').trim() };
}

function gitOrThrow(cwd: string, args: string[], what: string): string {
  const res = git(cwd, args);
  if (!res.ok) throw new GenieError(`${what}: ${res.stderr || `git ${args.join(' ')} failed`}`);
  return res.stdout;
}

function branchExists(root: string, branch: string): boolean {
  return git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
}

function isAncestor(root: string, ancestor: string, of: string): boolean {
  return git(root, ['merge-base', '--is-ancestor', ancestor, of]).ok;
}

function realpath(path: string): string {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}

function validateSliceId(sliceId: string): void {
  if (!SLICE_ID.test(sliceId)) {
    throw new GenieError(`invalid slice id "${sliceId}" (letters, digits, _ and single dashes; must start alphanumeric)`);
  }
}

/** The branch a slice's work is committed on. */
export function sliceBranch(runBranch: string, sliceId: string): string {
  validateSliceId(sliceId);
  const branch = `${runBranch}--${sliceId}`;
  const check = spawnSync('git', ['check-ref-format', '--branch', branch], { encoding: 'utf8' });
  if (check.status !== 0) throw new GenieError(`"${branch}" is not a valid branch name`);
  return branch;
}

export function runWorktreesDir(root: string, runId: string): string {
  return join(root, '.genie', 'worktrees', runId);
}

export function worktreePath(root: string, runId: string, sliceId: string): string {
  validateSliceId(sliceId);
  return join(runWorktreesDir(root, runId), sliceId);
}

interface WorktreeEntry {
  path: string;
  head: string;
  branch?: string;
}

function worktreeEntries(root: string): WorktreeEntry[] {
  const out = gitOrThrow(root, ['worktree', 'list', '--porcelain'], 'listing worktrees');
  const entries: WorktreeEntry[] = [];
  for (const block of out.split('\n\n')) {
    const entry: Partial<WorktreeEntry> = {};
    for (const line of block.split('\n')) {
      const [key, ...rest] = line.split(' ');
      const value = rest.join(' ');
      if (key === 'worktree') entry.path = realpath(value);
      else if (key === 'HEAD') entry.head = value;
      else if (key === 'branch') entry.branch = value.replace(/^refs\/heads\//, '');
    }
    if (entry.path) entries.push({ head: '', ...entry } as WorktreeEntry);
  }
  return entries;
}

/** Uncommitted changes, including untracked files unless `trackedOnly` (losing those loses work). */
function isDirty(path: string, trackedOnly = false): boolean {
  const args = ['status', '--porcelain', ...(trackedOnly ? ['--untracked-files=no'] : [])];
  return gitOrThrow(path, args, `checking ${path}`) !== '';
}

function toSlice(entry: WorktreeEntry, slice: string): SliceWorktree {
  return { slice, path: entry.path, branch: entry.branch ?? '', head: entry.head, dirty: isDirty(entry.path) };
}

function findEntry(root: string, path: string): WorktreeEntry | undefined {
  const want = realpath(path);
  return worktreeEntries(root).find((e) => e.path === want);
}

/**
 * Creates (or returns) the worktree for a slice, on its slice branch. A new slice branch starts
 * from the run branch's current tip; an existing one (e.g. after its worktree was removed) is reused.
 */
export function createSliceWorktree(root: string, run: RunRef, sliceId: string): SliceWorktree {
  const branch = sliceBranch(run.branch, sliceId);
  const path = worktreePath(root, run.id, sliceId);
  const existing = findEntry(root, path);
  if (existing) {
    if (existing.branch !== branch) {
      throw new GenieError(`${path} is a worktree on ${existing.branch ?? 'a detached HEAD'}, expected ${branch}`);
    }
    return toSlice(existing, sliceId);
  }
  if (existsSync(path)) throw new GenieError(`${path} exists but isn't a git worktree; remove it first`);
  if (!branchExists(root, run.branch)) throw new GenieError(`run branch ${run.branch} doesn't exist`);

  const args = branchExists(root, branch)
    ? ['worktree', 'add', path, branch]
    : ['worktree', 'add', '-b', branch, path, run.branch];
  gitOrThrow(root, args, `creating worktree for slice ${sliceId}`);
  const created = findEntry(root, path);
  if (!created) throw new GenieError(`worktree for slice ${sliceId} wasn't registered`);
  return toSlice(created, sliceId);
}

/** The run's slice worktrees (excluding the integration worktree), sorted by slice id. */
export function listSliceWorktrees(root: string, run: RunRef): SliceWorktree[] {
  const dir = `${realpath(runWorktreesDir(root, run.id))}/`;
  return worktreeEntries(root)
    .filter((e) => e.path.startsWith(dir))
    .map((e) => ({ entry: e, slice: e.path.slice(dir.length) }))
    .filter(({ slice }) => slice !== INTEGRATION && !slice.includes('/'))
    .map(({ entry, slice }) => toSlice(entry, slice))
    .sort((a, b) => a.slice.localeCompare(b.slice, undefined, { numeric: true }));
}

/**
 * The worktree where merges onto the run branch happen. Git won't check a branch out twice, so
 * merges must happen wherever the run branch already lives (usually the main checkout in guided
 * mode). Otherwise a dedicated integration worktree is used, leaving the user's checkout untouched.
 */
function integrationWorktree(root: string, run: RunRef): string {
  const live = worktreeEntries(root).find((e) => e.branch === run.branch);
  if (live) return live.path;
  const path = join(runWorktreesDir(root, run.id), INTEGRATION);
  if (!branchExists(root, run.branch)) throw new GenieError(`run branch ${run.branch} doesn't exist`);
  gitOrThrow(root, ['worktree', 'add', path, run.branch], 'creating the integration worktree');
  return realpath(path);
}

/**
 * Merges a slice branch onto the run branch with a merge commit. On conflict the merge is
 * aborted, leaving both branches and worktrees exactly as they were, and the files are reported.
 */
export function mergeSlice(root: string, run: RunRef, sliceId: string, message?: string): MergeResult {
  const branch = sliceBranch(run.branch, sliceId);
  if (!branchExists(root, branch)) throw new GenieError(`slice branch ${branch} doesn't exist`);
  const sliceTree = findEntry(root, worktreePath(root, run.id, sliceId));
  if (sliceTree && isDirty(sliceTree.path)) {
    throw new GenieError(`slice ${sliceId} has uncommitted changes in ${sliceTree.path}; commit them before merging`);
  }

  const worktree = integrationWorktree(root, run);
  if (isAncestor(root, branch, run.branch)) return { status: 'up_to_date', worktree };
  // Untracked files (e.g. nested slice worktrees) don't block a merge; git refuses on its own if one
  // would be overwritten.
  if (isDirty(worktree, true)) {
    throw new GenieError(`can't merge onto ${run.branch}: ${worktree} has uncommitted changes`);
  }

  const merge = git(worktree, ['merge', '--no-ff', '--no-edit', '-m', message ?? `Merge slice ${sliceId}`, branch]);
  if (merge.ok) {
    return { status: 'merged', commit: gitOrThrow(worktree, ['rev-parse', 'HEAD'], 'reading merge commit'), worktree };
  }
  const files = git(worktree, ['diff', '--name-only', '--diff-filter=U']).stdout.split('\n').filter(Boolean);
  const aborted = git(worktree, ['merge', '--abort']);
  if (files.length === 0 || !aborted.ok) {
    throw new GenieError(`merging ${branch} into ${run.branch} failed: ${merge.stderr || merge.stdout}`);
  }
  return { status: 'conflict', files, worktree };
}

export interface RemoveOptions {
  /** Discard uncommitted changes and unmerged commits. */
  force?: boolean;
}

/**
 * Removes a slice's worktree, then its branch once merged into the run branch. Without `force`,
 * refuses (before changing anything) when the worktree is dirty or the branch has unmerged commits.
 */
export function removeSliceWorktree(root: string, run: RunRef, sliceId: string, opts: RemoveOptions = {}): void {
  const branch = sliceBranch(run.branch, sliceId);
  const path = worktreePath(root, run.id, sliceId);
  const entry = findEntry(root, path);
  const hasBranch = branchExists(root, branch);

  if (!opts.force) {
    if (entry && isDirty(entry.path)) {
      throw new GenieError(`slice ${sliceId} has uncommitted changes in ${entry.path} (use force to discard)`);
    }
    if (hasBranch && !isAncestor(root, branch, run.branch)) {
      throw new GenieError(`slice branch ${branch} has commits not merged into ${run.branch} (use force to discard)`);
    }
  }
  if (entry) {
    gitOrThrow(root, ['worktree', 'remove', ...(opts.force ? ['--force'] : []), entry.path], `removing ${entry.path}`);
  }
  // -D, not -d: `git branch -d` checks merged-ness against HEAD, but what matters is the run
  // branch, which was verified above (or force was given).
  if (hasBranch) gitOrThrow(root, ['branch', '-D', branch], `deleting ${branch}`);
}

/**
 * Removes all of a run's slice worktrees, their branches, and the integration worktree. Without
 * `force`, checks every slice first and refuses if any has uncommitted or unmerged work.
 * Returns the slice ids removed.
 */
export function pruneRunWorktrees(root: string, run: RunRef, opts: RemoveOptions = {}): string[] {
  const prefix = `${run.branch}--`;
  const branches = gitOrThrow(root, ['for-each-ref', '--format=%(refname:short)', `refs/heads/${prefix}*`], 'listing slice branches')
    .split('\n')
    .filter(Boolean)
    .map((b) => b.slice(prefix.length))
    .filter((slice) => SLICE_ID.test(slice));
  const slices = [...new Set([...listSliceWorktrees(root, run).map((w) => w.slice), ...branches])];

  if (!opts.force) {
    for (const slice of slices) {
      const entry = findEntry(root, worktreePath(root, run.id, slice));
      const branch = sliceBranch(run.branch, slice);
      if (entry && isDirty(entry.path)) throw new GenieError(`slice ${slice} has uncommitted changes in ${entry.path}`);
      if (branchExists(root, branch) && !isAncestor(root, branch, run.branch)) {
        throw new GenieError(`slice branch ${branch} has commits not merged into ${run.branch}`);
      }
    }
  }
  for (const slice of slices) removeSliceWorktree(root, run, slice, opts);

  const integration = findEntry(root, join(runWorktreesDir(root, run.id), INTEGRATION));
  if (integration) {
    gitOrThrow(root, ['worktree', 'remove', ...(opts.force ? ['--force'] : []), integration.path], 'removing the integration worktree');
  }
  const dir = runWorktreesDir(root, run.id);
  if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
  git(root, ['worktree', 'prune']);
  return slices;
}
