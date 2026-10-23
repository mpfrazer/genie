import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { grant } from './test-helpers.ts';

const CLI = fileURLToPath(new URL('../cli.ts', import.meta.url));

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'genie-tamper-'));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  return root;
}

const home = (root: string) => join(root, '.genie-home');

/** Runs genie as the model would: no grant for approve or abort. */
function genie(root: string, args: string[], input?: string) {
  return spawnSync('node', [CLI, ...args], { cwd: root, input, encoding: 'utf8', env: { ...process.env, GENIE_HOME: home(root) } });
}

function ok(root: string, args: string[]) {
  const res = genie(root, args);
  assert.equal(res.status, 0, `genie ${args.join(' ')}: ${res.stderr}${res.stdout}`);
  return res.stdout;
}

/** Runs a human-only command as the user typing `/genie:<args>` does. */
function typed(root: string, args: string[]) {
  grant(root, home(root), args);
  return genie(root, args);
}

function hook(root: string, payload: object) {
  const res = genie(root, ['hook', 'pre-tool-use'], JSON.stringify({ cwd: root, ...payload }));
  return res.stdout ? JSON.parse(res.stdout).hookSpecificOutput : undefined;
}

/** A run waiting at spec.approved. */
function atSpecApproval(): { root: string; dir: string } {
  const root = repo();
  ok(root, ['init', '--profile', 'internal-tool']);
  ok(root, ['new', 'Tamper target']);
  const dir: string = JSON.parse(ok(root, ['next', '--json'])).run.dir;
  writeFileSync(join(dir, 'spec.md'), '# spec');
  ok(root, ['done', 'spec']);
  return { root, dir };
}

describe('human-only commands need the user to type them', () => {
  it('refuses approve and abort without a grant, and honours one grant once', () => {
    const { root } = atSpecApproval();
    assert.match(genie(root, ['approve', 'spec.approved']).stderr, /only acts on a command the user typed.*\/genie:approve spec\.approved/);
    assert.match(genie(root, ['abort']).stderr, /only acts on a command the user typed/);

    // A grant is for what the user typed: not another gate, and not a rejection instead of an approval.
    grant(root, home(root), ['approve', 'spec.approved', '--reject']);
    assert.notEqual(genie(root, ['approve', 'spec.approved']).status, 0);
    assert.equal(genie(root, ['approve', 'spec.approved', '--reject', '--note', 'redo']).status, 0);
    assert.notEqual(genie(root, ['approve', 'spec.approved', '--reject']).status, 0, 'used up');

    // A hand-written grant doesn't carry a valid MAC.
    const id = readFileSync(join(root, '.genie/runs/CURRENT'), 'utf8').trim();
    const grants = join(root, '.genie/runs', id, 'grants');
    grant(root, home(root), ['approve', 'plan.approved']);
    const [file] = readdirSync(grants);
    const forged = JSON.parse(readFileSync(join(grants, file!), 'utf8'));
    writeFileSync(join(grants, file!), JSON.stringify({ ...forged, args: 'spec.approved' }));
    assert.match(genie(root, ['approve', 'spec.approved']).stderr, /only acts on a command the user typed/);

    const log = readFileSync(join(root, '.genie/runs', id, 'log.jsonl'), 'utf8');
    assert.match(log, /"verdict":"fail","by":"human".*"grant":"[0-9a-f]{24}"/);
  });

  it('ignores slash commands that are not genie human-only commands', () => {
    const { root } = atSpecApproval();
    const id = readFileSync(join(root, '.genie/runs/CURRENT'), 'utf8').trim();
    const payload = (command_name: string) =>
      JSON.stringify({ cwd: root, expansion_type: 'slash_command', command_name, command_args: 'spec.approved' });
    for (const name of ['approve', 'other:approve', 'genie:next']) genie(root, ['hook', 'user-prompt-expansion'], payload(name));
    assert.throws(() => readdirSync(join(root, '.genie/runs', id, 'grants')));
  });
});

