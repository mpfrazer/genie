// Orchestrated mode's git side: giving ready slices their own worktrees, landing finished slices
// on the run branch (or with a PR per slice, merging their PRs into the base), and cleaning up.
// The engine decides *when* (slice phases); this does the git.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { GenieError } from './errors.ts';
import { nextActions, sliceConflict, sliceMerged, type Ctx } from './engine.ts';
import { DELIVERY_GATES, STAGES } from './pipeline.ts';
import type { Config } from './config/types.ts';
import { findSlice, freshGate, type RunState, type SliceState } from './state.ts';
import { loadRun } from './store.ts';
import { mutateRun, type Session } from './session.ts';
import { mergePullRequest } from './forge.ts';
import { createSliceWorktree, mergeSlice, pruneRunWorktrees, removeSliceWorktree, runWorktreesDir } from './worktree.ts';

function git(cwd: string, args: string[]): string | undefined {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : undefined;
}

/** Creates the run branch from the base branch (local, else origin's) if it doesn't exist yet. */
function ensureRunBranch(root: string, state: RunState): void {
  if (git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${state.branch}`]) !== undefined) return;
  const base = [state.base, `origin/${state.base}`].find((ref) => git(root, ['rev-parse', '--verify', '--quiet', ref]));
  if (!base) throw new GenieError(`base branch ${state.base} not found`);
  if (git(root, ['branch', state.branch, base]) === undefined) {
    throw new GenieError(`couldn't create the run branch ${state.branch} from ${base}`);
  }
}

/** Fetches the base branch from origin, so slices start from (and merge onto) what's there. Returns its commit. */
function fetchBase(root: string, state: RunState): string {
  if (git(root, ['fetch', '--quiet', 'origin', state.base]) === undefined) {
    throw new GenieError(`couldn't fetch ${state.base} from origin; a PR per slice needs the repo's GitHub remote as origin`);
  }
  return git(root, ['rev-parse', `origin/${state.base}`]) ?? '';
}

/**
 * Decides, as an orchestrated run starts its first slice, how its work reaches the base branch.
 * With `forge.pr_per: slice` each slice gets its own PR, unless guided mode already started
 * slices on the run branch, which then stays the run's one PR.
 */
function chooseDelivery(root: string, state: RunState, config: Config, ctx: Ctx): void {
  if (state.delivery || config.forge.pr_per !== 'slice') return;
  const event = { ts: ctx.now, run: state.id, type: 'run.delivery', stage: 'implement' as const };
  if (state.slices.some((s) => s.author || s.phase !== 'work')) {
    state.delivery = 'run';
    ctx.events.push({ ...event, note: `one PR for the run: slices were already worked on ${state.branch} in guided mode` });
    return;
  }
  if (config.forge.provider !== 'github') throw new GenieError('forge.pr_per: slice needs forge.provider: github');
  state.since = fetchBase(root, state);
  state.delivery = 'slice';
  for (const slice of state.slices) for (const g of DELIVERY_GATES) slice.gates[g] ??= freshGate();
  ctx.events.push({ ...event, note: `a PR per slice into ${state.base}, from ${state.since.slice(0, 12)}` });
}

/**
 * Gives every slice that's ready for work its own worktree, branched from the run branch's
 * current tip (so it includes the slices it depends on). With a PR per slice, it branches from the
 * base as it is on origin, where the slices it depends on have merged. Idempotent.
 */
export function dispatchWorktrees(root: string, state: RunState, config: Config, ctx: Ctx): void {
  if (state.status !== 'active' || state.stage !== 'implement' || state.stages.implement.phase !== 'work') return;
  const ready = nextActions(state, config).flatMap((a) =>
    a.type === 'work' && a.stage === 'implement' && a.slice && !findSlice(state, a.slice.id)?.worktree ? [a.slice.id] : [],
  );
  if (ready.length === 0) return;
  chooseDelivery(root, state, config, ctx);
  const perSlice = state.delivery === 'slice';
  if (perSlice) fetchBase(root, state);
  else ensureRunBranch(root, state);
  for (const id of ready) {
    const wt = createSliceWorktree(root, state, id, perSlice ? `origin/${state.base}` : state.branch);
    findSlice(state, id)!.worktree = { path: wt.path, branch: wt.branch };
    ctx.events.push({ ts: ctx.now, run: state.id, type: 'slice.worktree', stage: 'implement', slice: id, note: wt.path });
  }
}

