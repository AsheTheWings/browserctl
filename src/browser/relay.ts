// The CDP relay: each session's browser is reachable only under a capability path of 256 random bits, over HTTP
// for /json/version and over WebSocket for CDP. Any other path, and a path whose session ended, answers 404.

import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { HttpRouter } from '../server/http.ts';
import { notFound, refuseUpgrade, sendJson } from '../server/http.ts';
import type { CdpConnection, CdpMessage } from './cdp.ts';

const PREFIX = '/cdp';
const CAPABILITY = /^[A-Za-z0-9_-]{43}$/;
const HOST = /^[A-Za-z0-9.-]+(:[0-9]{1,5})?$|^\[[0-9A-Fa-f:.]+\](:[0-9]{1,5})?$/;
const MAX_MESSAGE_BYTES = 256 * 1024 * 1024;
/** Commands whose reply names a new session the calling client owns. */
const ATTACHING = new Set(['Target.attachToTarget', 'Target.attachToBrowserTarget']);

/** What a capability grants access to: one session's browser. */
export interface RelayTarget {
  /** The /json/version fields other than the WebSocket URL. */
  version(): Promise<Record<string, unknown>>;
  /** Serve one WebSocket client until either side closes; onTraffic runs for each client message. */
  serve(socket: WebSocket, onTraffic: () => void): void;
}

export interface Registration {
  capability: string;
  /** The capability's HTTP endpoint on a base such as http://127.0.0.1:<port>. */
  endpoint(base: string): string;
  /** End the capability: its connections close, and its path answers 404. */
  revoke(): void;
}

interface Entry {
  target: RelayTarget;
  onTraffic: () => void;
  sockets: Set<WebSocket>;
}

export class Relay {
  readonly #entries = new Map<string, Entry>();
  readonly #server = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });

  register(target: RelayTarget, onTraffic: () => void): Registration {
    const capability = randomBytes(32).toString('base64url');
    const entry: Entry = { target, onTraffic, sockets: new Set() };
    this.#entries.set(capability, entry);
    return {
      capability,
      endpoint: (base) => `${base}${PREFIX}/${capability}`,
      revoke: () => {
        if (this.#entries.get(capability) !== entry) return;
        this.#entries.delete(capability);
        for (const socket of entry.sockets) socket.close(1001, 'session ended');
      },
    };
  }

  mount(router: HttpRouter): void {
    router.route(PREFIX, (request, response, url) => this.#http(request, response, url));
    router.upgrade(PREFIX, (request, socket, head, url) => this.#upgrade(request, socket, head, url));
  }

  /** The entry and the rest of the path after /cdp/<capability>. */
  #lookup(url: URL): { entry: Entry; capability: string; rest: string } | undefined {
    const parts = url.pathname.slice(PREFIX.length + 1).split('/');
    const capability = parts[0] ?? '';
    if (!CAPABILITY.test(capability)) return undefined;
    const entry = this.#entries.get(capability);
    return entry ? { entry, capability, rest: `/${parts.slice(1).join('/')}` } : undefined;
  }

  async #http(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const found = this.#lookup(url);
    const host = request.headers.host ?? '';
    if (!found || request.method !== 'GET' || !['/json/version', '/json/version/'].includes(found.rest) || !HOST.test(host)) {
      return notFound(response);
    }
    found.entry.onTraffic();
    const version = await found.entry.target.version();
    sendJson(response, 200, { ...version, webSocketDebuggerUrl: `ws://${host}${PREFIX}/${found.capability}/devtools/browser` });
  }

  #upgrade(request: IncomingMessage, socket: Duplex, head: Buffer, url: URL): void {
    const found = this.#lookup(url);
    if (!found || !/^\/devtools\/browser(\/[A-Za-z0-9-]*)?$/.test(found.rest)) return refuseUpgrade(socket, 404, 'Not Found');
    const { entry } = found;
    this.#server.handleUpgrade(request, socket, head, (client) => {
      if (!this.#entries.has(found.capability)) {
        client.close(1001, 'session ended');
        return;
      }
      entry.sockets.add(client);
      client.once('close', () => entry.sockets.delete(client));
      entry.target.serve(client, entry.onTraffic);
    });
  }
}

