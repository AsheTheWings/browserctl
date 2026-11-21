// The operator dashboard under /dashboard: its static pages, a JSON API over sessions, profiles, tasks, runs,
// providers, recordings, live page screencasts, and full browser views. Every API request and
// WebSocket needs a dashboard session; state changes and WebSockets also need the public base URL's Origin.

import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, relative as relativePath, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AuditLog } from '../audit.ts';
import { BrowserctlError } from '../errors.ts';
import type { ProfileStore } from '../profiles/store.ts';
import type { Providers } from '../providers/external.ts';
import type { RecordingStore } from '../recordings/store.ts';
import { notFound, readBody, refuseUpgrade, sendError, sendJson, type HttpRouter } from '../server/http.ts';
import { isPrivateProviderSession, type Session, type SessionManager } from '../sessions/manager.ts';
import { isDisplayBrowser, isWindowBrowser } from '../browser/display.ts';
import type { ServiceChecks } from '../tasks/checks.ts';
import type { RunLog } from '../tasks/runs.ts';
import type { TaskStore } from '../tasks/store.ts';
import { emitEvent, inSpan } from '../telemetry/signals.ts';
import { COOKIE, type DashboardAuth, SESSION_SECONDS, cookieValue, dashboardActor, sameOrigin } from './auth.ts';
import type { PasswordSignIn } from './password.ts';
import { CALLBACK_PATH, type GithubSignIn, STATE_COOKIE, STATE_SECONDS } from './github.ts';
import { socketViewer, type Screencast, type Screencasts, type Stream } from './screencast.ts';
import { bridgeVnc } from './vnc.ts';

const PREFIX = '/dashboard';
const STATIC = new URL('./static/', import.meta.url);
const NOVNC = new URL('../', import.meta.resolve('@novnc/novnc'));
const MAX_BODY_BYTES = 64 * 1024;
/** Saving waits this long for the sign-in Chrome to quit after SIGINT. */
export const SAVE_EXIT_TIMEOUT_MS = 30_000;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};
// noVNC decodes display rectangles and draws the remote cursor from data images.
const WORKSPACE_HEADERS = {
  ...SECURITY_HEADERS,
  'content-security-policy': SECURITY_HEADERS['content-security-policy'].replace("img-src 'self' blob:", "img-src 'self' blob: data:"),
};

export interface DashboardOptions {
  publicBaseUrl: string;
  auth: DashboardAuth;
  signIn: { github: GithubSignIn } | { password: PasswordSignIn };
  sessions: SessionManager;
  profiles: ProfileStore;
  tasks: TaskStore;
  runs: RunLog;
  checks: ServiceChecks;
  providers: Providers;
  screencasts: Screencasts;
  recordings: RecordingStore;
  audit: AuditLog;
}

const VIDEO = /^\/api\/recordings\/(s-[A-Za-z0-9_-]{12})\/video$/;
const WINDOW_VIDEO = /^\/api\/sessions\/(s-[A-Za-z0-9_-]{12})\/window$/;

export class Dashboard {
  readonly #options: DashboardOptions;
  readonly #sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
  /** Open WebSockets by session hash. */
  readonly #sessionSockets = new Map<string, Set<WebSocket>>();
  readonly #windowStreams = new Set<{ browser: string; credential: string; response: ServerResponse }>();
  readonly #openingSignIns = new Map<string, Promise<Session>>();

  constructor(options: DashboardOptions) {
    this.#options = options;
    options.sessions.onClose((session) => {
      for (const stream of this.#windowStreams) {
        if (stream.browser === session.id) stream.response.destroy();
      }
    });
  }

