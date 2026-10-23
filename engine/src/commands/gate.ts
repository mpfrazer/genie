import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { GenieError } from '../errors.ts';
import { runChecks, type CheckResult } from '../checks.ts';
import { advance, currentGate, gateConfig, nextAction, recordVerdict, resolveVerdictSlice } from '../engine.ts';
import { GATES, isSliceGate, type GateName } from '../pipeline.ts';
import type { Config } from '../config/types.ts';
import { findSlice, type GateState, type RunState, type Verdict } from '../state.ts';
import { currentRunId, loadRun, logTail, runDir } from '../store.ts';
import { redeemGrant } from '../grants.ts';
import { TamperError } from '../seal.ts';
import { extendBudget } from '../budget.ts';
import { configDiff, mutateRun, type Session } from '../session.ts';
import { settle } from '../orchestrate.ts';
import type { RunView } from './run.ts';

function parseGate(name: string): GateName {
  if (!GATES.includes(name as GateName)) {
    throw new GenieError(`unknown gate "${name}" (expected one of: ${GATES.join(', ')})`);
  }
  return name as GateName;
}

function evidenceDir(session: Session, runId: string): string {
  return join(runDir(session.root, runId), 'evidence');
}

/**
 * The gate state a verdict will land on, failing fast if the gate isn't up: for slice gates, the
 * named slice's (or the only slice awaiting it); otherwise the run's current gate.
 */
function target(state: RunState, config: Config, gate: GateName, slice?: string): { gs: GateState; slice?: string } {
  if (isSliceGate(gate)) {
    const s = resolveVerdictSlice(state, config, gate, slice);
    return { gs: s.gates[gate], slice: s.def.id };
  }
  if (slice) throw new GenieError(`gate ${gate} is a run-level gate; --slice only applies to slice gates`);
  const ahead = currentGate(state, config);
  if (ahead !== gate) throw new GenieError(`gate ${gate} is not awaiting a verdict (current: ${ahead ?? 'none'})`);
  return { gs: state.gates[gate] };
}

/** Evidence file prefix: gate, slice (for slice gates), and the attempt this verdict will be. */
function evidencePrefix(gate: GateName, t: { gs: GateState; slice?: string }): string {
  return `${gate}.${t.slice ? `${t.slice}.` : ''}${t.gs.attempts + 1}`;
}

/** Runs an automated gate's checks and records the verdict. */
export function runGate(
  session: Session,
  gateName: string,
  id?: string,
  slice?: string,
): RunView & { results: CheckResult[]; verdict: Verdict } {
  const gate = parseGate(gateName);
  const config = session.config;
  // Settle any config-driven transitions first, then fail fast before spending time on checks
  // for a gate that isn't up.
  const { state: before } = mutateRun(session, id, () => undefined);
  const gc = gateConfig(before, config, gate);
  if (gc.kind !== 'automated') {
    throw new GenieError(`gate ${gate} is a ${gc.kind} gate${before.mode === 'orchestrated' ? ' in orchestrated mode' : ''}; --run only evaluates automated gates`);
  }
  const t = target(before, config, gate, slice);

  // A slice with its own worktree is checked there; everything else in the main checkout.
  const cwd = (t.slice && findSlice(before, t.slice)?.worktree?.path) || session.root;
  const outcome = runChecks(cwd, config, gc.checks ?? [], evidenceDir(session, before.id), evidencePrefix(gate, t));
  const evidence = outcome.results.flatMap((r) => (r.log ? [r.log] : []));
  const { state: recorded } = mutateRun(session, before.id, (s, ctx) =>
    recordVerdict(
      s,
      config,
      { gate, slice: t.slice, verdict: outcome.verdict, source: 'automated', by: 'genie', note: outcome.note, evidence },
      ctx,
    ),
  );
  const state = settle(session, recorded);
  return {
    state,
    action: nextAction(state, config),
    dir: runDir(session.root, state.id),
    results: outcome.results,
    verdict: outcome.verdict,
  };
}

export interface AgentVerdictOptions {
  gate: string;
  verdict: string;
  by: string;
  slice?: string;
  note?: string;
  findings?: string;
  id?: string;
}

