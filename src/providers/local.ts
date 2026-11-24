// Serve explicit-source leases from this instance's own saved profiles.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { bearerToken, hashToken } from '../auth/tokens.ts';
import { ManagedTarget } from '../browser/relay.ts';
import { BrowserctlError } from '../errors.ts';
import type { ProfileStore } from '../profiles/store.ts';
import { notFound, readBody, refuseUpgrade, sendJson, type HttpRouter } from '../server/http.ts';
import type { Session, SessionManager, Source } from '../sessions/manager.ts';
import { LEASE_EXPIRY_MS, parseBrowserSource, SOURCE_TYPES, type LeaseSource } from './sources.ts';

const LEASE = /^\/leases\/([A-Za-z0-9_-]{43})(\/ensure|\/heartbeat|\/cdp\/json\/version|\/cdp\/devtools\/browser)?$/;

interface HostedLease {
  id: string;
  slot: number;
  source: LeaseSource;
  lastSeen: number;
  opening?: Promise<Session>;
  session?: Session;
  sockets: Set<WebSocket>;
  closing?: Promise<void>;
}

interface LocalProviderOptions {
  credential: Buffer;
  limit: number;
  profiles: ProfileStore;
  sessions: SessionManager;
}

export class LocalProvider {
  readonly #leases = new Map<string, HostedLease>();
  readonly #sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  #sweeper: NodeJS.Timeout | undefined;
  #stopping = false;
  readonly #options: LocalProviderOptions;

  constructor(options: LocalProviderOptions) {
    this.#options = options;
  }