describe('run state is sealed', () => {
  it('detects state.json changed outside genie, and a human can accept it', () => {
    const { root, dir } = atSpecApproval();
    const path = join(dir, 'state.json');
    // The attack: mark the human gate passed by editing the file directly.
    writeFileSync(path, readFileSync(path, 'utf8').replace(/("spec\.approved": \{\s*"status": )"pending"/, '$1"pass"'));

    assert.match(genie(root, ['status']).stderr, /state\.json was changed outside genie.*\/genie:approve state/);
    assert.match(genie(root, ['done', 'decompose']).stderr, /changed outside genie/);
    const push = hook(root, { tool_name: 'Bash', tool_input: { command: 'git push -u origin HEAD' } });
    assert.equal(push.permissionDecision, 'deny');
    assert.match(push.permissionDecisionReason, /can't read the active run: .*changed outside genie/);

    assert.match(typed(root, ['approve', 'state', '--reject']).stderr, /abort it/);
    assert.equal(typed(root, ['approve', 'state', '--note', 'checked: I did this']).status, 0);
    assert.match(ok(root, ['status']), /decompose/, 'accepted as it stands');
    assert.match(readFileSync(join(dir, 'log.jsonl'), 'utf8'), /"type":"state.accepted","by":"human","source":"human","grant":"[0-9a-f]+","note":"checked: I did this"/);
    assert.match(typed(root, ['approve', 'state']).stderr, /verifies; there is nothing to accept/);
  });

  it('detects log lines changed, removed, or added', () => {
    const { root, dir } = atSpecApproval();
    const log = join(dir, 'log.jsonl');
    const original = readFileSync(log, 'utf8');
    const lines = original.trimEnd().split('\n');

    writeFileSync(log, `${[lines[0], lines[1]!.replace('"stage.started"', '"stage.skipped"'), ...lines.slice(2)].join('\n')}\n`);
    assert.match(genie(root, ['status']).stderr, /log\.jsonl was changed outside genie \(line 2\)/);

    writeFileSync(log, `${lines.slice(0, -1).join('\n')}\n`);
    assert.match(genie(root, ['status']).stderr, /log\.jsonl has lines added or removed/);

    writeFileSync(log, original);
    appendFileSync(log, '{"type":"gate.verdict","gate":"spec.approved","verdict":"pass","by":"human"}\n');
    assert.match(genie(root, ['status']).stderr, /log\.jsonl has lines added or removed/);

    writeFileSync(log, original);
    ok(root, ['status']);
  });

  it("finds the live run even when CURRENT is removed", () => {
    const { root } = atSpecApproval();
    rmSync(join(root, '.genie/runs/CURRENT'));
    const pr = hook(root, { tool_name: 'Bash', tool_input: { command: 'gh pr create --fill' } });
    assert.equal(pr.permissionDecision, 'deny');
    assert.match(pr.permissionDecisionReason, /Opening a pull request/);
  });

  it('keeps the sealing key away from the model', () => {
    const { root } = atSpecApproval();
    const key = join(home(root), 'secret');
    for (const command of [`cat ${key}`, 'cat ~/.genie/secret', `cp ${key} /tmp/k`, 'cd ~/.genie && cat secret']) {
      const out = hook(root, { tool_name: 'Bash', tool_input: { command } });
      assert.equal(out?.permissionDecision, 'deny', command);
    }
    assert.equal(hook(root, { tool_name: 'Read', tool_input: { file_path: key } })?.permissionDecision, 'deny');
    assert.equal(hook(root, { tool_name: 'Grep', tool_input: { pattern: 'x', path: key } })?.permissionDecision, 'deny');
    assert.equal(hook(root, { tool_name: 'Read', tool_input: { file_path: join(root, 'README.md') } }), undefined);
  });
});

describe('a live run follows its own config', () => {
  it('waits for the user to apply config edits, and judges outward actions by the snapshot', () => {
    const { root } = atSpecApproval();
    appendFileSync(join(root, '.genie/config.yaml'), 'gates:\n  spec.approved:\n    enabled: false\n');
    const status = ok(root, ['status']);
    assert.match(status, /Waiting for a human decision on spec\.approved/, 'still the snapshot');
    assert.match(status, /config\.yaml changed since the run started \(gates\.spec\.approved\.enabled\).*\/genie:approve config/);
    assert.deepEqual(JSON.parse(ok(root, ['next', '--json'])).configPending, ['gates.spec.approved.enabled']);

    assert.match(genie(root, ['approve', 'config']).stderr, /only acts on a command the user typed/);
    assert.equal(typed(root, ['approve', 'config']).status, 0);
    const after = ok(root, ['status']);
    assert.match(after, /spec\.approved:skipped/);
    assert.doesNotMatch(after, /changed since the run started/);
    assert.match(typed(root, ['approve', 'config']).stderr, /nothing to apply/);
  });

  it("won't let a mode switch hand a waiting human decision to an agent", () => {
    const root = repo();
    ok(root, ['init', '--profile', 'internal-tool']);
    ok(root, ['new', 'Plan first']);
    const dir: string = JSON.parse(ok(root, ['next', '--json'])).run.dir;
    writeFileSync(join(dir, 'spec.md'), '# spec\n\n- R1: one\n');
    ok(root, ['done', 'spec']);
    typed(root, ['approve', 'spec.approved']);
    writeFileSync(join(dir, 'plan.yaml'), JSON.stringify({ slices: [{ id: 'S1', title: 'One', goal: 'g', covers: ['R1'], tests: ['t'], depends_on: [] }] }));
    ok(root, ['done', 'decompose']);
    assert.match(genie(root, ['mode', 'orchestrated']).stderr, /plan\.approved is waiting on a human decision/);
    assert.equal(typed(root, ['approve', 'plan.approved']).status, 0);
    ok(root, ['mode', 'orchestrated']);
  });
});
