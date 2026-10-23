import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { GenieError } from '../errors.ts';
import { abort, advance, completeWork, nextAction, nextActions, type Action, type Ctx } from '../engine.ts';
import { STAGE_DEFS, STAGES, isSliceGate, type GateName, type StageName } from '../pipeline.ts';
import { loadPlan } from '../plan.ts';
import { findSlice, newRunState, type RunState } from '../state.ts';
import type { Mode } from '../config/types.ts';
import { appendLog, currentRunId, loadRun, readLog, runDir, saveRun, setCurrentRun, writeAtomic, type LogEvent } from '../store.ts';
import { mutateRun, type Session } from '../session.ts';
import { cleanUpAborted, dispatchWorktrees, settle } from '../orchestrate.ts';

export interface RunView {
  state: RunState;
  action: Action;
  dir: string;
}

function view(session: Session, state: RunState): RunView {
  return { state, action: nextAction(state, session.config), dir: runDir(session.root, state.id) };
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'run'
  );
}

export function runId(now: string, title: string): string {
  const stamp = now.replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${stamp}-${slugify(title)}`;
}

export function newRun(session: Session, intent: string, mode?: Mode): RunView {
  const text = intent.trim();
  if (!text) throw new GenieError('intent is empty');
  const active = currentRunId(session.root);
  if (active) {
    const { status } = loadRun(session.root, active);
    if (status === 'active' || status === 'halted') {
      throw new GenieError(`run ${active} is still ${status} (finish it or \`genie abort\` first)`);
    }
  }

  const now = session.now();
  const title = text.split('\n')[0]!.slice(0, 80);
  const id = runId(now, title);
  if (existsSync(runDir(session.root, id))) throw new GenieError(`run ${id} already exists`);

  const { base_branch: base, branch_prefix: prefix } = session.config.forge;
  const state = newRunState({ id, title, mode: mode ?? session.config.mode.default, branch: `${prefix}${id}`, base }, now);
  const ctx: Ctx = { now, events: [{ ts: now, run: id, type: 'run.created', note: title, mode: state.mode }] };
  advance(state, session.config, ctx);

  writeAtomic(join(runDir(session.root, id), 'intent.md'), `# ${title}\n\n${text}\n`);
  saveRun(session.root, state);
  appendLog(session.root, id, ctx.events);
  setCurrentRun(session.root, id);
  return view(session, state);
}

export interface Feedback {
  /** The gate whose failed verdict sent the work back; absent for a merge conflict. */
  gate?: GateName;
  /** For slice-gate failures and merge conflicts: the slice. */
  slice?: string;
  /** For a merge conflict: the files that conflicted with the run branch. */
  conflict?: string[];
  by?: string;
  note?: string;
  evidence?: string[];
}

/** Orchestrated mode: where a slice's work happens. `base` is the run branch it merges onto. */
export interface WorktreeView {
  path: string;
  branch: string;
  base: string;
}

export interface ActionView {
  action: Action;
  /** When this action's stage or slice is being reworked: the failed verdict that sent it back. */
  feedback?: Feedback;
  /** For slice actions in orchestrated mode: the slice's worktree. */
  worktree?: WorktreeView;
}

/** Everything an agent needs to perform the next step, as printed by `genie next --json`. */
export interface NextView extends ActionView {
  run: Pick<RunState, 'id' | 'title' | 'mode' | 'status' | 'stage' | 'branch' | 'base'> & { dir: string };
  /**
   * Every action that can be taken now, in plan order; `action` is the first. More than one only
   * in the implement stage, when several slices are ready.
   */
  actions: ActionView[];
  /** How many actions an orchestrator may run at once (`mode.max_parallel_slices`). */
  parallel: number;
}

function verdictBefore(log: LogEvent[], index: number, gate: GateName, slice?: string): Feedback | undefined {
  const verdict = log
    .slice(0, index)
    .findLast((e) => e.type === 'gate.verdict' && e.gate === gate && (!isSliceGate(gate) || e.slice === slice));
  if (!verdict?.gate) return undefined;
  return {
    gate: verdict.gate,
    ...(verdict.slice ? { slice: verdict.slice } : {}),
    by: verdict.by,
    note: verdict.note,
    evidence: verdict.evidence,
  };
}

/**
 * The verdict behind the most recent rework of the run's current stage, or of `slice` when given,
 * if that work is mid-rework. Fix-up slices get the run-level verdict that created them.
 */
export function reworkFeedback(state: RunState, log: LogEvent[], slice?: string): Feedback | undefined {
  if (state.stages[state.stage].phase !== 'work') return undefined;
  if (slice && findSlice(state, slice)?.phase !== 'work') return undefined;
  const [doneType, reworkType] = slice ? ['slice.work_done', 'slice.rework'] : ['stage.work_done', 'stage.rework'];
  for (let i = log.length - 1; i >= 0; i--) {
    const event = log[i]!;
    const mine = slice ? event.slice === slice : event.stage === state.stage;
    if (!mine) continue;
    if (event.type === doneType) return undefined;
    if (event.type === reworkType && Array.isArray(event.conflict)) {
      return { slice, conflict: event.conflict as string[], note: event.note };
    }
    if (event.type === reworkType && event.gate) return verdictBefore(log, i, event.gate, slice);
  }
  return undefined;
}

