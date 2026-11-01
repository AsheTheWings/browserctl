// Process and socket facts read from /proc, for integration tests in the image.

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

export function processesOf(uid: number): Array<{ pid: number; cmdline: string[] }> {
  const found: Array<{ pid: number; cmdline: string[] }> = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^[0-9]+$/.test(entry)) continue;
    try {
      const status = readFileSync(`/proc/${entry}/status`, 'utf8');
      if (Number(/^Uid:\s+([0-9]+)/m.exec(status)?.[1]) !== uid || /^State:\s+Z/m.test(status)) continue;
      found.push({ pid: Number(entry), cmdline: readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').filter(Boolean) });
    } catch {
      // Exited while being read.
    }
  }
  return found;
}

export function statusField(pid: number, field: string): string | undefined {
  return new RegExp(`^${field}:\\s+(.*)$`, 'm').exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1];
}

/** Listening TCP sockets owned by a user, from /proc/net/tcp and tcp6. */
export function listeningSocketsOf(uid: number): string[] {
  const found: string[] = [];
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    for (const line of readFileSync(file, 'utf8').split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length > 7 && fields[3] === '0A' && Number(fields[7]) === uid) found.push(fields[1]!);
    }
  }
  return found;
}

/** Whether a user can read a path, by running cat or ls as that user. */
export function canRead(uid: number, gid: number, path: string, directory = false): boolean {
  const result = spawnSync(directory ? 'ls' : 'cat', [path], { uid, gid, stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } });
  return result.status === 0;
}

export async function eventually(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
