// The dashboard session cookie identifies the configured GitHub owner. Only its hash is kept on disk.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { BrowserctlError } from '../errors.ts';
import { Serializer, readJson, writeJson } from '../state/files.ts';

export const SESSION_SECONDS = 7 * 24 * 60 * 60;
export const COOKIE = 'browserctl_dashboard';

interface StoredSession {
  sha256: string;
  ownerId: number;
  expiresAt: number;
}

interface SessionFile {
  version: 2;
  sessions: StoredSession[];
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/** The value of one cookie in a Cookie header. */
export function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return undefined;
}

export class DashboardAuth {
  readonly #path: string;
  readonly #ownerId: number;
  readonly #serializer = new Serializer();
  #sessions: StoredSession[] = [];

  constructor(stateDirectory: string, ownerId: number) {
    this.#path = join(stateDirectory, 'dashboard-sessions.json');
    this.#ownerId = ownerId;
  }

  async load(now = Date.now()): Promise<void> {
    let file: { version?: unknown; sessions?: StoredSession[] } | undefined;
    try {
      file = await readJson(this.#path);
    } catch {
      throw new BrowserctlError('internal', 'dashboard-sessions.json in the state directory is unreadable or malformed');
    }
    if (file === undefined || file?.version === 1) {
      this.#sessions = [];
      return;
    }
    const sessions = file?.sessions;
    if (file?.version !== 2 || !Array.isArray(sessions) || !sessions.every((entry) =>
      typeof entry?.sha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.sha256) &&
      Number.isSafeInteger(entry.ownerId) && entry.ownerId > 0 && Number.isSafeInteger(entry.expiresAt))) {
      throw new BrowserctlError('internal', 'dashboard-sessions.json in the state directory is malformed');
    }
    this.#sessions = sessions.filter((entry) => entry.expiresAt > now && entry.ownerId === this.#ownerId);
  }

  async issue(ownerId: number, now = Date.now()): Promise<string> {
    if (ownerId !== this.#ownerId) throw new BrowserctlError('unauthorized', 'this GitHub account does not have dashboard access');
    const cookie = randomBytes(32).toString('base64url');
    await this.#serializer.run(() => this.#save([
      ...this.#sessions.filter((session) => session.expiresAt > now),
      { sha256: hash(cookie), ownerId, expiresAt: now + SESSION_SECONDS * 1000 },
    ]));
    return cookie;
  }

  authenticate(request: IncomingMessage, now = Date.now()): StoredSession | undefined {
    const cookie = cookieValue(request.headers.cookie, COOKIE);
    if (!cookie || !/^[A-Za-z0-9_-]{43}$/.test(cookie)) return undefined;
    const presented = Buffer.from(hash(cookie), 'hex');
    return this.#sessions.find((entry) => entry.expiresAt > now && timingSafeEqual(presented, Buffer.from(entry.sha256, 'hex')));
  }

  revoke(session: StoredSession): Promise<void> {
    return this.#serializer.run(() => this.#save(this.#sessions.filter((entry) => entry.sha256 !== session.sha256)));
  }

  async #save(sessions: StoredSession[]): Promise<void> {
    await writeJson(this.#path, { version: 2, sessions } satisfies SessionFile);
    this.#sessions = sessions;
  }
}

export const githubActor = (ownerId: number) => `github:${ownerId}`;

/** Whether a request's Origin is the public base URL's origin. */
export function sameOrigin(request: IncomingMessage, publicBaseUrl: string): boolean {
  const origin = request.headers.origin;
  return typeof origin === 'string' && origin === new URL(publicBaseUrl).origin;
}