  start(router: HttpRouter): void {
    router.route('/status', (request, response, url) => this.#handle(request, response, url.pathname));
    router.route('/leases', (request, response, url) => this.#handle(request, response, url.pathname));
    router.upgrade('/leases', (request, socket, head, url) => this.#upgrade(request, socket, head, url.pathname));
    this.#sweeper = setInterval(() => {
      for (const lease of this.#leases.values()) {
        if (Date.now() - lease.lastSeen >= LEASE_EXPIRY_MS) void this.#release(lease).catch(() => undefined);
      }
    }, 1_000);
    this.#sweeper.unref();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    clearInterval(this.#sweeper);
    await Promise.allSettled([...this.#leases.values()].map((lease) => this.#release(lease)));
    this.#sockets.close();
  }

  #authorized(request: IncomingMessage): boolean {
    const token = bearerToken(request.headers.authorization);
    return token !== undefined && timingSafeEqual(hashToken(token), this.#options.credential);
  }

  #live(id: string): HostedLease | undefined {
    const lease = this.#leases.get(id);
    return lease && !lease.closing && Date.now() - lease.lastSeen < LEASE_EXPIRY_MS ? lease : undefined;
  }

  async #handle(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
    if (!this.#authorized(request)) throw new BrowserctlError('unauthorized', 'unauthorized');
    if (this.#stopping) throw new BrowserctlError('capacity', 'provider is shutting down');
    const method = request.method;
    if (method === 'GET' && path === '/status') {
      const profiles = (await this.#options.profiles.list()).map(({ name }) => name).slice(0, 500);
      const total = this.#options.limit;
      const used = this.#leases.size;
      return sendJson(response, 200, {
        slots: [],
        capacity: { total, used, available: Math.max(0, total - used) },
        capabilities: { cdp: 'lease', sources: SOURCE_TYPES, profiles },
      });
    }
    if (method === 'POST' && path === '/leases') {
      let body: unknown;
      try { body = JSON.parse((await readBody(request, 4096)).toString('utf8')); } catch {
        throw new BrowserctlError('invalid_request', 'expected a lease request object of at most 4096 bytes');
      }
      const { owner, slot, source, ...extra } = record(body);
      const { limit, profiles } = this.#options;
      if (typeof owner !== 'string' || !owner.trim() || Object.keys(extra).length !== 0
        || (slot !== undefined && (typeof slot !== 'number' || !Number.isSafeInteger(slot) || slot < 1 || slot > limit))) {
        throw new BrowserctlError('invalid_request', 'give an owner, an explicit source, and optionally a valid slot');
      }
      const requested = parseBrowserSource(source);
      if (!requested || requested.type === 'existing') throw new BrowserctlError('invalid_request', 'invalid lease source');
      if (requested.type === 'profile') await profiles.get(requested.name);
      if (this.#stopping) throw new BrowserctlError('capacity', 'provider is shutting down');
      const used = new Set([...this.#leases.values()].map((lease) => lease.slot));
      const selected = slot ?? Array.from({ length: limit }, (_, index) => index + 1).find((candidate) => !used.has(candidate));
      if (selected === undefined || used.has(selected)) throw new BrowserctlError('capacity', 'no requested browser slot is free');
      const id = randomBytes(32).toString('base64url');
      this.#leases.set(id, { id, slot: selected, source: requested, lastSeen: Date.now(), sockets: new Set() });
      return sendJson(response, 201, { lease: id, slot: selected, cdp: 'lease', source: requested });
    }
    const match = LEASE.exec(path);
    const lease = match && this.#live(match[1]!);
    if (!match || !lease) return notFound(response);
    if (method === 'DELETE' && !match[2]) {
      await this.#release(lease);
      return sendJson(response, 200, { slot: lease.slot });
    }
    if (method === 'POST' && match[2] === '/heartbeat') {
      lease.lastSeen = Date.now();
      if (lease.session) this.#options.sessions.touch(lease.session);
      return sendJson(response, 200, { slot: lease.slot });
    }
    if (method === 'POST' && match[2] === '/ensure') {
      lease.lastSeen = Date.now();
      try {
        await (lease.opening ??= this.#open(lease));
      } catch (error) {
        await this.#release(lease);
        throw error;
      }
      if (!this.#live(lease.id)) return notFound(response);
      return sendJson(response, 200, { cdp: 'lease' });
    }
    if (method === 'GET' && match[2] === '/cdp/json/version') {
      const target = this.#target(lease);
      if (!target) return notFound(response);
      const version = await target.version();
      if (!this.#live(lease.id)) return notFound(response);
      return sendJson(response, 200, version);
    }
    notFound(response);
  }

  async #open(lease: HostedLease): Promise<Session> {
    const source: Source = lease.source.type === 'profile' ? { kind: 'profile', profile: lease.source.name } : { kind: 'ephemeral' };
    const session = await this.#options.sessions.open('browserctl', source, 'provider_lease');
    lease.session = session;
    void session.closed.then(() => { if (!lease.closing) void this.#release(lease).catch(() => undefined); });
    return session;
  }

  #target(lease: HostedLease): ManagedTarget | undefined {
    const cdp = lease.session?.browser?.cdp;
    return lease.session?.state === 'ready' && cdp && !cdp.closed ? new ManagedTarget(cdp) : undefined;
  }

  #upgrade(request: IncomingMessage, socket: Duplex, head: Buffer, path: string): void {
    if (!this.#authorized(request)) return refuseUpgrade(socket, 401, 'Unauthorized');
    const match = LEASE.exec(path);
    const lease = match && match[2] === '/cdp/devtools/browser' && this.#live(match[1]!);
    const target = lease && this.#target(lease);
    if (this.#stopping || !lease || !target) return refuseUpgrade(socket, 404, 'Not Found');
    this.#sockets.handleUpgrade(request, socket, head, (ws) => {
      lease.sockets.add(ws);
      ws.once('close', () => lease.sockets.delete(ws));
      target.serve(ws, () => { if (lease.session) this.#options.sessions.touch(lease.session); });
    });
  }

  #release(lease: HostedLease): Promise<void> {
    return lease.closing ??= Promise.resolve().then(async () => {
      for (const socket of lease.sockets) socket.terminate();
      const session = await lease.opening?.catch(() => undefined);
      if (session) await this.#options.sessions.close(session, 'closed');
      this.#leases.delete(lease.id);
    });
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new BrowserctlError('invalid_request', 'expected an object');
  return value as Record<string, unknown>;
}
