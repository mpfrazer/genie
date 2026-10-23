import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { Config } from './config/types.ts';
import type { Verdict } from './state.ts';
import { writeAtomic } from './store.ts';

export interface CheckResult {
  check: string;
  command?: string;
  status: 'pass' | 'fail' | 'missing';
  exitCode?: number | null;
  durationMs?: number;
  /** Evidence file holding the command's combined output. */
  log?: string;
}

export interface ChecksOutcome {
  verdict: Verdict;
  results: CheckResult[];
  note: string;
}

/** Looks up a dotted path such as `commands.test` or `deploy.health_check`. */
export function resolveCheck(config: Config, check: string): string | undefined {
  let value: unknown = config;
  for (const key of check.split('.')) {
    if (typeof value !== 'object' || value === null) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * Runs each configured check in order, stopping at the first failure.
 * Checks with no command configured are skipped; if none are configured at all,
 * the gate can't be decided automatically and goes to a human.
 */
export function runChecks(
  root: string,
  config: Config,
  checks: string[],
  evidenceDir: string,
  evidencePrefix: string,
): ChecksOutcome {
  const results: CheckResult[] = [];
  for (const check of checks) {
    const command = resolveCheck(config, check);
    if (!command) {
      results.push({ check, status: 'missing' });
      continue;
    }
    const started = Date.now();
    const res = spawnSync('sh', ['-c', command], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const log = join(evidenceDir, `${evidencePrefix}.${check.replaceAll('.', '-')}.log`);
    writeAtomic(log, `$ ${command}\n${res.stdout ?? ''}${res.stderr ?? ''}${res.error ? `\n${res.error.message}\n` : ''}`);
    const status = res.status === 0 ? 'pass' : 'fail';
    results.push({ check, command, status, exitCode: res.status, durationMs: Date.now() - started, log });
    if (status === 'fail') break;
  }

  const ran = results.filter((r) => r.status !== 'missing');
  const failed = ran.find((r) => r.status === 'fail');
  const missing = results.filter((r) => r.status === 'missing').map((r) => r.check);
  if (failed) {
    return { verdict: 'fail', results, note: `${failed.check} failed (exit ${failed.exitCode})` };
  }
  if (ran.length === 0) {
    return { verdict: 'needs_human', results, note: `no checks configured (${checks.join(', ') || 'none listed'})` };
  }
  const skipped = missing.length > 0 ? `; not configured: ${missing.join(', ')}` : '';
  return { verdict: 'pass', results, note: `passed: ${ran.map((r) => r.check).join(', ')}${skipped}` };
}
