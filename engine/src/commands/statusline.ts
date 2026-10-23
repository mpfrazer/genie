import { existsSync } from 'node:fs';
import { advance, nextAction } from '../engine.ts';
import { loadConfig, repoConfigPath } from '../config/load.ts';
import { describeStatusline } from '../format.ts';
import { currentRunId, findRoot, loadRun } from '../store.ts';

/**
 * One line for Claude Code's status line, from its statusLine JSON payload. Returns '' when the
 * workspace has no genie config or no active run, and on any error: a status line must never fail.
 */
export function statusline(payload: string): string {
  try {
    const input = JSON.parse(payload) as { workspace?: { current_dir?: unknown }; cwd?: unknown };
    const cwd = input.workspace?.current_dir ?? input.cwd;
    if (typeof cwd !== 'string' || cwd === '') return '';

    const root = findRoot(cwd);
    if (!existsSync(repoConfigPath(root))) return '';
    const id = currentRunId(root);
    if (!id) return '';
    const run = loadRun(root, id);
    if (run.status !== 'active' && run.status !== 'halted') return '';

    const { config } = loadConfig({ root });
    // Settle config-driven transitions in memory only; the status line never writes state.
    advance(run, config, { now: new Date().toISOString(), events: [] });
    return describeStatusline(run, nextAction(run, config));
  } catch {
    return '';
  }
}
