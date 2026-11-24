// Per-session loopback HTTP/CONNECT proxy: routes only loopback/configured host names to 127.0.0.1 on ports the
// session's client explicitly allowed, keeping all other host loopback services unreachable from managed Chrome.

import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import { BrowserctlError } from '../errors.ts';

export const MAX_LOOPBACK_PORTS_PER_SESSION = 32;
const HOSTNAME = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const BUILTIN_HOSTS = ['127.0.0.1', 'localhost', '::1', '[::1]'] as const;

export interface LoopbackProxyConfig {
  /** Listening port for each session's proxy on its own 127.16.x.y loopback address; 0 disables in production config. */
  port: number;
  /** Extra hostnames routed to 127.0.0.1 through the proxy (e.g. a private link hostname). */
  hosts: readonly string[];
  /** Ports agents may never allow on any session. */
  denyPorts: ReadonlySet<number>;
}

/** Parse comma-separated ports and start-end ranges (1..65535). */
export function parsePortList(value: string): Set<number> {
  const ports = new Set<number>();
  const trimmed = value.trim();
  if (!trimmed) return ports;
  for (const raw of trimmed.split(',')) {
    const token = raw.trim();
    if (!token) throw new Error('empty port entry');
    const range = /^([0-9]+)-([0-9]+)$/.exec(token);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end > 65535 || start > end) {
        throw new Error(`invalid port range ${token}`);
      }
      for (let port = start; port <= end; port += 1) ports.add(port);
      continue;
    }
    if (!/^[0-9]+$/.test(token)) throw new Error(`invalid port ${token}`);
    const port = Number(token);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port ${token}`);
    ports.add(port);
  }
  return ports;
}

/** Parse comma-separated extra hostnames routed to loopback. */
export function parseHostList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const hosts = new Set<string>();
  for (const raw of trimmed.split(',')) {
    const host = raw.trim().toLowerCase();
    if (!host || !HOSTNAME.test(host)) throw new Error(`invalid loopback host ${raw.trim() || '(empty)'}`);
    hosts.add(host);
  }
  return [...hosts];
}

export function normalizeHost(host: string): string {
  const lower = host.trim().toLowerCase();
  return lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
}

export function isLoopbackHost(host: string, extraHosts: ReadonlySet<string>): boolean {
  const normalized = normalizeHost(host);
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1' || extraHosts.has(normalized);
}

/** Parse a CONNECT authority (`host:port` or `[::1]:port`). */
export function parseAuthority(authority: string): { host: string; port: number } | undefined {
  let host: string;
  let portText: string;
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']:');
    if (end < 0) return undefined;
    host = authority.slice(1, end);
    portText = authority.slice(end + 2);
  } else {
    const colon = authority.lastIndexOf(':');
    if (colon <= 0) return undefined;
    host = authority.slice(0, colon);
    portText = authority.slice(colon + 1);
  }
  if (!/^[0-9]+$/.test(portText)) return undefined;
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return undefined;
  return { host, port };
}

/** PAC script that routes only loopback and configured extra hosts through the session proxy, leaving all other traffic direct. */
export function buildPacScript(proxyHost: string, proxyPort: number, extraHosts: readonly string[]): string {
  const hosts = [...BUILTIN_HOSTS, ...extraHosts];
  const checks = hosts.map((host) => `h === ${JSON.stringify(host)}`).join(' || ');
  return `function FindProxyForURL(url, host) { var h = host.toLowerCase(); if (${checks}) { return "PROXY ${proxyHost}:${proxyPort}"; } return "DIRECT"; }`;
}

function randomLoopbackAddress(): string {
  const bytes = randomBytes(3);
  const second = 16 + (bytes[0]! & 0x0f); // 127.16.0.0/12
  const third = bytes[1]!;
  const fourth = 1 + (bytes[2]! % 254);
  return `127.${second}.${third}.${fourth}`;
}

function stripProxyHeaders(headers: IncomingMessage['headers']): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (lower === 'proxy-connection' || lower === 'proxy-authorization' || lower === 'proxy-authenticate') continue;
    out[key] = value;
  }
  return out;
}

export class LoopbackProxy {
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();
  readonly #allowed = new Set<number>();
  readonly #denied: ReadonlySet<number>;
  readonly #extraHosts: ReadonlySet<string>;
  readonly #extraHostList: readonly string[];
  readonly host: string;
  readonly port: number;

  private constructor(server: Server, host: string, port: number, extraHosts: readonly string[], denied: ReadonlySet<number>) {
    this.#server = server;
    this.host = host;
    this.port = port;
    this.#extraHostList = [...extraHosts];
    this.#extraHosts = new Set(extraHosts);
    this.#denied = denied;
    server.on('connection', (socket) => {
      this.#track(socket);
    });
    server.on('request', (req, res) => this.#handleHttp(req, res));
    server.on('connect', (req, socket, head) => this.#handleConnect(req, socket as Socket, head));
    server.on('upgrade', (req, socket, head) => this.#handleUpgrade(req, socket as Socket, head));
  }

  static async start(options: { port: number; hosts?: readonly string[]; denyPorts?: ReadonlySet<number>; bindAddress?: string }): Promise<LoopbackProxy> {
    const hosts = options.hosts ?? [];
    const denyPorts = options.denyPorts ?? new Set<number>();
    let lastError: unknown;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const host = options.bindAddress ?? randomLoopbackAddress();
      const server = createServer();
      try {
        const boundPort = await new Promise<number>((resolve, reject) => {
          server.once('error', reject);
          server.listen(options.port, host, () => {
            server.off('error', reject);
            const address = server.address();
            resolve(typeof address === 'object' && address ? address.port : options.port);
          });
        });
        return new LoopbackProxy(server, host, boundPort, hosts, denyPorts);
      } catch (error) {
        server.close();
        lastError = error;
        if (options.bindAddress || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') break;
      }
    }
    throw new BrowserctlError('browser_failed', 'cannot start the session loopback proxy', { cause: lastError });
  }

  get hosts(): readonly string[] {
    return this.#extraHostList;
  }

  pacUrl(): string {
    const script = buildPacScript(this.host, this.port, this.#extraHostList);
    return `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(script, 'utf8').toString('base64')}`;
  }

  allow(port: number): number[] {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new BrowserctlError('invalid_request', 'port must be an integer between 1 and 65535');
    }
    if (this.#denied.has(port)) {
      throw new BrowserctlError('unauthorized', `loopback port ${port} is denied by server policy`);
    }
    if (!this.#allowed.has(port) && this.#allowed.size >= MAX_LOOPBACK_PORTS_PER_SESSION) {
      throw new BrowserctlError('invalid_request', `a session may allow at most ${MAX_LOOPBACK_PORTS_PER_SESSION} loopback ports`);
    }
    this.#allowed.add(port);
    return this.list();
  }

  revoke(port?: number): number[] {
    if (port !== undefined) {
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
        throw new BrowserctlError('invalid_request', 'port must be an integer between 1 and 65535');
      }
      return this.#allowed.delete(port) ? [port] : [];
    }
    const cleared = this.list();
    this.#allowed.clear();
    return cleared;
  }

  list(): number[] {
    return [...this.#allowed].sort((a, b) => a - b);
  }

  #isAllowed(host: string, port: number): boolean {
    return isLoopbackHost(host, this.#extraHosts) && this.#allowed.has(port) && !this.#denied.has(port);
  }

  #track(socket: Socket): void {
    this.#sockets.add(socket);
    socket.once('close', () => this.#sockets.delete(socket));
  }

  #handleHttp(req: IncomingMessage, res: ServerResponse): void {
    let parsed: URL;
    try {
      parsed = new URL(req.url ?? '');
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('bad proxy request');
      return;
    }
    if (parsed.protocol !== 'http:') {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('loopback proxy allows only http and CONNECT');
      return;
    }
    const port = parsed.port ? Number(parsed.port) : 80;
    if (!this.#isAllowed(parsed.hostname, port)) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end(`loopback port ${port} is not allowed for this session`);
      return;
    }
    const upstream = httpRequest({
      host: '127.0.0.1',
      port,
      method: req.method,
      path: `${parsed.pathname}${parsed.search}`,
      headers: stripProxyHeaders(req.headers),
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end('upstream loopback service unavailable');
      else res.destroy();
    });
    req.on('error', () => upstream.destroy());
    req.pipe(upstream);
  }

  #handleConnect(req: IncomingMessage, clientSocket: Socket, head: Buffer): void {
    const authority = parseAuthority(req.url ?? '');
    if (!authority || !this.#isAllowed(authority.host, authority.port)) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const upstream = netConnect(authority.port, '127.0.0.1');
    this.#track(upstream);
    clientSocket.on('error', () => upstream.destroy());
    upstream.on('error', () => {
      if (clientSocket.writable) clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      clientSocket.destroy();
    });
    upstream.once('connect', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
  }

  #handleUpgrade(req: IncomingMessage, clientSocket: Socket, head: Buffer): void {
    let parsed: URL;
    try {
      parsed = new URL(req.url ?? '');
    } catch {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const port = parsed.port ? Number(parsed.port) : 80;
    if (parsed.protocol !== 'http:' || !this.#isAllowed(parsed.hostname, port)) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const upstream = netConnect(port, '127.0.0.1');
    this.#track(upstream);
    clientSocket.on('error', () => upstream.destroy());
    upstream.on('error', () => {
      if (clientSocket.writable) clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      clientSocket.destroy();
    });
    upstream.once('connect', () => {
      const headers = stripProxyHeaders(req.headers);
      let raw = `${req.method ?? 'GET'} ${parsed.pathname}${parsed.search} HTTP/1.1\r\n`;
      for (const [key, value] of Object.entries(headers)) {
        if (Array.isArray(value)) {
          for (const entry of value) raw += `${key}: ${entry}\r\n`;
        } else {
          raw += `${key}: ${value}\r\n`;
        }
      }
      raw += '\r\n';
      upstream.write(raw);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
  }

  async close(): Promise<void> {
    this.#allowed.clear();
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
      this.#server.closeAllConnections();
    });
  }
}
