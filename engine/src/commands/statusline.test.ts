import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { describeStatusline } from '../format.ts';
import { newRunState } from '../state.ts';

const CLI = fileURLToPath(new URL('../cli.ts', import.meta.url));

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'genie-statusline-'));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  return root;
}

function genie(root: string, args: string[], input?: string) {
  return spawnSync('node', [CLI, ...args], {
    cwd: root,
    input,
    encoding: 'utf8',
    env: { ...process.env, GENIE_HOME: join(root, '.genie-home') },
  });
}

/** Runs the status line from an unrelated cwd, as Claude Code does, pointing at `dir` via the payload. */
function line(dir: string, payload?: string): { stdout: string; status: number | null } {
  const input = payload ?? JSON.stringify({ hook_event_name: 'Status', workspace: { current_dir: dir }, cwd: dir });
  const res = genie(tmpdir(), ['statusline'], input);
  return { stdout: res.stdout, status: res.status };
}

describe('genie statusline', () => {
  it('prints nothing outside genie repos', () => {
    assert.deepEqual(line(repo()), { stdout: '', status: 0 });
  });

  it('prints nothing when there is no active run', () => {
    const root = repo();
    genie(root, ['init']);
    assert.deepEqual(line(root), { stdout: '', status: 0 });
  });

  it('shows the stage and the next step for an active run', () => {
    const root = repo();
    genie(root, ['init']);
    genie(root, ['new', 'Add a greeting for new users on the dashboard']);
    assert.equal(line(root).stdout, 'genie Add a greeting for new … ▸ spec/work · /genie:next\n');
  });

  it('flags a waiting human gate', () => {
    const root = repo();
    genie(root, ['init']);
    genie(root, ['new', 'Short']);
    const { run } = JSON.parse(genie(root, ['next', '--json']).stdout);
    writeFileSync(join(run.dir, 'spec.md'), '# spec');
    genie(root, ['done', 'spec']);
    assert.equal(line(root).stdout, 'genie Short ▸ spec/exit · ⏸ /genie:approve spec.approved\n');
  });

  it('falls back to cwd when workspace is missing', () => {
    const root = repo();
    genie(root, ['init']);
    genie(root, ['new', 'Short']);
    assert.match(line(root, JSON.stringify({ cwd: root })).stdout, /^genie Short ▸ spec\/work/);
  });

  it('prints nothing, successfully, for malformed or broken input', () => {
    assert.deepEqual(line('', 'not json'), { stdout: '', status: 0 });
    assert.deepEqual(line('', ''), { stdout: '', status: 0 });
    const root = repo();
    genie(root, ['init']);
    genie(root, ['new', 'Short']);
    writeFileSync(join(root, '.genie/config.yaml'), 'gates:\n  nope: {}\n');
    assert.deepEqual(line(root), { stdout: '', status: 0 });
  });
});

describe('describeStatusline', () => {
  it('names the slice and passes --slice to approve for slice gates', () => {
    const state = newRunState({ id: 'r1', title: 'Short', mode: 'guided', branch: 'genie/r1', base: 'main' }, '2026-01-01T00:00:00Z');
    state.stage = 'implement';
    state.stages.implement.phase = 'exit';
    const slice = { id: 'S2', title: 'Two', goal: 'g', covers: [], tests: [], depends_on: [] };
    assert.equal(
      describeStatusline(state, { type: 'await_human', gate: 'slice.reviewed', reason: 'r', slice }),
      'genie Short ▸ implement/exit S2 · ⏸ /genie:approve slice.reviewed --slice S2',
    );
  });
});
