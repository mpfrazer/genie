import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { withLock } from './lock.ts';

const lockPath = () => join(mkdtempSync(join(tmpdir(), 'genie-lock-')), 'state.json.lock');

describe('withLock', () => {
  it('holds the lock while running and releases it after, even on error', () => {
    const path = lockPath();
    assert.equal(withLock(path, () => existsSync(path)), true);
    assert.ok(!existsSync(path));
    assert.throws(() => withLock(path, () => { throw new Error('boom'); }), /boom/);
    assert.ok(!existsSync(path));
  });

  it('takes over a lock left by a process that has exited', () => {
    const path = lockPath();
    const dead = spawnSync('node', ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
    writeFileSync(path, `${dead}\n`);
    assert.equal(withLock(path, () => 'ran', { timeoutMs: 500 }), 'ran');
  });

  it('waits for a live holder, then times out', () => {
    const path = lockPath();
    writeFileSync(path, `${process.ppid}\n`);
    const started = Date.now();
    assert.throws(() => withLock(path, () => 'ran', { timeoutMs: 100 }), /timed out waiting for .* \(held by pid \d+\)/);
    assert.ok(Date.now() - started >= 100);
  });
});