/** Records an agent evaluator's verdict, copying its findings file into the run's evidence. */
export function agentVerdict(session: Session, opts: AgentVerdictOptions): RunView {
  const gate = parseGate(opts.gate);
  if (opts.verdict !== 'pass' && opts.verdict !== 'fail' && opts.verdict !== 'needs_human') {
    throw new GenieError(`verdict must be pass, fail, or needs_human (got "${opts.verdict}")`);
  }
  if (!opts.by) throw new GenieError('--by <evaluator> is required for agent verdicts');
  // The findings file is the audit trail for why the agent decided as it did, pass or fail.
  const findings = opts.findings;
  if (!findings) throw new GenieError('--findings <file> is required for agent verdicts');
  if (!existsSync(findings)) throw new GenieError(`findings file ${findings} not found`);

  const { state } = mutateRun(session, opts.id, (s, ctx) => {
    const t = target(s, session.config, gate, opts.slice);
    mkdirSync(evidenceDir(session, s.id), { recursive: true });
    const dest = join(evidenceDir(session, s.id), `${evidencePrefix(gate, t)}.${basename(findings)}`);
    copyFileSync(findings, dest);
    const evidence = [dest];
    recordVerdict(
      s,
      session.config,
      { gate, slice: t.slice, verdict: opts.verdict as Verdict, source: 'agent', by: opts.by, note: opts.note, evidence },
      ctx,
    );
  });
  return runView(session, settle(session, state));
}

/**
 * Records a human decision. This must only be reachable from a human-initiated channel
 * (the /genie:approve command); hooks block the model from calling it through Bash.
 */
export function approve(session: Session, gateName: string, reject: boolean, note?: string, id?: string, slice?: string): RunView {
  const runId = id ?? currentRunId(session.root);
  if (!runId) throw new GenieError('no active run');
  // Only a command the user typed carries a grant (grants.ts); a script calling this finds none.
  const grant = redeemGrant(session.root, runId, 'approve', { target: gateName, reject, ...(slice ? { slice } : {}) }, session.now());
  if (gateName === 'state') return acceptState(session, reject, note, runId, slice, grant.nonce);
  if (gateName === 'budget') return approveBudget(session, reject, note, runId, slice);
  if (gateName === 'config') return applyConfig(session, reject, note, runId, slice, grant.nonce);
  const gate = parseGate(gateName);
  const { state } = mutateRun(session, id, (s, ctx) =>
    recordVerdict(s, session.config, { gate, slice, verdict: reject ? 'fail' : 'pass', source: 'human', by: 'human', note, grant: grant.nonce }, ctx),
  );
  return runView(session, settle(session, state));
}

/**
 * `approve state`: a human accepts a run that failed verification (changed outside genie, or
 * written by a genie that didn't seal state) as it now stands, and genie seals it again.
 */
function acceptState(session: Session, reject: boolean, note: string | undefined, id: string, slice: string | undefined, grant: string): RunView {
  if (reject) throw new GenieError('to stop a run whose state you don\'t accept, abort it (/genie:abort)');
  if (slice) throw new GenieError('the state belongs to the run; --slice does not apply');
  let problem: string;
  try {
    loadRun(session.root, id);
    throw new GenieError(`run ${id} verifies; there is nothing to accept`);
  } catch (err) {
    if (!(err instanceof TamperError)) throw err;
    problem = err.message.split('. A human can')[0]!;
  }
  const { state } = mutateRun(
    session,
    id,
    (s, ctx) => {
      // The log is accepted as it stands: the chain restarts from what's there now.
      const tail = logTail(session.root, id);
      if (tail) s.logMac = tail;
      else delete s.logMac;
      ctx.events.push({ ts: ctx.now, run: s.id, type: 'state.accepted', by: 'human', source: 'human', grant, note: note ?? problem });
      s.updatedAt = ctx.now;
    },
    { unverified: true },
  );
  return runView(session, settle(session, state));
}

/** `approve config`: a human applies .genie/config.yaml's current contents to the live run. */
function applyConfig(session: Session, reject: boolean, note: string | undefined, id: string, slice: string | undefined, grant: string): RunView {
  if (reject) throw new GenieError('nothing to reject: the run keeps its config until you apply the new one');
  if (slice) throw new GenieError('the config belongs to the run; --slice does not apply');
  const { state } = mutateRun(session, id, (s, ctx) => {
    const changed = s.config ? configDiff(s.config, session.fileConfig) : [];
    if (changed.length === 0) throw new GenieError(`run ${id} already follows .genie/config.yaml; there is nothing to apply`);
    s.config = session.fileConfig;
    ctx.events.push({ ts: ctx.now, run: s.id, type: 'config.applied', by: 'human', source: 'human', grant, note: note ?? changed.join(', '), changed });
    s.updatedAt = ctx.now;
    advance(s, s.config, ctx);
  });
  return runView({ ...session, config: session.fileConfig }, settle(session, state));
}

/** `approve budget`: a human lets a run that went over budget carry on. */
function approveBudget(session: Session, reject: boolean, note?: string, id?: string, slice?: string): RunView {
  if (reject) throw new GenieError('to stop a run that is over budget, abort it (/genie:abort)');
  if (slice) throw new GenieError('the budget belongs to the run; --slice does not apply');
  const { state } = mutateRun(session, id, (s, ctx) => extendBudget(s, session.config, note, ctx));
  return runView(session, settle(session, state));
}

function runView(session: Session, state: RunState): RunView {
  return { state, action: nextAction(state, session.config), dir: runDir(session.root, state.id) };
}
