// Client tokens: 256 random bits shown once, stored only as SHA-256 hashes, compared in constant time.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { BrowserctlError } from '../errors.ts';
import { Serializer, readJson, writeJson } from '../state/files.ts';

export interface ClientRecord {
  name: string;
  sha256: string;
  createdAt: string;
}

interface TokenFile {
  version: 1;
  clients: ClientRecord[];
}

export const CLIENT_NAME = /^[a-z][a-z0-9-]{0,62}$/;
const TOKEN_PREFIX = 'bctl_';

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export class TokenStore {
  readonly #path: string;
  readonly #serializer = new Serializer();
  #clients: ClientRecord[] = [];
  #revokedListeners: Array<(name: string) => void> = [];

  constructor(stateDirectory: string) {
    this.#path = join(stateDirectory, 'tokens.json');
  }

  async load(): Promise<void> {
    const file = await readJson<TokenFile>(this.#path);
    this.#clients = file?.clients ?? [];
  }

  /** Create a client and return its token; the token is never stored or shown again. */
  create(name: string, now = new Date()): Promise<string> {
    return this.#serializer.run(async () => {
      if (!CLIENT_NAME.test(name)) throw new BrowserctlError('invalid_request', 'a client name is lower-case letters, digits, and hyphens');
      if (this.#clients.some((client) => client.name === name)) throw new BrowserctlError('conflict', `client ${name} exists`);
      const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
      const clients = [...this.#clients, { name, sha256: hashToken(token).toString('hex'), createdAt: now.toISOString() }];
      await writeJson(this.#path, { version: 1, clients } satisfies TokenFile);
      this.#clients = clients;
      return token;
    });
  }

  list(): Array<{ name: string; createdAt: string }> {
    return this.#clients.map(({ name, createdAt }) => ({ name, createdAt }));
  }

  has(name: string): boolean {
    return this.#clients.some((client) => client.name === name);
  }

  /** Revoke a client's token; its connections and dashboard sessions close through the revocation listeners. */
  revoke(name: string): Promise<void> {
    return this.#serializer.run(async () => {
      if (!this.has(name)) throw new BrowserctlError('not_found', `no client ${name}`);
      const clients = this.#clients.filter((client) => client.name !== name);
      await writeJson(this.#path, { version: 1, clients } satisfies TokenFile);
      this.#clients = clients;
      for (const listener of this.#revokedListeners) listener(name);
    });
  }

  onRevoked(listener: (name: string) => void): void {
    this.#revokedListeners.push(listener);
  }

  /** The client a presented token belongs to. Every stored hash is compared, each in constant time. */
  authenticate(token: string | undefined): string | undefined {
    if (!token) return undefined;
    const presented = hashToken(token);
    let match: string | undefined;
    for (const client of this.#clients) {
      if (timingSafeEqual(presented, Buffer.from(client.sha256, 'hex')) && match === undefined) match = client.name;
    }
    return match;
  }
}

/** The bearer token of an Authorization header, if it has one. */
export function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer ([A-Za-z0-9_-]{1,200})$/.exec(header ?? '');
  return match?.[1];
}