  mount(router: HttpRouter): void {
    router.route('/', (request, response, url) => {
      if (request.method !== 'GET' || url.pathname !== '/') return notFound(response);
      response.writeHead(303, { location: `${PREFIX}/`, ...SECURITY_HEADERS }).end();
    });
    router.route(PREFIX, (request, response, url) => this.#handle(request, response, url));
    router.upgrade(`${PREFIX}/ws`, (request, socket, head, url) => this.#upgrade(request, socket, head, url));
  }

  stop(): void {
    for (const sockets of this.#sessionSockets.values()) for (const socket of sockets) socket.terminate();
    for (const stream of this.#windowStreams) stream.response.destroy();
  }

  async #handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname;
    if (request.method === 'GET' && (path === PREFIX || path === `${PREFIX}/`)) {
      const signIn = 'github' in this.#options.signIn ? 'sign-in.html' : 'password.html';
      const page = this.#options.auth.authenticate(request) ? 'index.html' : signIn;
      return this.#static(response, page, STATIC, undefined, page === 'index.html' ? WORKSPACE_HEADERS : SECURITY_HEADERS);
    }
    if (request.method === 'GET' && path.startsWith(`${PREFIX}/static/`)) {
      const asset = path.slice(`${PREFIX}/static/`.length);
      return this.#static(response, asset, STATIC, /\.(css|js|svg|txt|woff2?)$/);
    }
    if (request.method === 'GET' && path.startsWith(`${PREFIX}/novnc/`)) return this.#static(response, path.slice(`${PREFIX}/novnc/`.length), NOVNC, /^(core|vendor)\//);
    const { signIn } = this.#options;
    if ('github' in signIn && request.method === 'GET') {
      if (path === `${PREFIX}/login`) return this.#startSignIn(response, signIn.github);
      if (path === CALLBACK_PATH) return this.#finishSignIn(request, response, url, signIn.github);
    } else if ('password' in signIn && request.method === 'POST' && path === `${PREFIX}/login`) {
      return this.#passwordSignIn(request, response, signIn.password);
    }
    if (!path.startsWith(`${PREFIX}/api/`)) return notFound(response);
    const changes = request.method !== 'GET' && request.method !== 'HEAD';
    if (changes && !sameOrigin(request, this.#options.publicBaseUrl)) {
      return sendJson(response, 403, { error: 'the request does not come from the dashboard', errorClass: 'unauthorized' });
    }
    const session = this.#options.auth.authenticate(request);
    if (!session) return sendJson(response, 401, { error: 'sign in to the dashboard', errorClass: 'unauthorized' });
    const client = dashboardActor(session.ownerId);
    if (request.method === 'POST' && path === `${PREFIX}/api/logout`) {
      await this.#options.auth.revoke(session);
      for (const socket of this.#sessionSockets.get(session.sha256) ?? []) socket.close(1008, 'signed out');
      for (const stream of this.#windowStreams) {
        if (stream.credential === session.sha256) stream.response.destroy();
      }
      await this.#options.audit.record(client, 'dashboard.logout');
      response.writeHead(204, {
        ...SECURITY_HEADERS,
        'set-cookie': this.#cookie(COOKIE, '', PREFIX, 0),
      }).end();
      return;
    }
    try {
      if (request.method === 'GET') {
        const route = path.slice(PREFIX.length);
        const live = WINDOW_VIDEO.exec(route);
        if (live) return this.#windowVideo(live[1]!, session, response);
        const video = VIDEO.exec(route);
        if (video) return this.#video(request, response, video[1]!);
      }
      const body = changes ? await this.#body(request) : {};
      const result = await this.#api(client, request.method ?? 'GET', path.slice(`${PREFIX}/api`.length), body);
      sendJson(response, result.status ?? 200, result.body);
    } catch (error) {
      sendError(response, error);
    }
  }

  #windowVideo(id: string, credential: { sha256: string; expiresAt: number }, response: ServerResponse): void {
    const session = this.#options.sessions.get(id);
    if (session?.state !== 'ready' || !isWindowBrowser(session.browser)) return notFound(response);
    const encoder = session.browser.captureWindow();
    const stream = { browser: session.id, credential: credential.sha256, response };
    this.#windowStreams.add(stream);
    const expiry = setTimeout(() => response.destroy(), Math.max(0, credential.expiresAt - Date.now())).unref();
    response.once('close', () => {
      this.#windowStreams.delete(stream);
      clearTimeout(expiry);
      encoder.kill('SIGKILL');
    });
    const failed = () => {
      if (response.destroyed) return;
      if (session.state === 'ready') {
        emitEvent('browserctl.dashboard.window.failed', { 'browserctl.session.id': id, 'error.type': 'internal' });
      }
      response.destroy();
    };
    encoder.once('error', failed);
    encoder.once('close', failed);
    encoder.stdout.once('error', failed);
    response.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'video/mp4', 'cross-origin-resource-policy': 'same-origin' });
    encoder.stdout.pipe(response, { end: false });
  }

  async #static(response: ServerResponse, requested: string, root: URL, allowed?: RegExp, headers = SECURITY_HEADERS): Promise<void> {
    const notFound = () => sendJson(response, 404, { error: 'not found', errorClass: 'not_found' });
    let path: string;
    try {
      // Resolve as a file path under the root, never as a URL, and refuse anything that leaves the root.
      const base = fileURLToPath(root);
      path = resolve(base, decodeURIComponent(requested));
      const inside = relativePath(base, path);
      if (!path.startsWith(base.endsWith(sep) ? base : `${base}${sep}`) || (allowed && !allowed.test(inside.split(sep).join('/')))) return notFound();
    } catch {
      return notFound();
    }
    const type = TYPES[extname(path)];
    if (!type) return notFound();
    let content: Buffer;
    try {
      content = await readFile(path);
    } catch {
      return notFound();
    }
    response.writeHead(200, { 'content-type': type, 'content-length': content.length, ...headers });
    response.end(content);
  }

  /** A finished recording's video, with byte ranges so a player can seek. */
  async #video(request: IncomingMessage, response: ServerResponse, session: string): Promise<void> {
    const path = this.#options.recordings.videoPath(session);
    const size = path ? await stat(path).then((entry) => entry.size, () => undefined) : undefined;
    if (!path || size === undefined) return sendJson(response, 404, { error: `no recording of ${session}`, errorClass: 'not_found' });
    const headers = { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', ...SECURITY_HEADERS };
    let start = 0;
    let end = size - 1;
    let status = 200;
    const range = request.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      const empty = !match || (!match[1] && !match[2]);
      if (match && !empty) {
        if (match[1]) {
          start = Number(match[1]);
          if (match[2]) end = Math.min(Number(match[2]), size - 1);
        } else {
          start = Math.max(0, size - Number(match[2]));
        }
      }
      if (empty || start > end || start >= size) {
        response.writeHead(416, { ...headers, 'content-range': `bytes */${size}` });
        response.end();
        return;
      }
      status = 206;
    }
    response.writeHead(status, {
      ...headers,
      'content-length': end - start + 1,
      ...(status === 206 && { 'content-range': `bytes ${start}-${end}/${size}` }),
    });
    const file = createReadStream(path, { start, end });
    file.on('error', () => response.destroy());
    file.pipe(response);
  }

