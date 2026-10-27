import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { GenieError } from '../errors.ts';
import { abort, advance, completeWork, gateConfig, landsOn, nextAction, nextActions, stageDef, type Action, type Ctx } from '../engine.ts';
import { STAGES, isSliceGate, type GateName, type RunGateName, type StageName } from '../pipeline.ts';
import { loadPlan } from '../plan.ts';
import { findSlice, newRunState, type RunState, type SliceState } from '../state.ts';
import type { Mode } from '../config/types.ts';
import { commitRun, currentRunId, loadRun, readLog, runDir, setCurrentRun, writeAtomic, type LogEvent } from '../store.ts';
import { mutateRun, type Session } from '../session.ts';
import { redeemGrant } from '../grants.ts';
import { cleanUpAborted, dispatchWorktrees, settle } from '../orchestrate.ts';
import { findPullRequest } from '../forge.ts';

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
    // Unverified: a run that fails verification still blocks a new one if it claims to be live.
    const { status } = loadRun(session.root, active, { unverified: true });
    if (status === 'active' || status === 'halted') {
      throw new GenieError(`run ${active} is still ${status} (finish it or \`genie abort\` first)`);
    }
  }

  const now = session.now();
  const title = text.split('\n')[0]!.slice(0, 80);
  const id = runId(now, title);
  if (existsSync(runDir(session.root, id))) throw new GenieError(`run ${id} already exists`);

  const config = session.fileConfig;
  const { base_branch: base, branch_prefix: prefix } = config.forge;
  const state = newRunState({ id, title, mode: mode ?? config.mode.default, branch: `${prefix}${id}`, base }, now);
  state.config = config;
  const ctx: Ctx = { now, events: [{ ts: now, run: id, type: 'run.created', note: title, mode: state.mode }] };
  advance(state, config, ctx);

  writeAtomic(join(runDir(session.root, id), 'intent.md'), `# ${title}\n\n${text}\n`);
  commitRun(session.root, state, ctx.events);
  setCurrentRun(session.root, id);
  return view({ ...session, config }, state);
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

/**
 * Orchestrated mode: where a slice's work happens. `base` is what it merges onto: the run branch,
 * or with a PR per slice, the base branch on origin (`origin/<base>`).
 */
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
  run: Pick<RunState, 'id' | 'title' | 'mode' | 'status' | 'stage' | 'branch' | 'base' | 'delivery' | 'since'> & { dir: string };
  /**
   * Every action that can be taken now, in plan order; `action` is the first. More than one only
   * in the implement stage, when several slices are ready.
   */
  actions: ActionView[];
  /** How many actions an orchestrator may run at once (`mode.max_parallel_slices`). */
  parallel: number;
  /** Settings changed in .genie/config.yaml that the run won't follow until the user runs `/genie:approve config`. */
  configPending?: string[];
}

function verdictBefore(log: LogEvent[], index: number, gate: GateName, slice?: string): Feedback | undefined {
  // A slice's own gates match on the slice; a run-level verdict also explains the fix-up slice it created.
  const verdict = log
    .slice(0, index)
    .findLast((e) => e.type === 'gate.verdict' && e.gate === gate && (e.slice === slice || (!isSliceGate(gate) && e.slice === undefined)));
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
  const { title, mode, status: runStatus, stage, branch, base, delivery, since } = state;
  const onto = delivery === 'slice' ? `origin/${base}` : branch;
  const actions = nextActions(state, session.config).map((action): ActionView => {
    const slice = 'slice' in action ? action.slice?.id : undefined;
    const feedback = action.type === 'work' ? reworkFeedback(state, log, slice) : undefined;
    const wt = slice ? findSlice(state, slice)?.worktree : undefined;
    return {
      action,
      ...(feedback ? { feedback } : {}),
      ...(wt ? { worktree: { path: wt.path, branch: wt.branch, base: onto } } : {}),
    };
  });
  return {
    run: { id: state.id, title, mode, status: runStatus, stage, branch, base, ...(delivery ? { delivery } : {}), ...(since ? { since } : {}), dir },
    ...actions[0]!,
    actions,
    parallel: session.config.mode.max_parallel_slices,
    ...(session.pendingConfig.length > 0 ? { configPending: session.pendingConfig } : {}),
  };
}

function git(root: string, args: string[]): string | undefined {
  const res = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : undefined;
}

/** A slice worked in its own worktree must be committed there, on its branch, ahead of where it lands. */
function checkSliceBranch(root: string, state: RunState, slice: string, wt: { path: string; branch: string }): void {
  const dirty = git(wt.path, ['status', '--porcelain']);
  if (dirty === undefined) throw new GenieError(`slice ${slice}'s worktree ${wt.path} is missing or not a git checkout`);
  if (dirty !== '') throw new GenieError(`slice ${slice} has uncommitted changes in ${wt.path}; commit them first`);
  const onto = state.delivery === 'slice' ? `origin/${state.base}` : state.branch;
  if (git(root, ['rev-list', '--count', `${onto}..${wt.branch}`]) === '0') {
    throw new GenieError(`${wt.branch} has no commits ahead of ${onto}; commit slice ${slice}'s work in ${wt.path} first`);
  }
}

