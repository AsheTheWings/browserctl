// Dashboard access: one-time links the admin command issues for a client, and the session cookies they set. Links
// live in memory for 10 minutes; sessions last 7 days, kept as SHA-256 hashes in the state directory.
//
//   <state>/dashboard-sessions.json   { version: 1, sessions: [{ sha256, client, expiresAt }] }

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import type { TokenStore } from '../auth/tokens.ts';
import { BrowserctlError } from '../errors.ts';
import { Serializer, readJson, writeJson } from '../state/files.ts';

export const LINK_SECONDS = 10 * 60;
export const SESSION_SECONDS = 7 * 24 * 60 * 60;
export const COOKIE = 'browserctl_dashboard';

interface StoredSession {
  sha256: string;
  client: string;
  expiresAt: number;
}

interface SessionFile {
  version: 1;
  sessions: StoredSession[];
}

const hash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

function equalHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

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
  readonly #tokens: TokenStore;
  readonly #serializer = new Serializer();
  readonly #links = new Map<string, { client: string; expiresAt: number }>();
  #sessions: StoredSession[] = [];

  constructor(stateDirectory: string, tokens: TokenStore) {
    this.#path = join(stateDirectory, 'dashboard-sessions.json');
    this.#tokens = tokens;
  }

  async load(now = Date.now()): Promise<void> {
    let file: SessionFile | undefined;
    try {
      file = await readJson<SessionFile>(this.#path);
    } catch {
      throw new BrowserctlError('internal', 'dashboard-sessions.json in the state directory is unreadable or malformed');
    }
    const sessions = file?.sessions ?? [];
    if (!Array.isArray(sessions) || !sessions.every((entry) => /^[0-9a-f]{64}$/.test(String(entry?.sha256)) && typeof entry.client === 'string' && Number.isFinite(entry.expiresAt))) {
      throw new BrowserctlError('internal', 'dashboard-sessions.json in the state directory is malformed');
    }
    this.#sessions = sessions.filter((entry) => entry.expiresAt > now && this.#tokens.has(entry.client));
  }

  /** Issue a one-time link token for a client that holds a client token. */
  link(client: string, now = Date.now()): string {
    if (!this.#tokens.has(client)) throw new BrowserctlError('not_found', `no client ${client}`);
    for (const [key, entry] of this.#links) if (entry.expiresAt <= now) this.#links.delete(key);
    const token = randomBytes(32).toString('base64url');
    this.#links.set(hash(token), { client, expiresAt: now + LINK_SECONDS * 1000 });
    return token;
  }

  /** Spend a link token once and start a dashboard session; returns the session cookie's value and its client. */
  redeem(token: string | undefined, now = Date.now()): Promise<{ cookie: string; client: string }> {
    return this.#serializer.run(async () => {
      const key = token ? hash(token) : undefined;
      const entry = key ? this.#links.get(key) : undefined;
      if (key) this.#links.delete(key);
      if (!entry || entry.expiresAt <= now || !this.#tokens.has(entry.client)) {
        throw new BrowserctlError('unauthorized', 'this dashboard link is invalid, used, or expired');
      }
      const cookie = randomBytes(32).toString('base64url');
      const sessions = [...this.#sessions.filter((session) => session.expiresAt > now), { sha256: hash(cookie), client: entry.client, expiresAt: now + SESSION_SECONDS * 1000 }];
      await writeJson(this.#path, { version: 1, sessions } satisfies SessionFile);
      this.#sessions = sessions;
      return { cookie, client: entry.client };
    });
  }

  /** The client of a request's dashboard session, while it is unexpired and its client's token is not revoked. */
  authenticate(request: IncomingMessage, now = Date.now()): string | undefined {
    const cookie = cookieValue(request.headers.cookie, COOKIE);
    if (!cookie || !/^[A-Za-z0-9_-]{43}$/.test(cookie)) return undefined;
    const presented = hash(cookie);
    let client: string | undefined;
    for (const session of this.#sessions) {
      if (equalHex(presented, session.sha256) && session.expiresAt > now && client === undefined) client = session.client;
    }
    return client && this.#tokens.has(client) ? client : undefined;
  }

  /** End every dashboard session and pending link of a client, such as when its token is revoked. */
  closeClient(client: string): Promise<void> {
    return this.#serializer.run(async () => {
      for (const [key, entry] of this.#links) if (entry.client === client) this.#links.delete(key);
      const sessions = this.#sessions.filter((session) => session.client !== client);
      if (sessions.length === this.#sessions.length) return;
      await writeJson(this.#path, { version: 1, sessions } satisfies SessionFile);
      this.#sessions = sessions;
    });
  }
}

/** Whether a request's Origin is the public base URL's origin. */
export function sameOrigin(request: IncomingMessage, publicBaseUrl: string): boolean {
  const origin = request.headers.origin;
  return typeof origin === 'string' && origin === new URL(publicBaseUrl).origin;
}
