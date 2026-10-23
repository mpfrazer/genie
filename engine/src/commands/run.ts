import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { GenieError } from '../errors.ts';
import { abort, advance, completeWork, nextAction, type Action, type Ctx } from '../engine.ts';
import { STAGE_DEFS, STAGES, type GateName, type StageName } from '../pipeline.ts';
import { newRunState, type RunState } from '../state.ts';
import type { Mode } from '../config/types.ts';
import { appendLog, currentRunId, loadRun, readLog, runDir, saveRun, setCurrentRun, writeAtomic, type LogEvent } from '../store.ts';
import { mutateRun, type Session } from '../session.ts';

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
  gate: GateName;
  by?: string;
  note?: string;
  evidence?: string[];
}

/** Everything an agent needs to perform the next step, as printed by `genie next --json`. */
export interface NextView {
  run: Pick<RunState, 'id' | 'title' | 'mode' | 'status' | 'stage' | 'branch' | 'base'> & { dir: string };
  action: Action;
  /** When the current stage is being reworked: the failed verdict that sent it back. */
  feedback?: Feedback;
}

/** The verdict behind the most recent rework of the run's current stage, if it is mid-rework. */
export function reworkFeedback(state: RunState, log: LogEvent[]): Feedback | undefined {
  if (state.stages[state.stage].phase !== 'work') return undefined;
  for (let i = log.length - 1; i >= 0; i--) {
    const event = log[i]!;
    if (event.type === 'stage.work_done' && event.stage === state.stage) return undefined;
    if (event.type === 'stage.rework' && event.stage === state.stage) {
      const verdict = log.slice(0, i).findLast((e) => e.type === 'gate.verdict' && e.gate === event.gate);
      if (!verdict?.gate) return undefined;
      return { gate: verdict.gate, by: verdict.by, note: verdict.note, evidence: verdict.evidence };
    }
  }
  return undefined;
}

export function next(session: Session, id?: string): NextView {
  const { state, action, dir, log } = status(session, id);
  const { title, mode, status: runStatus, stage, branch, base } = state;
  return {
    run: { id: state.id, title, mode, status: runStatus, stage, branch, base, dir },
    action,
    feedback: reworkFeedback(state, log),
  };
}

function git(root: string, args: string[]): string | undefined {
  const res = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : undefined;
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
  const { state } = mutateRun(session, id, () => undefined);
  return { ...view(session, state), log: readLog(session.root, state.id) };
}

export function done(session: Session, stage: string, by: string, id?: string): RunView {
  if (!STAGES.includes(stage as StageName)) {
    throw new GenieError(`unknown stage "${stage}" (expected one of: ${STAGES.join(', ')})`);
  }
  const { state } = mutateRun(session, id, (s, ctx) => {
    if (s.stage === stage && s.stages[stage].phase === 'work' && STAGE_DEFS[stage].onRunBranch) {
      checkRunBranch(session.root, s);
    }
    completeWork(s, session.config, stage as StageName, by, (rel) => existsSync(join(runDir(session.root, s.id), rel)), ctx);
  });
  return view(session, state);
}

export function abortRun(session: Session, reason: string | undefined, id?: string): RunView {
  const { state } = mutateRun(session, id, (s, ctx) => abort(s, reason, ctx));
  return view(session, state);
}
