// The image's fixed per-session users. Pair n has browser user 1100+n, which runs Chrome, and session user 1200+n,
// which runs the Playwright worker and task runs; both have group 1300+n. The Containerfile creates the same users.

import { readdir, readFile } from 'node:fs/promises';
import { BrowserctlError } from '../errors.ts';

export const PAIRS = 32;

export interface UserPair {
  index: number;
  browserUid: number;
  sessionUid: number;
  gid: number;
}

export function pair(index: number): UserPair {
  return { index, browserUid: 1100 + index, sessionUid: 1200 + index, gid: 1300 + index };
}

/** Hands each live session a pair no other live session holds. */
export class UserPool {
  readonly #free: number[];

  constructor(size = PAIRS) {
    this.#free = Array.from({ length: size }, (_, index) => index + 1);
  }

  take(): UserPair {
    const index = this.#free.shift();
    if (index === undefined) throw new BrowserctlError('capacity', 'no free session users');
    return pair(index);
  }

  give(user: UserPair): void {
    if (!this.#free.includes(user.index)) this.#free.push(user.index);
  }
}

/** Kill every process a user owns, so nothing a session started outlives it into the pair's next session. */
export async function killUserProcesses(uid: number): Promise<void> {
  for (let round = 0; round < 20; round += 1) {
    const owned: number[] = [];
    for (const entry of await readdir('/proc')) {
      if (!/^[0-9]+$/.test(entry)) continue;
      try {
        const status = await readFile(`/proc/${entry}/status`, 'utf8');
        const real = /^Uid:\s+([0-9]+)/m.exec(status)?.[1];
        // A zombie has exited already; the image's init reaps it.
        if (Number(real) === uid && !/^State:\s+Z/m.test(status)) owned.push(Number(entry));
      } catch {
        // The process exited while it was being read.
      }
    }
    if (owned.length === 0) return;
    for (const pid of owned) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new BrowserctlError('internal', 'processes of a session user would not exit');
}
