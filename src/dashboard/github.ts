// GitHub's authorization code flow, with a per-browser state cookie and a server-side PKCE verifier.

import { createHash, randomBytes } from 'node:crypto';
import { readProtectedFile, type DashboardConfig } from '../config/config.ts';
import { BrowserctlError } from '../errors.ts';
import { emitEvent } from '../telemetry/signals.ts';

export const STATE_COOKIE = 'browserctl_github';
export const STATE_SECONDS = 10 * 60;
export const CALLBACK_PATH = '/dashboard/login/callback';
const MAX_PENDING = 64;
const REQUEST_TIMEOUT_MS = 10_000;
const GITHUB = 'https://github.com/login/oauth';
const API = 'https://api.github.com';
const API_HEADERS = { accept: 'application/vnd.github+json', 'user-agent': 'browserctl', 'x-github-api-version': '2026-03-10' };

interface Pending {
  browser: string;
  verifier: string;
  expiresAt: number;
}

const randomToken = () => randomBytes(32).toString('base64url');
const githubFailure = () => new BrowserctlError('auth_unavailable', 'GitHub sign-in is unavailable. Open the dashboard to try again.');

export class GithubSignIn {
  readonly #pending = new Map<string, Pending>();
  readonly #config: Extract<DashboardConfig, { type: 'github' }>;
  readonly #callback: string;
  readonly #request: typeof fetch;

  constructor(config: Extract<DashboardConfig, { type: 'github' }>, publicBaseUrl: string, request: typeof fetch = fetch) {
    this.#config = config;
    this.#callback = new URL(CALLBACK_PATH, publicBaseUrl).href;
    this.#request = request;
  }

  start(now = Date.now()): { location: string; browser: string } {
    for (const [state, entry] of this.#pending) if (entry.expiresAt <= now) this.#pending.delete(state);
    if (this.#pending.size >= MAX_PENDING) this.#pending.delete(this.#pending.keys().next().value!);

    const state = randomToken();
    const browser = randomToken();
    const verifier = randomToken();
    this.#pending.set(state, { browser, verifier, expiresAt: now + STATE_SECONDS * 1000 });
    const query = new URLSearchParams({
      client_id: this.#config.clientId,
      redirect_uri: this.#callback,
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      allow_signup: 'false',
    });
    return { location: `${GITHUB}/authorize?${query}`, browser };
  }

  async complete(url: URL, browser: string | undefined, now = Date.now()): Promise<number> {
    const state = url.searchParams.get('state') ?? '';
    const entry = this.#pending.get(state);
    if (!entry || entry.expiresAt <= now || entry.browser !== browser || url.searchParams.getAll('state').length !== 1) {
      throw new BrowserctlError('invalid_request', 'GitHub sign-in has expired or belongs to another browser. Open the dashboard to try again.');
    }
    this.#pending.delete(state);
    if (url.searchParams.has('error')) throw new BrowserctlError('unauthorized', 'GitHub sign-in was declined.');
    const code = url.searchParams.get('code');
    if (!code || url.searchParams.getAll('code').length !== 1) {
      throw new BrowserctlError('invalid_request', 'GitHub sign-in did not return a code. Open the dashboard to try again.');
    }

    let secret: string;
    try {
      secret = readProtectedFile(this.#config.clientSecretFile, 'BROWSERCTL_GITHUB_CLIENT_SECRET_FILE', false);
    } catch {
      throw githubFailure();
    }
    const token = (await this.#json(`${GITHUB}/access_token`, {
      method: 'POST',
      headers: { accept: 'application/json' },
      body: new URLSearchParams({
        client_id: this.#config.clientId,
        client_secret: secret,
        redirect_uri: this.#callback,
        code,
        code_verifier: entry.verifier,
      }),
    })).access_token;
    if (typeof token !== 'string' || token.length === 0) throw githubFailure();

    try {
      const user = await this.#json(`${API}/user`, {
        headers: { ...API_HEADERS, authorization: `Bearer ${token}` },
      });
      if (typeof user.id !== 'number' || !Number.isSafeInteger(user.id) || user.id < 1) throw githubFailure();
      return user.id;
    } finally {
      await this.#revoke(secret, token);
    }
  }

  async #json(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    try {
      const response = await this.#send(url, init);
      if (!response.ok) throw githubFailure();
      const body: unknown = await response.json();
      if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
    } catch {
      throw githubFailure();
    }
    throw githubFailure();
  }

  async #revoke(secret: string, token: string): Promise<void> {
    const basic = Buffer.from(`${this.#config.clientId}:${secret}`).toString('base64');
    try {
      const response = await this.#send(`${API}/applications/${encodeURIComponent(this.#config.clientId)}/token`, {
        method: 'DELETE',
        headers: { ...API_HEADERS, authorization: `Basic ${basic}`, 'content-type': 'application/json' },
        body: JSON.stringify({ access_token: token }),
      });
      if (response.status === 204) return;
    } catch {
      // GitHub's failure to revoke does not change the verified identity.
    }
    emitEvent('browserctl.github.token_revoke_failed', { 'error.type': 'auth_unavailable' });
  }

  #send(url: string, init: RequestInit): Promise<Response> {
    return this.#request(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  }
}