function parseClientMessage(raw: RawData): (CdpMessage & { id: number; method: string }) | undefined {
  try {
    const message = JSON.parse(raw.toString()) as CdpMessage;
    if (typeof message !== 'object' || message === null || !Number.isSafeInteger(message.id) || typeof message.method !== 'string') return undefined;
    if (message.sessionId !== undefined && typeof message.sessionId !== 'string') return undefined;
    return message as CdpMessage & { id: number; method: string };
  } catch {
    return undefined;
  }
}

/** A managed Chrome's pipe connection shared by many clients: each client gets its own browser-target session,
 * and replies and events reach only the client whose session they belong to. */
export class ManagedTarget implements RelayTarget {
  readonly #cdp: CdpConnection;

  constructor(cdp: CdpConnection) {
    this.#cdp = cdp;
  }

  async version(): Promise<Record<string, unknown>> {
    const version = await this.#cdp.call<Record<string, string>>('Browser.getVersion');
    return {
      Browser: version.product,
      'Protocol-Version': version.protocolVersion,
      'User-Agent': version.userAgent,
      'V8-Version': version.jsVersion,
    };
  }

  serve(socket: WebSocket, onTraffic: () => void): void {
    const cdp = this.#cdp;
    const early: RawData[] = [];
    let root: string | undefined;
    let closed = false;
    const owned = new Set<string>();
    const send = (message: CdpMessage) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };
    const strip = (message: CdpMessage): CdpMessage => {
      if (message.sessionId !== root) return message;
      const { sessionId: _sessionId, ...rest } = message;
      return rest;
    };
    const handle = (raw: RawData) => {
      onTraffic();
      const message = parseClientMessage(raw);
      if (!message) return;
      const sessionId = message.sessionId ?? root!;
      if (!owned.has(sessionId)) {
        send({ id: message.id, error: { code: -32001, message: 'Session with given id not found.' }, ...(message.sessionId && { sessionId: message.sessionId }) });
        return;
      }
      const params = typeof message.params === 'object' && message.params !== null ? message.params : {};
      cdp.forward({ method: message.method, params, sessionId }, (reply) => {
        const child = reply.result?.sessionId;
        if (ATTACHING.has(message.method) && typeof child === 'string') owned.add(child);
        send(strip({ ...reply, id: message.id, ...(reply.sessionId === undefined && sessionId !== root && { sessionId }) }));
      });
    };
    const unsubscribe = cdp.onEvent((event) => {
      if (event.sessionId === undefined || !owned.has(event.sessionId)) return;
      const child = event.params?.sessionId;
      if (event.method === 'Target.attachedToTarget' && typeof child === 'string') owned.add(child);
      send(strip(event));
      if (event.method === 'Target.detachedFromTarget' && typeof child === 'string') owned.delete(child);
    });
    let stopWatchingClose = () => {};
    const finish = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      stopWatchingClose();
      if (root !== undefined) cdp.forward({ method: 'Target.detachFromTarget', params: { sessionId: root } }, () => undefined);
      owned.clear();
      if (socket.readyState === WebSocket.OPEN) socket.close(1001, 'browser closed');
    };
    socket.on('message', (raw) => (root === undefined ? early.push(raw) : handle(raw)));
    socket.on('close', finish);
    socket.on('error', finish);
    stopWatchingClose = cdp.onClose(finish);
    cdp.forward({ method: 'Target.attachToBrowserTarget', params: {} }, (reply) => {
      const sessionId = reply.result?.sessionId;
      if (typeof sessionId !== 'string' || closed) {
        finish();
        return;
      }
      root = sessionId;
      owned.add(sessionId);
      for (const raw of early.splice(0)) handle(raw);
    });
  }
}
