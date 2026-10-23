import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { advance } from '../engine.ts';
import { loadConfig, repoConfigPath } from '../config/load.ts';
import type { Config } from '../config/types.ts';
import type { RunState } from '../state.ts';
import { currentRunId, findRoot, liveRunId, loadRun } from '../store.ts';
import { issueGrant, parseSlash } from '../grants.ts';
import { classifyCommands, isConfigPath, isKeyPath, isStatePath, type ProtectedAction } from '../hook/classify.ts';
import { callerFrom, decide, type Decision } from '../hook/policy.ts';
import { simpleCommands } from '../hook/shell.ts';

/** The subset of Claude Code's PreToolUse payload the hook reads. */
export interface PreToolUseInput {
  tool_name: string;
  tool_input: { command?: string; file_path?: string; notebook_path?: string; path?: string };
  cwd: string;
  agent_type?: string;
}

export interface HookOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'deny' | 'ask';
    permissionDecisionReason: string;
  };
}

function toolActions(input: PreToolUseInput, config: Config | undefined): ProtectedAction[] {
  const { tool_name: tool, tool_input: args } = input;
  if (tool === 'Bash') {
    return classifyCommands(simpleCommands(args.command ?? ''), config, input.cwd);
  }
  const path = args.file_path ?? args.notebook_path ?? args.path;
  if (!path) return [];
  const abs = isAbsolute(path) ? path : resolve(input.cwd, path);
  if (isKeyPath(abs)) return [{ kind: 'key_access', detail: `${tool} ${path}`, path }];
  // Reading and searching are fine everywhere else.
  if (tool === 'Read' || tool === 'Grep') return [];
  if (isStatePath(abs)) return [{ kind: 'state_write', detail: `${tool} ${path}`, path }];
  if (isConfigPath(abs)) return [{ kind: 'config_write', detail: `${tool} ${path}`, path }];
  return [];
}

function activeRun(root: string, config: Config): RunState | undefined {
  const id = liveRunId(root);
  if (!id) return undefined;
  // Verified: a run whose state was changed outside genie throws, and outward actions are denied.
  const run = loadRun(root, id);
  if (run.status !== 'active' && run.status !== 'halted') return undefined;
  // Settle transitions in memory so the decision reflects what `genie next` would say.
  advance(run, run.config ?? config, { now: new Date().toISOString(), events: [] });
  return run;
}

export function preToolUse(input: PreToolUseInput): Decision | undefined {
  const root = findRoot(input.cwd);
  let config: Config | undefined;
  let loadError: string | undefined;
  if (existsSync(repoConfigPath(root))) {
    try {
      config = loadConfig({ root }).config;
    } catch (err) {
      loadError = (err as Error).message;
    }
  }

  const actions = toolActions(input, config);
  if (actions.length === 0) return undefined;
  const outward = actions.some((a) => !['approve', 'abort', 'state_write', 'config_write', 'key_access'].includes(a.kind));
  if (loadError && outward) {
    return { decision: 'deny', reason: `genie: can't check gates because the config failed to load: ${loadError}` };
  }

  let run: RunState | undefined;
  try {
    run = config ? activeRun(root, config) : undefined;
  } catch (err) {
    if (outward) return { decision: 'deny', reason: `genie: can't read the active run: ${(err as Error).message}` };
  }

  return decide({
    actions,
    caller: callerFrom(input.agent_type),
    // A live run is judged by its own config: edits to the file wait for /genie:approve config.
    config: run?.config ?? config,
    run,
    currentBranch: (cwd) => {
      const res = spawnSync('git', ['symbolic-ref', '--short', 'HEAD'], {
        cwd: cwd ? resolve(input.cwd, cwd) : input.cwd,
        encoding: 'utf8',
      });
      return res.status === 0 ? res.stdout.trim() : undefined;
    },
  });
}

export function hookOutput(decision: Decision): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision.decision,
      permissionDecisionReason: decision.reason,
    },
  };
}

/** The subset of Claude Code's UserPromptExpansion payload the hook reads. */
export interface PromptExpansionInput {
  cwd: string;
  session_id?: string;
  expansion_type?: string;
  command_name?: string;
  command_args?: string;
  prompt?: string;
}

/**
 * Issues a grant when the user types `/genie:approve …` or `/genie:abort …`. UserPromptExpansion
 * fires only for commands the user typed, never for ones the model invokes, and before the
 * command's own shell step runs `genie approve`, which redeems the grant.
 */
export function promptExpansion(input: PromptExpansionInput, now = new Date().toISOString()): string | undefined {
  if (input.expansion_type !== 'slash_command' || !input.command_name) return undefined;
  const slash = parseSlash(`/${input.command_name} ${input.command_args ?? ''}`);
  if (!slash) return undefined;
  const root = findRoot(input.cwd);
  if (!existsSync(repoConfigPath(root))) return undefined;
  const id = liveRunId(root) ?? currentRunId(root);
  if (!id) return undefined;
  return issueGrant(root, id, slash.command, slash.args, now, input.session_id).nonce;
}