export function next(session: Session, id?: string): NextView {
  let { state, dir, log } = status(session, id);
  if (state.mode === 'orchestrated') {
    state = mutateRun(session, state.id, (s, ctx) => dispatchWorktrees(session.root, s, session.config, ctx)).state;
  }
  const { title, mode, status: runStatus, stage, branch, base } = state;
  const actions = nextActions(state, session.config).map((action): ActionView => {
    const slice = 'slice' in action ? action.slice?.id : undefined;
    const feedback = action.type === 'work' ? reworkFeedback(state, log, slice) : undefined;
    const wt = slice ? findSlice(state, slice)?.worktree : undefined;
    return {
      action,
      ...(feedback ? { feedback } : {}),
      ...(wt ? { worktree: { path: wt.path, branch: wt.branch, base: state.branch } } : {}),
    };
  });
  return {
    run: { id: state.id, title, mode, status: runStatus, stage, branch, base, dir },
    ...actions[0]!,
    actions,
    parallel: session.config.mode.max_parallel_slices,
  };
}

function git(root: string, args: string[]): string | undefined {
  const res = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : undefined;
}

/** A slice worked in its own worktree must be committed there, on its branch, ahead of the run branch. */
function checkSliceBranch(root: string, state: RunState, slice: string, wt: { path: string; branch: string }): void {
  const dirty = git(wt.path, ['status', '--porcelain']);
  if (dirty === undefined) throw new GenieError(`slice ${slice}'s worktree ${wt.path} is missing or not a git checkout`);
  if (dirty !== '') throw new GenieError(`slice ${slice} has uncommitted changes in ${wt.path}; commit them first`);
  if (git(root, ['rev-list', '--count', `${state.branch}..${wt.branch}`]) === '0') {
    throw new GenieError(`${wt.branch} has no commits ahead of ${state.branch}; commit slice ${slice}'s work in ${wt.path} first`);
  }
}

/** Work that must live on the run branch has to be committed there, ahead of the base branch. */
function checkRunBranch(root: string, state: RunState): void {
  const current = git(root, ['symbolic-ref', '--short', 'HEAD']);
  if (current !== state.branch) {
    throw new GenieError(`work must be committed on the run branch ${state.branch} (currently on ${current ?? 'a detached HEAD'})`);
  }
  const base = [state.base, `origin/${state.base}`].find((ref) => git(root, ['rev-parse', '--verify', '--quiet', ref]));
  if (!base) throw new GenieError(`base branch ${state.base} not found`);
  if (git(root, ['rev-list', '--count', `${base}..HEAD`]) === '0') {
    throw new GenieError(`${state.branch} has no commits ahead of ${state.base}; commit the work first`);
  }
}

export function status(session: Session, id?: string): RunView & { log: LogEvent[] } {
  const state = settle(session, mutateRun(session, id, () => undefined).state);
  return { ...view(session, state), log: readLog(session.root, state.id) };
}

export function done(session: Session, stage: string, by: string, id?: string, slice?: string): RunView {
  if (!STAGES.includes(stage as StageName)) {
    throw new GenieError(`unknown stage "${stage}" (expected one of: ${STAGES.join(', ')})`);
  }
  if (slice && stage !== 'implement') throw new GenieError('--slice only applies to the implement stage');
  const { state } = mutateRun(session, id, (s, ctx) => {
    const inProgress = s.stage === stage && s.stages[stage].phase === 'work';
    const working = stage === 'implement' ? s.slices.filter((sl) => sl.phase === 'work') : [];
    const target = slice ? findSlice(s, slice) : working.length === 1 ? working[0] : undefined;
    if (inProgress && target?.worktree) checkSliceBranch(session.root, s, target.def.id, target.worktree);
    else if (inProgress && STAGE_DEFS[stage].onRunBranch) checkRunBranch(session.root, s);
    const dir = runDir(session.root, s.id);
    // The plan is validated (and snapshotted into the run) only once its stage's work is claimed done.
    const plan = inProgress && stage === 'decompose' ? loadPlan(join(dir, 'plan.yaml'), join(dir, 'spec.md')).slices : undefined;
    completeWork(s, session.config, stage as StageName, by, (rel) => existsSync(join(dir, rel)), ctx, { slice, plan });
  });
  return view(session, settle(session, state));
}

export function abortRun(session: Session, reason: string | undefined, id?: string): RunView & { note?: string } {
  const { state } = mutateRun(session, id, (s, ctx) => abort(s, reason, ctx));
  const note = cleanUpAborted(session, state.id);
  return { ...view(session, state), ...(note ? { note } : {}) };
}

/** Switches a run between guided and orchestrated mode. Either can pick up where the other left off. */
export function setMode(session: Session, mode: Mode, id?: string): RunView {
  const { state } = mutateRun(session, id, (s, ctx) => {
    if (s.mode === mode) return;
    ctx.events.push({ ts: ctx.now, run: s.id, type: 'run.mode', note: `${s.mode} → ${mode}`, mode });
    s.mode = mode;
    s.updatedAt = ctx.now;
  });
  return view(session, state);
}
