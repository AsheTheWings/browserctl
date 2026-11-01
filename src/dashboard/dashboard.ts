// The operator dashboard under /dashboard: its static pages, a JSON API over sessions, profiles, tasks, runs, and
// providers, live screencasts of every browser, and the noVNC view of sign-in sessions. Every API request and
// WebSocket needs a dashboard session; state changes and WebSockets also need the public base URL's Origin.

import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, relative as relativePath, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AuditLog } from '../audit.ts';
import { BrowserctlError } from '../errors.ts';
import type { ProfileStore } from '../profiles/store.ts';
import type { Providers } from '../providers/external.ts';
import { readBody, refuseUpgrade, sendError, sendJson, type HttpRouter } from '../server/http.ts';
import type { Session, SessionManager } from '../sessions/manager.ts';
import { isDisplayBrowser } from '../signin/display.ts';
import type { ServiceChecks } from '../tasks/checks.ts';
import type { RunLog } from '../tasks/runs.ts';
import type { TaskStore } from '../tasks/store.ts';
import { COOKIE, DashboardAuth, SESSION_SECONDS, sameOrigin } from './auth.ts';
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
};
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

export interface DashboardOptions {
  publicBaseUrl: string;
  auth: DashboardAuth;
  sessions: SessionManager;
  profiles: ProfileStore;
  tasks: TaskStore;
  runs: RunLog;
  checks: ServiceChecks;
  providers: Providers;
  screencasts: Screencasts;
  audit: AuditLog;
}

export class Dashboard {
  readonly #options: DashboardOptions;
  readonly #sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
  /** Open dashboard WebSockets by client, so revoking a client closes them. */
  readonly #clientSockets = new Map<string, Set<WebSocket>>();

  constructor(options: DashboardOptions) {
    this.#options = options;
  }

  mount(router: HttpRouter): void {
    router.route(PREFIX, (request, response, url) => this.#handle(request, response, url));
    router.upgrade(`${PREFIX}/ws`, (request, socket, head, url) => this.#upgrade(request, socket, head, url));
  }

  /** End a client's dashboard sessions and close its WebSockets. */
  async closeClient(client: string): Promise<void> {
    await this.#options.auth.closeClient(client);
    for (const socket of this.#clientSockets.get(client) ?? []) socket.close(1008, 'access revoked');
  }

  stop(): void {
    for (const sockets of this.#clientSockets.values()) for (const socket of sockets) socket.terminate();
  }

  async #handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname;
    if (request.method === 'GET' && (path === PREFIX || path === `${PREFIX}/`)) return this.#static(response, 'index.html', STATIC);
    if (request.method === 'GET' && path.startsWith(`${PREFIX}/static/`)) return this.#static(response, path.slice(`${PREFIX}/static/`.length), STATIC);
    if (request.method === 'GET' && path.startsWith(`${PREFIX}/novnc/`)) return this.#static(response, path.slice(`${PREFIX}/novnc/`.length), NOVNC, /^(core|vendor)\//);
    if (request.method === 'GET' && path === `${PREFIX}/login`) return this.#login(response, url);
    if (!path.startsWith(`${PREFIX}/api/`)) return sendJson(response, 404, { error: 'not found', errorClass: 'not_found' });
    const changes = request.method !== 'GET' && request.method !== 'HEAD';
    if (changes && !sameOrigin(request, this.#options.publicBaseUrl)) {
      return sendJson(response, 403, { error: 'the request does not come from the dashboard', errorClass: 'unauthorized' });
    }
    const client = this.#options.auth.authenticate(request);
    if (!client) return sendJson(response, 401, { error: 'open the dashboard through a dashboard link', errorClass: 'unauthorized' });
    try {
      const body = changes ? await this.#body(request) : {};
      const result = await this.#api(client, request.method ?? 'GET', path.slice(`${PREFIX}/api`.length), body);
      sendJson(response, result.status ?? 200, result.body);
    } catch (error) {
      sendError(response, error);
    }
  }

  async #static(response: ServerResponse, requested: string, root: URL, allowed?: RegExp): Promise<void> {
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
    response.writeHead(200, { 'content-type': type, 'content-length': content.length, ...SECURITY_HEADERS });
    response.end(content);
  }

  async #login(response: ServerResponse, url: URL): Promise<void> {
    let cookie: string;
    let client: string;
    try {
      ({ cookie, client } = await this.#options.auth.redeem(url.searchParams.get('token') ?? undefined));
    } catch (error) {
      if (!(error instanceof BrowserctlError) || error.errorClass !== 'unauthorized') throw error;
      response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
      response.end('This dashboard link is invalid, used, or expired. Ask for a new one with: browserctl admin dashboard-link <name>\n');
      return;
    }
    await this.#options.audit.record(client, 'dashboard.login');
    const secure = new URL(this.#options.publicBaseUrl).protocol === 'https:' ? '; Secure' : '';
    response.writeHead(303, {
      location: `${PREFIX}/`,
      'set-cookie': `${COOKIE}=${cookie}; HttpOnly; SameSite=Strict; Path=${PREFIX}; Max-Age=${SESSION_SECONDS}${secure}`,
      ...SECURITY_HEADERS,
    });
    response.end();
  }

  async #body(request: IncomingMessage): Promise<Record<string, unknown>> {
    const text = (await readBody(request, MAX_BODY_BYTES)).toString('utf8');
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
        const session = await sessions.open(client, { kind: 'profile', profile: name }, 'sign_in');
        return { status: 201, body: { session: session.id } };
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
        view: session.purpose === 'sign_in' ? 'vnc' : session.registration ? 'screencast' : 'none',
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
    };
  }

  #upgrade(request: IncomingMessage, socket: Duplex, head: Buffer, url: URL): void {
    if (!sameOrigin(request, this.#options.publicBaseUrl)) return refuseUpgrade(socket, 403, 'Forbidden');
    const client = this.#options.auth.authenticate(request);
    if (!client) return refuseUpgrade(socket, 401, 'Unauthorized');
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
      let set = this.#clientSockets.get(client);
      if (!set) this.#clientSockets.set(client, (set = new Set()));
      set.add(ws);
      ws.once('close', () => set.delete(ws));
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
