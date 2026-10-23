import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../cli.ts', import.meta.url));

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'genie-hook-'));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  return root;
}

function genie(root: string, args: string[], stdin?: string) {
  return spawnSync('node', [CLI, ...args], {
    cwd: root,
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, GENIE_HOME: join(root, '.genie-home') },
  });
}

function hook(root: string, payload: object): { decision?: string; reason?: string; stderr: string } {
  const res = genie(root, ['hook', 'pre-tool-use'], JSON.stringify({ cwd: root, ...payload }));
  assert.equal(res.status, 0, res.stderr);
  if (!res.stdout.trim()) return { stderr: res.stderr };
  const out = JSON.parse(res.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  return { decision: out.permissionDecision, reason: out.permissionDecisionReason, stderr: res.stderr };
}

const bash = (command: string, agent_type?: string) => ({ tool_name: 'Bash', tool_input: { command }, agent_type });

describe('genie hook pre-tool-use', () => {
  it('stays silent in repos without genie', () => {
    const root = repo();
    assert.deepEqual(hook(root, bash('git push origin main')), { stderr: '' });
  });

  it('enforces gates against the active run', () => {
    const root = repo();
    assert.equal(genie(root, ['init', '--profile', 'internal-tool']).status, 0);
    assert.equal(hook(root, bash('gh pr create --fill')).decision, undefined, 'no run yet: allowed');

    assert.equal(genie(root, ['new', 'Add a thing']).status, 0);
    const pr = hook(root, bash('cd sub && gh pr create --fill'));
    assert.equal(pr.decision, 'deny');
    assert.match(pr.reason!, /reaches the pr stage .* at spec\/work/);

    assert.equal(hook(root, bash('git push origin main')).decision, 'deny');
    assert.equal(hook(root, bash('genie approve spec.approved')).decision, 'deny');
    assert.equal(hook(root, bash('ls -la && git status')).decision, undefined);
  });

  it('guards run state and config against file tools', () => {
    const root = repo();
    genie(root, ['init']);
    genie(root, ['new', 'x']);
    const id = JSON.parse(genie(root, ['status', '--json']).stdout).state.id as string;
    const write = (file_path: string) => hook(root, { tool_name: 'Write', tool_input: { file_path } });
    assert.equal(write(join(root, '.genie/runs', id, 'state.json')).decision, 'deny');
    assert.equal(write(`.genie/runs/${id}/log.jsonl`).decision, 'deny');
    assert.equal(write(join(root, '.genie/runs', id, 'spec.md')).decision, undefined);
    assert.equal(hook(root, { tool_name: 'Edit', tool_input: { file_path: join(root, '.genie/config.yaml') } }).decision, 'ask');
  });

  it('fails closed on outward actions when the config is broken', () => {
    const root = repo();
    genie(root, ['init']);
    writeFileSync(join(root, '.genie/config.yaml'), 'gates:\n  nope: {}\n');
    const res = hook(root, bash('gh pr merge 1'));
    assert.equal(res.decision, 'deny');
    assert.match(res.reason!, /config failed to load/);
    assert.equal(hook(root, bash('ls')).decision, undefined);
  });

  it('fails open, with a warning, on an unreadable payload', () => {
    const res = genie(repo(), ['hook', 'pre-tool-use'], 'not json');
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
    assert.match(res.stderr, /genie hook:/);
  });
});