function pastImplement(state: RunState): boolean {
  return STAGES.indexOf(state.stage) > STAGES.indexOf('implement');
}

function needsSettle(root: string, state: RunState): boolean {
  if (state.status !== 'active') return false;
  return state.slices.some((s) => s.phase === 'merge') || (pastImplement(state) && existsSync(runWorktreesDir(root, state.id)));
}

/**
 * With a PR per slice: merges the slice's approved PR into the base, then removes its worktree and
 * branches. Dependent slices then start from the base with it merged.
 */
function landSlicePr(root: string, state: RunState, slice: SliceState, session: Session, ctx: Ctx): void {
  const id = slice.def.id;
  const branch = slice.worktree?.branch;
  if (!branch) throw new GenieError(`slice ${id} has no branch to merge`);
  const result = mergePullRequest(root, state.base, branch);
  if (result.status === 'conflict') {
    sliceConflict(state, id, result.files, ctx);
    return;
  }
  fetchBase(root, state);
  // The remote branch may already be gone (the repo can delete merged branches itself).
  git(root, ['push', '--quiet', 'origin', '--delete', branch]);
  try {
    removeSliceWorktree(root, state, id, { landed: true });
    delete slice.worktree;
  } catch {
    // Kept for the prune after implement, which reports why.
  }
  sliceMerged(state, session.config, id, result.commit, ctx);
}

function landSlice(root: string, state: RunState, slice: SliceState, session: Session, ctx: Ctx): void {
  const id = slice.def.id;
  if (state.delivery === 'slice') {
    landSlicePr(root, state, slice, session, ctx);
    return;
  }
  const result = mergeSlice(root, state, id, `Merge slice ${id}: ${slice.def.title}`);
  if (result.status === 'conflict') {
    sliceConflict(state, id, result.files, ctx);
    return;
  }
  const commit = result.status === 'merged' ? result.commit : (git(root, ['rev-parse', state.branch]) ?? '');
  // The slice's work is on the run branch now, so its worktree has done its job. If it can't be
  // removed, it's left for the prune after implement, which reports why.
  try {
    removeSliceWorktree(root, state, id);
    delete slice.worktree;
  } catch {
    // Kept: see above.
  }
  sliceMerged(state, session.config, id, commit, ctx);
}

/**
 * Applies the git side of whatever the last mutation decided: lands slices queued to merge (one at
 * a time, in plan order, under the run lock), and once the run has moved past implement, removes
 * what's left of its worktrees. Returns the updated state, or `state` when there was nothing to do.
 */
export function settle(session: Session, state: RunState): RunState {
  const { root } = session;
  if (!needsSettle(root, state)) return state;
  // Merges and the prune are separate mutations, so landed merges are saved even if the prune fails.
  if (state.slices.some((s) => s.phase === 'merge')) {
    state = mutateRun(session, state.id, (s, ctx) => {
      for (const slice of s.slices) {
        if (s.status === 'active' && slice.phase === 'merge') landSlice(root, s, slice, session, ctx);
      }
    }).state;
  }
  if (needsSettle(root, state)) {
    state = mutateRun(session, state.id, (s, ctx) => {
      if (s.status !== 'active' || !pastImplement(s) || !existsSync(runWorktreesDir(root, s.id))) return;
      const removed = pruneRunWorktrees(root, s, { landed: s.delivery === 'slice' });
      for (const slice of s.slices) delete slice.worktree;
      ctx.events.push({ ts: ctx.now, run: s.id, type: 'worktrees.pruned', note: removed.join(', ') || 'integration only' });
    }).state;
  }
  return state;
}

/**
 * After an abort: removes the run's worktrees if nothing in them would be lost. Unmerged or
 * uncommitted work is left in place, and the returned note says where.
 */
export function cleanUpAborted(session: Session, id: string): string | undefined {
  const state = loadRun(session.root, id);
  if (!existsSync(runWorktreesDir(session.root, state.id))) return undefined;
  try {
    pruneRunWorktrees(session.root, state);
    return undefined;
  } catch (err) {
    return `kept the run's worktrees in ${runWorktreesDir(session.root, state.id)}: ${(err as Error).message}`;
  }
}
