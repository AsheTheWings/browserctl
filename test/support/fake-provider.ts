// A fake external provider: the lease API of docs/lease-protocol.md and, per slot, a fake browser debugging
// endpoint whose WebSocket echoes each message back.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';

export interface FakeProvider {
  url: string;
  token: string;
  requests: Array<{ method: string; path: string; body: any; authorization: string | undefined }>;
  /** Leases the provider knows; deleting one makes its heartbeat answer 404. */
  leases: Map<string, { slot: number; owner: string }>;
  /** Answer every lease request with 503. */
  full: boolean;
  /** Slots another owner holds, listed by GET /status. */
  others: Array<{ slot: number; owner: string }>;
  browserPort: number;
  close(): Promise<void>;
}

/** A fake provider; browserPort points its leases at a real browser's debugging port instead of the fake one. */
export async function fakeProvider(options: { browserPort?: number } = {}): Promise<FakeProvider> {
  const browser = createServer((request, response) => {
    if (request.url === '/json/version') {
      const port = (browser.address() as AddressInfo).port;
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        Browser: 'FakeChrome/1', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake-1`,
      }));
    } else response.writeHead(404).end();
  });
  const sockets = new WebSocketServer({ server: browser, path: '/devtools/browser/fake-1' });
  sockets.on('connection', (socket) => socket.on('message', (raw) => socket.send(raw.toString())));
  await listen(browser);

  const state: FakeProvider = {
    url: '',
    token: 'a'.repeat(64),
    requests: [],
    leases: new Map(),
    full: false,
    others: [],
    browserPort: options.browserPort ?? (browser.address() as AddressInfo).port,
    close: async () => {
      await new Promise<void>((resolve) => api.close(() => resolve()));
      sockets.close();
      browser.closeAllConnections();
      await new Promise<void>((resolve) => browser.close(() => resolve()));
    },
  };
  let next = 0;
  const api = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : undefined;
    const path = request.url ?? '';
    state.requests.push({ method: request.method ?? '', path, body, authorization: request.headers.authorization });
    const send = (status: number, value: unknown) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    if (request.headers.authorization !== `Bearer ${state.token}`) return send(401, { error: 'unauthorized' });
    if (request.method === 'GET' && path === '/status') {
      const slots = [...[...state.leases.values()], ...state.others].map((lease) => ({ slot: lease.slot, port: state.browserPort, owner: lease.owner, running: true, idleMs: 0 }));
      return send(200, { slots });
    }
    if (request.method === 'POST' && path === '/leases') {
      if (state.full) return send(503, { error: 'all slots are in use' });
      const id = `lease-${++next}`;
      const slot = body?.slot ?? 1;
      state.leases.set(id, { slot, owner: body.owner });
      return send(201, { lease: id, slot, port: state.browserPort });
    }
    const match = /^\/leases\/([^/]+)(\/ensure|\/heartbeat)?$/.exec(path);
    const lease = match ? state.leases.get(decodeURIComponent(match[1]!)) : undefined;
    if (!match || !lease) return send(404, { error: 'unknown lease' });
    if (request.method === 'DELETE' && !match[2]) {
      state.leases.delete(decodeURIComponent(match[1]!));
      return send(200, { slot: lease.slot });
    }
    if (match[2] === '/ensure') return send(200, { slot: lease.slot, port: state.browserPort });
    return send(200, { slot: lease.slot });
  });
  await listen(api);
  state.url = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  return state;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}
