// Per-session loopback HTTP/CONNECT proxy: routes only loopback/configured host names to 127.0.0.1 on ports the
// session's client explicitly allowed, keeping all other host loopback services unreachable from managed Chrome.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { BrowserctlError } from '../errors.ts';

export const MAX_LOOPBACK_PORTS_PER_SESSION = 32;
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
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

/** Parse comma-separated extra hostnames or `*.domain` subdomain wildcards routed to loopback. */
export function parseHostList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const hosts = new Set<string>();
  for (const raw of trimmed.split(',')) {
    const host = raw.trim().toLowerCase();
    const wildcard = host.startsWith('*.');
    const candidate = wildcard ? host.slice(2) : host;
    if (!candidate || candidate.length > (wildcard ? 251 : 253) || !HOSTNAME.test(candidate)) {
      throw new Error(`invalid loopback host ${raw.trim() || '(empty)'}`);
    }
    hosts.add(host);
  }
  return [...hosts];
}

export function normalizeHost(host: string): string {
  const lower = host.trim().toLowerCase();
  return lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
}

/** True when `host` is an IPv4 (or IPv4-mapped IPv6) address inside the 127.16.0.0/12 proxy subnet. */
export function isProxyRange(host: string): boolean {
  let normalized = normalizeHost(host);
  if (normalized.startsWith('::ffff:')) normalized = normalized.slice(7);
  const parts = normalized.split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map(Number);
  return nums.every((n, i) => /^\d+$/.test(parts[i]!) && n >= 0 && n <= 255)
    && nums[0] === 127 && nums[1]! >= 16 && nums[1]! <= 31;
}

