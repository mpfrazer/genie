// Orchestrated mode's git side: giving ready slices their own worktrees, landing finished slices
// on the run branch, and cleaning up. The engine decides *when* (slice phases); this does the git.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { GenieError } from './errors.ts';
import { nextActions, sliceConflict, sliceMerged, type Ctx } from './engine.ts';
import { STAGES } from './pipeline.ts';
import type { Config } from './config/types.ts';
import { findSlice, type RunState, type SliceState } from './state.ts';
import { loadRun } from './store.ts';
import { mutateRun, type Session } from './session.ts';
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

/**
 * Gives every slice that's ready for work its own worktree, branched from the run branch's
 * current tip (so it includes the slices it depends on). Idempotent.
 */
export function dispatchWorktrees(root: string, state: RunState, config: Config, ctx: Ctx): void {
  if (state.status !== 'active' || state.stage !== 'implement' || state.stages.implement.phase !== 'work') return;
  const ready = nextActions(state, config).flatMap((a) =>
    a.type === 'work' && a.slice && !findSlice(state, a.slice.id)?.worktree ? [a.slice.id] : [],
  );
  if (ready.length === 0) return;
  ensureRunBranch(root, state);
  for (const id of ready) {
    const wt = createSliceWorktree(root, state, id);
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

function landSlice(root: string, state: RunState, slice: SliceState, session: Session, ctx: Ctx): void {
  const id = slice.def.id;
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
      const removed = pruneRunWorktrees(root, s);
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
