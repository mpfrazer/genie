import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { detect, GITHUB_CI_COMMAND } from './detect.ts';

function repo(remote: string | undefined, workflows: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'genie-detect-'));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  if (remote) spawnSync('git', ['remote', 'add', 'origin', remote], { cwd: root });
  if (workflows.length > 0) {
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    for (const name of workflows) writeFileSync(join(root, '.github', 'workflows', name), 'on: pull_request\n');
  }
  return root;
}

describe('detect', () => {
  it('sets the CI command for GitHub repos with workflows', () => {
    const found = detect(repo('https://github.com/acme/app.git', ['ci.yml']));
    assert.equal(found.provider, 'github');
    assert.equal(found.ciCommand, GITHUB_CI_COMMAND);
  });

  it('leaves the CI command unset without workflows or without GitHub', () => {
    assert.equal(detect(repo('https://github.com/acme/app.git')).ciCommand, undefined);
    assert.equal(detect(repo('https://github.com/acme/app.git', ['notes.md'])).ciCommand, undefined);
    assert.equal(detect(repo('https://gitlab.com/acme/app.git', ['ci.yml'])).ciCommand, undefined);
    assert.equal(detect(repo(undefined, ['ci.yml'])).ciCommand, undefined);
  });

  it('waits for checks to register before watching them', () => {
    // `gh pr checks` reports "no checks reported" (exit 1) until the forge registers the
    // workflow runs; watching straight away would fail every freshly pushed PR.
    const lines = GITHUB_CI_COMMAND.split('\n');
    assert.match(lines[1]!, /grep -q "no checks reported" \|\| break/);
    assert.equal(lines.at(-1), 'gh pr checks --watch --interval 15');
  });
});
