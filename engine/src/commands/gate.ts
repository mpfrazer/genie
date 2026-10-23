import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { GenieError } from '../errors.ts';
import { runChecks, type CheckResult } from '../checks.ts';
import { currentGate, nextAction, recordVerdict } from '../engine.ts';
import { GATES, type GateName } from '../pipeline.ts';
import type { Verdict } from '../state.ts';
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

/** Runs an automated gate's checks and records the verdict. */
export function runGate(session: Session, gateName: string, id?: string): RunView & { results: CheckResult[] } {
  const gate = parseGate(gateName);
  // Settle any config-driven transitions first so the gate check sees the real current gate.
  const { state: before } = mutateRun(session, id, () => undefined);
  const config = session.config;
  if (config.gates[gate].kind !== 'automated') {
    throw new GenieError(`gate ${gate} is a ${config.gates[gate].kind} gate; --run only evaluates automated gates`);
  }
  // Fail fast before spending time on checks for a gate that isn't up.
  const ahead = currentGate(before, config);
  if (ahead !== gate) throw new GenieError(`gate ${gate} is not awaiting a verdict (current: ${ahead ?? 'none'})`);

  const attempt = before.gates[gate].attempts + 1;
  const outcome = runChecks(session.root, config, config.gates[gate].checks ?? [], evidenceDir(session, before.id), `${gate}.${attempt}`);
  const evidence = outcome.results.flatMap((r) => (r.log ? [r.log] : []));
  const { state } = mutateRun(session, before.id, (s, ctx) =>
    recordVerdict(s, config, { gate, verdict: outcome.verdict, source: 'automated', by: 'genie', note: outcome.note, evidence }, ctx),
  );
  return { state, action: nextAction(state, config), dir: runDir(session.root, state.id), results: outcome.results };
}

export interface AgentVerdictOptions {
  gate: string;
  verdict: string;
  by: string;
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
  if (opts.findings && !existsSync(opts.findings)) throw new GenieError(`findings file ${opts.findings} not found`);

  const { state } = mutateRun(session, opts.id, (s, ctx) => {
    const evidence: string[] = [];
    if (opts.findings) {
      mkdirSync(evidenceDir(session, s.id), { recursive: true });
      const dest = join(evidenceDir(session, s.id), `${gate}.${s.gates[gate].attempts + 1}.${basename(opts.findings)}`);
      copyFileSync(opts.findings, dest);
      evidence.push(dest);
    }
    recordVerdict(
      s,
      session.config,
      { gate, verdict: opts.verdict as Verdict, source: 'agent', by: opts.by, note: opts.note, evidence },
      ctx,
    );
  });
  return { state, action: nextAction(state, session.config), dir: runDir(session.root, state.id) };
}

/**
 * Records a human decision. This must only be reachable from a human-initiated channel
 * (the /genie:approve command); hooks block the model from calling it through Bash.
 */
export function approve(session: Session, gateName: string, reject: boolean, note?: string, id?: string): RunView {
  const gate = parseGate(gateName);
  const { state } = mutateRun(session, id, (s, ctx) =>
    recordVerdict(s, session.config, { gate, verdict: reject ? 'fail' : 'pass', source: 'human', by: 'human', note }, ctx),
  );
  return { state, action: nextAction(state, session.config), dir: runDir(session.root, state.id) };
}
