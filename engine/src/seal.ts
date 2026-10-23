// Tamper evidence for run state. Every write the engine makes is MACed with a per-user key kept
// outside the repo, so a change made any other way (an interpreter one-liner, a script) shows up the
// next time the run is loaded. This raises the bar rather than closing it: the model runs as the
// user, so it could read the key indirectly too. The hook denies the direct routes to it.
import { createHmac, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GenieError } from './errors.ts';
import { userConfigDir } from './config/load.ts';

/** Run state that failed verification. Only a human can accept it again (`/genie:approve state`). */
export class TamperError extends GenieError {}

export const KEY_FILE = 'secret';

export function keyPath(): string {
  return join(userConfigDir(), KEY_FILE);
}

let cached: { path: string; key: Buffer } | undefined;

/** The per-user sealing key, created (readable by the user only) on first use. */
export function sealKey(): Buffer {
  const path = keyPath();
  if (cached?.path === path) return cached.key;
  if (!existsSync(path)) {
    mkdirSync(userConfigDir(), { recursive: true });
    try {
      writeFileSync(path, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
    } catch (err) {
      // Another genie process created it first; use theirs.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  chmodSync(path, 0o600);
  const key = Buffer.from(readFileSync(path, 'utf8').trim(), 'hex');
  if (key.length < 32) throw new GenieError(`${path} is not a genie key (delete it to make a new one; every run will then need /genie:approve state)`);
  cached = { path, key };
  return key;
}

export function mac(data: string): string {
  return createHmac('sha256', sealKey()).update(data).digest('hex');
}

/** The next link of the log's MAC chain: each line's MAC covers every line before it. */
export function chainLink(prev: string, line: string): string {
  return mac(`${prev}\n${line}`);
}

/** The seal over a state object's serialized form, excluding the seal itself. */
export function stateSeal(state: object): string {
  const { seal: _, ...rest } = state as { seal?: string };
  return mac(JSON.stringify(rest, null, 2));
}
