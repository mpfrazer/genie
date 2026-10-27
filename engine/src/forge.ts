// The forge side of a PR per slice (`forge.pr_per: slice`): finding a slice's pull request and
// merging it once its pr.approved gate has passed. The engine merges slice PRs itself, so a
// slice lands only through the gate. GitHub only, through `gh`.
import { spawnSync } from 'node:child_process';
import { GenieError } from './errors.ts';

export interface PullRequest {
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  baseRefName: string;
  headRefName: string;
  mergeCommit?: { oid: string } | null;
}

export type PullRequestMerge = { status: 'merged'; commit: string } | { status: 'conflict'; files: string[] };

interface Result {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function run(cmd: string, cwd: string, args: string[]): Result {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (res.error) throw new GenieError(`couldn't run ${cmd}: ${res.error.message}`);
  return { ok: res.status === 0, stdout: (res.stdout ?? '').trim(), stderr: (res.stderr ?? '').trim() };
}

const FIELDS = 'number,url,state,mergeable,baseRefName,headRefName,mergeCommit';

/** The pull request whose head is `branch`, if there is one. */
export function findPullRequest(cwd: string, branch: string): PullRequest | undefined {
  const res = run('gh', cwd, ['pr', 'view', branch, '--json', FIELDS]);
  if (res.ok) return JSON.parse(res.stdout) as PullRequest;
  if (/no (open )?pull requests? found/i.test(res.stderr)) return undefined;
  throw new GenieError(`gh pr view ${branch} failed: ${res.stderr || res.stdout}`);
}

/** The merge method to use: squash if the repo allows it, then a merge commit, then rebase. */
function mergeMethod(cwd: string): string {
  const res = run('gh', cwd, ['repo', 'view', '--json', 'squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed']);
  if (!res.ok) throw new GenieError(`gh repo view failed: ${res.stderr || res.stdout}`);
  const allowed = JSON.parse(res.stdout) as Record<string, boolean>;
  if (allowed.squashMergeAllowed) return 'squash';
  if (allowed.mergeCommitAllowed) return 'merge';
  if (allowed.rebaseMergeAllowed) return 'rebase';
  throw new GenieError('the repository allows no merge method');
}

/** Files that conflict when `branch` merges into the base, as git sees it locally (best effort). */
function conflictFiles(cwd: string, base: string, branch: string): string[] {
  run('git', cwd, ['fetch', '--quiet', 'origin', base]);
  const res = run('git', cwd, ['merge-tree', '--write-tree', '--name-only', '--no-messages', `origin/${base}`, branch]);
  return res.ok ? [] : res.stdout.split('\n').slice(1).filter(Boolean);
}

function merged(pr: PullRequest): PullRequestMerge {
  return { status: 'merged', commit: pr.mergeCommit?.oid ?? '' };
}

/**
 * Merges the slice's pull request into the base. A PR that already merged counts. A conflict
 * with the base is returned, for the slice's implementer to resolve; anything else that stops
 * the merge (required checks, reviews, a closed PR) throws, and the slice stays queued.
 */
export function mergePullRequest(cwd: string, base: string, branch: string): PullRequestMerge {
  const pr = findPullRequest(cwd, branch);
  if (!pr) throw new GenieError(`no pull request found for ${branch}`);
  if (pr.state === 'MERGED') return merged(pr);
  if (pr.state === 'CLOSED') throw new GenieError(`${pr.url} was closed without merging; reopen it, or abort the run`);
  if (pr.mergeable !== 'CONFLICTING') {
    const res = run('gh', cwd, ['pr', 'merge', String(pr.number), `--${mergeMethod(cwd)}`]);
    const after = findPullRequest(cwd, branch);
    if (after?.state === 'MERGED') return merged(after);
    if (after?.mergeable !== 'CONFLICTING') {
      const why = res.ok ? 'gh pr merge returned without merging it (is a merge queue or auto-merge holding it?)' : res.stderr || res.stdout;
      throw new GenieError(`merging ${pr.url} failed: ${why}`);
    }
  }
  return { status: 'conflict', files: conflictFiles(cwd, base, branch) };
}
