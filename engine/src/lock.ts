// A per-run mutex, so concurrent genie processes (parallel subagents recording work and verdicts)
// can't lose each other's updates. It's a lock file created exclusively; a lock whose holder has
// exited is taken over, so a crashed process never wedges the run.
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { GenieError } from './errors.ts';

export interface LockOptions {
  /** How long to wait for a live holder before giving up. */
  timeoutMs?: number;
  /** How often to retry while waiting. */
  pollMs?: number;
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));

function sleep(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

function holder(path: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(path, 'utf8'), 10);
    return Number.isFinite(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function tryAcquire(path: string): boolean {
  try {
    const fd = openSync(path, 'wx');
    writeSync(fd, `${process.pid}\n`);
    closeSync(fd);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

/** Runs `fn` holding the lock at `path`. */
export function withLock<T>(path: string, fn: () => T, opts: LockOptions = {}): T {
  const { timeoutMs = 120_000, pollMs = 25 } = opts;
  const deadline = Date.now() + timeoutMs;
  while (!tryAcquire(path)) {
    const pid = holder(path);
    // No pid yet means the holder is between creating and writing the file: wait for it.
    // Two waiters can both see the same dead holder; the window is a crash plus contention at the
    // same instant, which is rare enough to accept.
    if (pid !== undefined && pid !== process.pid && !alive(pid)) {
      try {
        unlinkSync(path);
      } catch {
        // Another waiter took it over first.
      }
      continue;
    }
    if (pid === process.pid) throw new GenieError(`${path} is already held by this process`);
    if (Date.now() > deadline) {
      throw new GenieError(`timed out waiting for ${path} (held by pid ${pid ?? 'unknown'})`);
    }
    sleep(pollMs);
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(path);
    } catch {
      // Already gone: nothing to release.
    }
  }
}
