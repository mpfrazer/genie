import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { GenieError } from '../errors.ts';
import { runChecks, type CheckResult } from '../checks.ts';
import { currentGate, nextAction, recordVerdict, resolveVerdictSlice } from '../engine.ts';
import { GATES, isSliceGate, type GateName } from '../pipeline.ts';
import type { Config } from '../config/types.ts';
import type { GateState, RunState, Verdict } from '../state.ts';
import { runDir } from '../store.ts';
import { mutateRun, type Session } from '../session.ts';
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
  if (config.gates[gate].kind !== 'automated') {
    throw new GenieError(`gate ${gate} is a ${config.gates[gate].kind} gate; --run only evaluates automated gates`);
  }
  // Settle any config-driven transitions first, then fail fast before spending time on checks
  // for a gate that isn't up.
  const { state: before } = mutateRun(session, id, () => undefined);
  const t = target(before, config, gate, slice);

  const outcome = runChecks(session.root, config, config.gates[gate].checks ?? [], evidenceDir(session, before.id), evidencePrefix(gate, t));
  const evidence = outcome.results.flatMap((r) => (r.log ? [r.log] : []));
  const { state } = mutateRun(session, before.id, (s, ctx) =>
    recordVerdict(
      s,
      config,
      { gate, slice: t.slice, verdict: outcome.verdict, source: 'automated', by: 'genie', note: outcome.note, evidence },
      ctx,
    ),
  );
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
  return { state, action: nextAction(state, session.config), dir: runDir(session.root, state.id) };
}

/**
 * Records a human decision. This must only be reachable from a human-initiated channel
 * (the /genie:approve command); hooks block the model from calling it through Bash.
 */
export function approve(session: Session, gateName: string, reject: boolean, note?: string, id?: string, slice?: string): RunView {
  const gate = parseGate(gateName);
  const { state } = mutateRun(session, id, (s, ctx) =>
    recordVerdict(s, session.config, { gate, slice, verdict: reject ? 'fail' : 'pass', source: 'human', by: 'human', note }, ctx),
  );
  return { state, action: nextAction(state, session.config), dir: runDir(session.root, state.id) };
}