/**
 * With a PR per slice: the slice's branch is pushed as it stands, and its PR into the base is
 * open. Returns the PR, for the engine to record.
 */
function checkSlicePr(root: string, state: RunState, slice: SliceState): { number: number; url: string } {
  const id = slice.def.id;
  const wt = slice.worktree;
  if (!wt) throw new GenieError(`slice ${id} has no worktree or branch to open a PR from`);
  checkSliceBranch(root, state, id, wt);
  const local = git(root, ['rev-parse', wt.branch]);
  const remote = git(root, ['ls-remote', 'origin', `refs/heads/${wt.branch}`])?.split(/\s/)[0];
  if (!remote) throw new GenieError(`${wt.branch} isn't on origin yet; push it first`);
  if (remote !== local) throw new GenieError(`origin's ${wt.branch} differs from the local branch; push slice ${id}'s latest commits first`);
  const pr = findPullRequest(root, wt.branch);
  if (!pr || pr.state !== 'OPEN') throw new GenieError(`no open pull request for ${wt.branch}; open one into ${state.base} first`);
  if (pr.baseRefName !== state.base) throw new GenieError(`${pr.url} targets ${pr.baseRefName}, not ${state.base}; change its base first`);
  return { number: pr.number, url: pr.url };
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
  if (slice && stage !== 'implement' && stage !== 'pr') throw new GenieError('--slice only applies to the implement and pr stages');
  const { state } = mutateRun(session, id, (s, ctx) => {
    // With a PR per slice, `done pr --slice` reports a slice's PR open while the run implements.
    if (stage === 'pr' && s.delivery === 'slice' && s.stage === 'implement') {
      const waiting = s.slices.filter((sl) => sl.phase === 'pr');
      const target = slice ? findSlice(s, slice) : waiting.length === 1 ? waiting[0] : undefined;
      const pr = target?.phase === 'pr' ? checkSlicePr(session.root, s, target) : undefined;
      completeWork(s, session.config, 'pr', by, () => true, ctx, { slice: slice ?? target?.def.id, pr });
      return;
    }
    if (slice && stage !== 'implement') throw new GenieError('--slice only applies to the pr stage when the run opens a PR per slice');
    const inProgress = s.stage === stage && s.stages[stage].phase === 'work';
    const working = stage === 'implement' ? s.slices.filter((sl) => sl.phase === 'work') : [];
    const target = slice ? findSlice(s, slice) : working.length === 1 ? working[0] : undefined;
    if (inProgress && target?.worktree) checkSliceBranch(session.root, s, target.def.id, target.worktree);
    else if (inProgress && stageDef(s, stage as StageName).onRunBranch) checkRunBranch(session.root, s);
    const dir = runDir(session.root, s.id);
    // The plan is validated (and snapshotted into the run) only once its stage's work is claimed done.
    const plan = inProgress && stage === 'decompose' ? loadPlan(join(dir, 'plan.yaml'), join(dir, 'spec.md')).slices : undefined;
    completeWork(s, session.config, stage as StageName, by, (rel) => existsSync(join(dir, rel)), ctx, { slice, plan });
  });
  return view(session, settle(session, state));
}

export function abortRun(session: Session, reason: string | undefined, id?: string): RunView & { note?: string } {
  const runId = id ?? currentRunId(session.root);
  if (!runId) throw new GenieError('no active run');
  const grant = redeemGrant(session.root, runId, 'abort', { reject: false }, session.now());
  // Unverified: the user can stop a run even when its state failed verification.
  const { state } = mutateRun(
    session,
    runId,
    (s, ctx) => {
      abort(s, reason, ctx);
      ctx.events.at(-1)!.grant = grant.nonce;
    },
    { unverified: true },
  );
  const note = cleanUpAborted(session, state.id);
  return { ...view(session, state), ...(note ? { note } : {}) };
}

/** Switches a run between guided and orchestrated mode. Either can pick up where the other left off. */
export function setMode(session: Session, mode: Mode, id?: string): RunView {
  const { state } = mutateRun(session, id, (s, ctx) => {
    if (s.mode === mode) return;
    if (mode === 'guided' && s.delivery === 'slice' && s.stage === 'implement') {
      throw new GenieError(`run ${s.id} opens a PR per slice, which needs orchestrated mode until every slice has merged into ${landsOn(s)}`);
    }
    // The model can switch modes, so a switch must never hand a decision waiting on a human to an agent.
    const after = { ...s, mode };
    for (const action of nextActions(s, session.config)) {
      if (action.type !== 'await_human' || s.gates[action.gate as RunGateName]?.status === 'needs_human' || action.slice) continue;
      const kind = gateConfig(after, session.config, action.gate).kind;
      if (kind !== 'human' && kind !== 'agent+human') {
        throw new GenieError(`${action.gate} is waiting on a human decision, which ${mode} mode would give to an agent; decide it first`);
      }
    }
    ctx.events.push({ ts: ctx.now, run: s.id, type: 'run.mode', note: `${s.mode} → ${mode}`, mode });
    s.mode = mode;
    s.updatedAt = ctx.now;
  });
  return view(session, state);
}
