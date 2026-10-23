import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { GenieError } from '../errors.ts';
import { abort, advance, completeWork, nextAction, type Action, type Ctx } from '../engine.ts';
import { STAGES, type StageName } from '../pipeline.ts';
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

  const state = newRunState(id, title, mode ?? session.config.mode.default, now);
  const ctx: Ctx = { now, events: [{ ts: now, run: id, type: 'run.created', note: title, mode: state.mode }] };
  advance(state, session.config, ctx);

  writeAtomic(join(runDir(session.root, id), 'intent.md'), `# ${title}\n\n${text}\n`);
  saveRun(session.root, state);
  appendLog(session.root, id, ctx.events);
  setCurrentRun(session.root, id);
  return view(session, state);
}

export function status(session: Session, id?: string): RunView & { log: LogEvent[] } {
  const { state } = mutateRun(session, id, () => undefined);
  return { ...view(session, state), log: readLog(session.root, state.id) };
}

export function done(session: Session, stage: string, by: string, id?: string): RunView {
  if (!STAGES.includes(stage as StageName)) {
    throw new GenieError(`unknown stage "${stage}" (expected one of: ${STAGES.join(', ')})`);
  }
  const { state } = mutateRun(session, id, (s, ctx) =>
    completeWork(s, session.config, stage as StageName, by, (rel) => existsSync(join(runDir(session.root, s.id), rel)), ctx),
  );
  return view(session, state);
}

export function abortRun(session: Session, reason: string | undefined, id?: string): RunView {
  const { state } = mutateRun(session, id, (s, ctx) => abort(s, reason, ctx));
  return view(session, state);
}