export function isLoopbackHost(host: string, extraHosts: ReadonlySet<string>): boolean {
  const normalized = normalizeHost(host);
  if (normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1' || extraHosts.has(normalized)) {
    return true;
  }
  for (const entry of extraHosts) {
    if (!entry.startsWith('*.')) continue;
    const suffix = entry.slice(1);
    if (normalized.length > suffix.length && normalized.endsWith(suffix)) return true;
  }
  return false;
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

/** PAC script that routes only loopback and configured extra hosts through the proxy, leaving all other traffic direct. */
export function buildPacScript(proxyHost: string, proxyPort: number, extraHosts: readonly string[]): string {
  const checks: string[] = BUILTIN_HOSTS.map((host) => `h === ${JSON.stringify(host)}`);
  for (const entry of extraHosts) {
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1);
      checks.push(`(h.length > ${suffix.length} && h.slice(-${suffix.length}) === ${JSON.stringify(suffix)})`);
    } else {
      checks.push(`h === ${JSON.stringify(entry)}`);
    }
  }
  return `function FindProxyForURL(url, host) { var h = host.toLowerCase(); if (${checks.join(' || ')}) { return "PROXY ${proxyHost}:${proxyPort}"; } return "DIRECT"; }`;
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
  #egressSocket: string | undefined;
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

  /** Attach or detach the browser-user Unix egress dialer used for non-loopback destinations. */
  setEgressSocket(socketPath: string | undefined): void {
    this.#egressSocket = socketPath;
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

  #dialEgress(host: string, port: number): Promise<Socket> {
    const socketPath = this.#egressSocket;
    if (!socketPath || isProxyRange(host)) {
      return Promise.reject(Object.assign(new Error('forbidden'), { code: 'FORBIDDEN' }));
    }
    return new Promise((resolve, reject) => {
      const socket = netConnect(socketPath);
      this.#track(socket);
      let settled = false;
      let buffer: Buffer = Buffer.alloc(0);
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(err);
      };
      const onData = (chunk: Buffer) => {
        if (settled) return;
        buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) {
          if (buffer.length > 512) fail(new Error('invalid egress dialer response'));
          return;
        }
        socket.off('data', onData);
        const line = buffer.subarray(0, newline).toString('utf8').trim();
        const rest = buffer.subarray(newline + 1);
        buffer = Buffer.alloc(0);
        if (line === 'OK') {
          settled = true;
          if (rest.length > 0) socket.unshift(rest);
          resolve(socket);
          return;
        }
        const reason = line.startsWith('ERR ') ? line.slice(4) : line;
        fail(Object.assign(new Error(reason || 'egress dial failed'), {
          code: reason === 'forbidden' ? 'FORBIDDEN' : 'EGRESS_FAILED',
        }));
      };
      socket.on('data', onData);
      socket.once('error', (err) => fail(err));
      socket.once('close', () => fail(new Error('egress dialer closed')));
      socket.once('connect', () => {
        socket.write(`${JSON.stringify({ host, port })}\n`);
      });
    });
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
    const targetHost = normalizeHost(parsed.hostname);
    if (isLoopbackHost(targetHost, this.#extraHosts)) {
      if (!this.#allowed.has(port) || this.#denied.has(port)) {
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
      return;
    }
    if (!this.#egressSocket || isProxyRange(targetHost)) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('destination is not allowed for this session');
      return;
    }
    req.pause();
    void this.#dialEgress(targetHost, port).then((socket) => {
      if (res.destroyed || req.destroyed) {
        socket.destroy();
        return;
      }
      const upstream = httpRequest({
        host: targetHost,
        port,
        method: req.method,
        path: `${parsed.pathname}${parsed.search}`,
        headers: stripProxyHeaders(req.headers),
        agent: false,
        createConnection: () => socket,
      }, (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      });
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end('upstream service unavailable');
        else res.destroy();
      });
      req.on('error', () => upstream.destroy());
      req.pipe(upstream);
      req.resume();
    }, (err: unknown) => {
      const forbidden = (err as { code?: string })?.code === 'FORBIDDEN';
      if (!res.headersSent) {
        res.writeHead(forbidden ? 403 : 502, { 'content-type': 'text/plain' }).end(
          forbidden ? 'forbidden' : 'upstream service unavailable',
        );
      } else {
        res.destroy();
      }
    });
  }

  #handleConnect(req: IncomingMessage, clientSocket: Socket, head: Buffer): void {
    const authority = parseAuthority(req.url ?? '');
    if (!authority) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const targetHost = normalizeHost(authority.host);
    if (isLoopbackHost(targetHost, this.#extraHosts)) {
      if (!this.#allowed.has(authority.port) || this.#denied.has(authority.port)) {
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
      return;
    }
    if (!this.#egressSocket || isProxyRange(targetHost)) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    clientSocket.pause();
    void this.#dialEgress(targetHost, authority.port).then((upstream) => {
      if (clientSocket.destroyed) {
        upstream.destroy();
        return;
      }
      clientSocket.on('error', () => upstream.destroy());
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
      clientSocket.resume();
    }, (err: unknown) => {
      const forbidden = (err as { code?: string })?.code === 'FORBIDDEN';
      if (clientSocket.writable) {
        clientSocket.end(
          forbidden
            ? 'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
            : 'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
        );
      }
      clientSocket.destroy();
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
    if (parsed.protocol !== 'http:') {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const port = parsed.port ? Number(parsed.port) : 80;
    const targetHost = normalizeHost(parsed.hostname);
    const writeUpgradeHead = (upstream: Socket) => {
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
    };
    if (isLoopbackHost(targetHost, this.#extraHosts)) {
      if (!this.#allowed.has(port) || this.#denied.has(port)) {
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
      upstream.once('connect', () => writeUpgradeHead(upstream));
      return;
    }
    if (!this.#egressSocket || isProxyRange(targetHost)) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    clientSocket.pause();
    void this.#dialEgress(targetHost, port).then((upstream) => {
      if (clientSocket.destroyed) {
        upstream.destroy();
        return;
      }
      clientSocket.on('error', () => upstream.destroy());
      upstream.on('error', () => clientSocket.destroy());
      writeUpgradeHead(upstream);
      clientSocket.resume();
    }, (err: unknown) => {
      const forbidden = (err as { code?: string })?.code === 'FORBIDDEN';
      if (clientSocket.writable) {
        clientSocket.end(
          forbidden
            ? 'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
            : 'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
        );
      }
      clientSocket.destroy();
    });
  }

  async close(): Promise<void> {
    this.#egressSocket = undefined;
    this.#allowed.clear();
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
      this.#server.closeAllConnections();
    });
  }
}

export interface EgressDialer {
  readonly socketPath: string;
  close(): Promise<void>;
}

const EGRESS_DIALER_SCRIPT = fileURLToPath(new URL('./egress-dialer.ts', import.meta.url));
const DIALER_START_TIMEOUT_MS = 10_000;

/**
 * Starts the browser-user per-session Unix egress dialer so root-owned LoopbackProxy can serve Chrome's
 * `--proxy-server` + `--proxy-bypass-list=<-loopback>` while dialing non-loopback destinations as the browser user
 * under its kernel egress rules.
 */
export async function startEgressDialer(options: {
  uid: number;
  gid: number;
  home: string;
  path: string;
  socketPath: string;
}): Promise<EgressDialer> {
  const child = spawn(
    'node',
    [EGRESS_DIALER_SCRIPT, options.socketPath],
    {
      uid: options.uid,
      gid: options.gid,
      cwd: options.home,
      detached: true,
      env: { HOME: options.home, PATH: options.path, LANG: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
  const killGroup = async (signal: NodeJS.Signals) => {
    const pid = child.pid;
    if (pid !== undefined) {
      try {
        process.kill(-pid, signal);
      } catch {
        // Process group is already gone.
      }
    }
  };
  const close = async () => {
    await killGroup('SIGTERM');
    const timer = new Promise<void>((resolve) => setTimeout(resolve, 2_000).unref());
    await Promise.race([exited, timer]);
    if (child.exitCode === null && child.signalCode === null) {
      await killGroup('SIGKILL');
      await exited;
    }
    await rm(options.socketPath, { force: true }).catch(() => undefined);
  };
  try {
    await new Promise<void>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        reject(new BrowserctlError('browser_failed', 'session egress dialer did not start in time'));
      }, DIALER_START_TIMEOUT_MS);
      timer.unref();
      const finish = (err: Error) => {
        clearTimeout(timer);
        reject(err);
      };
      child.once('error', (err) => finish(new BrowserctlError('browser_failed', 'cannot start session egress dialer', { cause: err })));
      child.once('exit', () => {
        finish(new BrowserctlError('browser_failed', `session egress dialer exited early: ${stderr.trim() || 'unknown error'}`));
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        if (stderr.length < 1024) stderr += chunk;
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        const newline = stdout.indexOf('\n');
        if (newline < 0) return;
        clearTimeout(timer);
        if (stdout.slice(0, newline).trim() !== 'ready') {
          reject(new BrowserctlError('browser_failed', 'session egress dialer reported an unexpected startup line'));
          return;
        }
        resolve();
      });
    });
    return { socketPath: options.socketPath, close };
  } catch (error) {
    await close();
    throw error;
  }
}