  #cookie(name: string, value: string, path: string, seconds: number): string {
    const secure = new URL(this.#options.publicBaseUrl).protocol === 'https:' ? '; Secure' : '';
    return `${name}=${value}; HttpOnly; SameSite=Lax; Path=${path}; Max-Age=${seconds}${secure}`;
  }

  #startSignIn(response: ServerResponse, github: GithubSignIn): void {
    const { location, browser } = github.start();
    response.writeHead(303, {
      ...SECURITY_HEADERS,
      location,
      'set-cookie': this.#cookie(STATE_COOKIE, browser, CALLBACK_PATH, STATE_SECONDS),
    }).end();
  }

  async #finishSignIn(request: IncomingMessage, response: ServerResponse, url: URL, github: GithubSignIn): Promise<void> {
    response.setHeader('referrer-policy', 'no-referrer');
    const cookie = await inSpan('browserctl.github.sign_in', {}, async () => {
      const ownerId = await github.complete(url, cookieValue(request.headers.cookie, STATE_COOKIE));
      return this.#openSession(ownerId);
    });
    response.writeHead(303, {
      ...SECURITY_HEADERS,
      location: `${PREFIX}/`,
      'set-cookie': [
        this.#cookie(COOKIE, cookie, PREFIX, SESSION_SECONDS),
        this.#cookie(STATE_COOKIE, '', CALLBACK_PATH, 0),
      ],
    }).end();
  }

  async #passwordSignIn(request: IncomingMessage, response: ServerResponse, password: PasswordSignIn): Promise<void> {
    if (!sameOrigin(request, this.#options.publicBaseUrl)) {
      return sendJson(response, 403, { error: 'the request does not come from the dashboard', errorClass: 'unauthorized' });
    }
    const cookie = await inSpan('browserctl.dashboard.password_sign_in', {}, async () => {
      const body = await this.#body(request, 4096);
      password.verify(body.password);
      return this.#openSession();
    });
    response.writeHead(204, {
      ...SECURITY_HEADERS,
      'set-cookie': this.#cookie(COOKIE, cookie, PREFIX, SESSION_SECONDS),
    }).end();
  }

  async #openSession(ownerId?: number): Promise<string> {
    const session = await this.#options.auth.issue(ownerId);
    await this.#options.audit.record(dashboardActor(ownerId), 'dashboard.login');
    return session;
  }

  async #body(request: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
    const text = (await readBody(request, limit)).toString('utf8');
    if (text === '') return {};
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Refused below.
    }
    throw new BrowserctlError('invalid_request', 'the request body is not a JSON object');
  }

  async #api(client: string, method: string, path: string, body: Record<string, unknown>): Promise<{ status?: number; body: unknown }> {
    const { sessions, profiles, tasks, checks, audit } = this.#options;
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
    const route = `${method} ${parts.map((part, index) => (index % 2 === 1 ? ':' : part)).join('/')}`;
    const name = parts[1] ?? '';
    const text = (key: string) => {
      if (typeof body[key] !== 'string') throw new BrowserctlError('invalid_request', `${key} must be a string`);
      return body[key] as string;
    };
    switch (route) {
      case 'GET state':
        return { body: await this.#state(client) };
      case 'GET tasks/:/revisions/:': {
        const { revision, content } = await tasks.read(name, parts[3]);
        return { body: { name, revision: revision.id, client: revision.client, createdAt: revision.createdAt, content } };
      }
      case 'POST profiles': {
        const profile = await profiles.create(text('name'), client);
        await audit.record(client, 'profile.create', profile.name);
        return { status: 201, body: { name: profile.name } };
      }
      case 'POST profiles/:/delete':
        if (sessions.usesProfile(name)) throw new BrowserctlError('conflict', `a session uses profile ${name}`);
        await profiles.delete(name);
        await audit.record(client, 'profile.delete', name);
        return { body: { deleted: name } };
      case 'POST profiles/:/revisions/:/pin': {
        if (typeof body.pinned !== 'boolean') throw new BrowserctlError('invalid_request', 'pinned must be true or false');
        await profiles.setPinned(name, parts[3]!, body.pinned);
        await audit.record(client, body.pinned ? 'profile.pin' : 'profile.unpin', name, { revision: parts[3]! });
        return { body: { pinned: body.pinned } };
      }
      case 'POST profiles/:/current': {
        const revision = text('revision');
        await profiles.setCurrent(name, revision);
        await audit.record(client, 'profile.current', name, { revision });
        return { body: { current: revision } };
      }
      case 'POST profiles/:/services': {
        const service = text('name');
        const task = text('task');
        await tasks.get(task);
        await profiles.addService(name, service, task);
        await audit.record(client, 'profile.service_add', name, { service, task });
        return { status: 201, body: { service } };
      }
      case 'POST profiles/:/services/:/delete':
        await profiles.removeService(name, parts[3]!);
        await audit.record(client, 'profile.service_remove', name, { service: parts[3]! });
        return { body: { removed: parts[3] } };
      case 'POST profiles/:/services/:/check': {
        const profile = await profiles.get(name);
        if (!profile.services.some((service) => service.name === parts[3])) throw new BrowserctlError('not_found', `profile ${name} has no service ${parts[3]}`);
        void checks.check(name, parts[3]!).catch(() => undefined);
        return { status: 202, body: { checking: parts[3] } };
      }
      case 'POST profiles/:/sign-in': {
        const pending = this.#openingSignIns.get(name);
        if (pending) return { body: { session: (await pending).id } };
        const existing = sessions.list().find((session) => session.purpose === 'sign_in' && session.state === 'ready'
          && session.source.kind === 'profile' && session.source.profile === name);
        if (existing) return { body: { session: existing.id } };
        const opening = sessions.open(client, { kind: 'profile', profile: name }, 'sign_in');
        this.#openingSignIns.set(name, opening);
        try {
          return { status: 201, body: { session: (await opening).id } };
        } finally {
          this.#openingSignIns.delete(name);
        }
      }
      case 'POST sessions/:/save': {
        const session = this.#signIn(name);
        const revision = await sessions.saveRevision(session, client, SAVE_EXIT_TIMEOUT_MS);
        return { body: { revision: revision.id } };
      }
      case 'POST sessions/:/discard': {
        const session = this.#signIn(name);
        await sessions.close(session, 'closed');
        await audit.record(client, 'profile.discard', session.source.kind === 'profile' ? session.source.profile : undefined, { session: session.id });
        return { body: { discarded: session.id } };
      }
      default:
        throw new BrowserctlError('not_found', 'not found');
    }
  }

  #signIn(id: string): Session {
    const session = this.#options.sessions.get(id);
    if (!session || session.purpose !== 'sign_in') throw new BrowserctlError('not_found', `no sign-in session ${id}`);
    return session;
  }

  async #state(client: string): Promise<unknown> {
    const { sessions, profiles, tasks, runs, providers } = this.#options;
    const providerStates = providers.states();
    return {
      client,
      sessions: sessions.list().map((session) => ({
        id: session.id,
        purpose: session.purpose,
        source: session.source.kind,
        ...(session.source.kind === 'profile' && { profile: session.source.profile, revision: session.revision }),
        ...(session.source.kind === 'provider' && { provider: session.source.provider }),
        client: session.client,
        createdAt: new Date(session.createdAt).toISOString(),
        state: session.state,
        view: session.purpose === 'sign_in' ? 'vnc' : isWindowBrowser(session.browser) ? 'window'
          : session.registration && !isPrivateProviderSession(session) ? 'screencast' : 'none',
      })),
      watched: providerStates.flatMap((state) =>
        state.slots.filter((slot) => !slot.own).map((slot) => ({ id: `w-${state.name}-${slot.slot}`, provider: state.name, slot: slot.slot, owner: slot.owner, running: slot.running })),
      ),
      providers: providerStates.map((state) => ({
        name: state.name,
        reachable: state.reachable,
        error: state.error ?? null,
        checkedAt: state.checkedAt ?? null,
        slots: state.slots.map(({ slot, owner, running, own }) => ({ slot, owner, running, own })),
      })),
      profiles: (await profiles.list()).map((profile) => ({ ...profile, inUse: sessions.usesProfile(profile.name) })),
      tasks: (await tasks.list()).map((task) => ({ name: task.name, createdAt: task.createdAt, revisions: task.revisions })),
      runs: await runs.recent(),
      recordings: this.#options.recordings.list(),
    };
  }

  #upgrade(request: IncomingMessage, socket: Duplex, head: Buffer, url: URL): void {
    if (!sameOrigin(request, this.#options.publicBaseUrl)) return refuseUpgrade(socket, 403, 'Forbidden');
    const credential = this.#options.auth.authenticate(request);
    if (!credential) return refuseUpgrade(socket, 401, 'Unauthorized');
    const [kind, id] = url.pathname.slice(`${PREFIX}/ws/`.length).split('/');
    const stream = url.searchParams.get('stream') === 'focused' ? 'focused' : 'grid';
    let attach: ((socket: WebSocket) => void) | undefined;
    if (kind === 'screencast' && id) {
      const screencast = this.#options.screencasts.get(id);
      if (screencast) attach = (ws) => this.#watch(ws, screencast, stream);
    } else if (kind === 'vnc' && id) {
      const session = this.#options.sessions.get(id);
      if (session?.purpose === 'sign_in' && session.state === 'ready' && isDisplayBrowser(session.browser)) {
        const vncSocket = session.browser.vncSocket;
        attach = (ws) => {
          const close = bridgeVnc(ws, vncSocket, () => this.#options.sessions.touch(session));
          void session.closed.then(close);
        };
      }
    }
    if (!attach) return refuseUpgrade(socket, 404, 'Not Found');
    const start = attach;
    this.#sockets.handleUpgrade(request, socket, head, (ws) => {
      const key = credential.sha256;
      let sockets = this.#sessionSockets.get(key);
      if (!sockets) this.#sessionSockets.set(key, (sockets = new Set()));
      sockets.add(ws);
      const expiry = setTimeout(() => ws.close(1008, 'session expired'), Math.max(0, credential.expiresAt - Date.now()));
      ws.once('close', () => {
        clearTimeout(expiry);
        sockets.delete(ws);
        if (sockets.size === 0) this.#sessionSockets.delete(key);
      });
      if (!this.#options.auth.authenticate(request)) return ws.close(1008, 'access revoked');
      start(ws);
    });
  }

  #watch(ws: WebSocket, screencast: Screencast, stream: Stream): void {
    // The dashboard sends no input to watched browsers: anything it sends on this socket is ignored.
    const unwatch = screencast.watch(socketViewer(ws, stream));
    screencast.onClose(() => ws.close(1001, 'browser closed'));
    ws.once('close', unwatch);
  }
}
