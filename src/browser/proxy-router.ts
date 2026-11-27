// Browser-user per-session HTTP/CONNECT proxy router: routes loopback and configured extra hosts to the server's
// LoopbackProxy (which enforces per-session port grants and deny policy) and connects all other destinations directly
// as the unprivileged browser user so kernel egress rules apply identically to Chrome itself.

import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import { isLoopbackHost, normalizeHost, parseAuthority } from './loopback-proxy.ts';

function randomLoopbackAddress(avoid: string): string {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const bytes = randomBytes(3);
    const second = 16 + (bytes[0]! & 0x0f); // 127.16.0.0/12
    const third = bytes[1]!;
    const fourth = 1 + (bytes[2]! % 254);
    const candidate = `127.${second}.${third}.${fourth}`;
    if (candidate !== avoid) return candidate;
  }
  return '127.16.0.2';
}

function isProxyRange(host: string): boolean {
  const normalized = normalizeHost(host);
  const parts = normalized.split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map(Number);
  return nums.every((n, i) => /^\d+$/.test(parts[i]!) && n >= 0 && n <= 255)
    && nums[0] === 127 && nums[1]! >= 16 && nums[1]! <= 31;
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

function formatHeaders(headers: IncomingMessage['headers']): string {
  let raw = '';
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) raw += `${key}: ${entry}\r\n`;
    } else {
      raw += `${key}: ${value}\r\n`;
    }
  }
  return raw;
}

async function main(): Promise<void> {
  const bindPort = Number(process.argv[2]);
  const upstreamHost = process.argv[3] ?? '';
  const upstreamPort = Number(process.argv[4]);
  const extraHosts = new Set<string>(JSON.parse(process.argv[5] ?? '[]') as string[]);
  if (!Number.isSafeInteger(bindPort) || bindPort < 0 || bindPort > 65535
      || !upstreamHost || !Number.isSafeInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535) {
    process.stderr.write('invalid proxy-router arguments\n');
    process.exit(2);
  }

  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };

  const server = createServer();
  server.on('connection', track);

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    let parsed: URL;
    try {
      parsed = new URL(req.url ?? '');
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('bad proxy request');
      return;
    }
    if (parsed.protocol !== 'http:') {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('proxy allows only http and CONNECT');
      return;
    }
    const targetPort = parsed.port ? Number(parsed.port) : 80;
    const targetHost = normalizeHost(parsed.hostname);
    if (isLoopbackHost(targetHost, extraHosts)) {
      const upstream = httpRequest({
        host: upstreamHost,
        port: upstreamPort,
        method: req.method,
        path: req.url,
        headers: req.headers,
      }, (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      });
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end('loopback proxy unavailable');
        else res.destroy();
      });
      req.on('error', () => upstream.destroy());
      req.pipe(upstream);
      return;
    }
    if (isProxyRange(targetHost)) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden');
      return;
    }
    const upstream = httpRequest({
      host: targetHost,
      port: targetPort,
      method: req.method,
      path: `${parsed.pathname}${parsed.search}`,
      headers: stripProxyHeaders(req.headers),
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end('upstream unavailable');
      else res.destroy();
    });
    req.on('error', () => upstream.destroy());
    req.pipe(upstream);
  });

  server.on('connect', (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    const authority = parseAuthority(req.url ?? '');
    if (!authority) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const targetHost = normalizeHost(authority.host);
    if (isLoopbackHost(targetHost, extraHosts)) {
      const upstream = netConnect(upstreamPort, upstreamHost);
      track(upstream);
      clientSocket.on('error', () => upstream.destroy());
      upstream.on('error', () => {
        if (clientSocket.writable) clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        clientSocket.destroy();
      });
      upstream.once('connect', () => {
        upstream.write(`CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\n\r\n`);
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      return;
    }
    if (isProxyRange(targetHost)) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const upstream = netConnect(authority.port, targetHost);
    track(upstream);
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
  });

  server.on('upgrade', (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
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
    const targetPort = parsed.port ? Number(parsed.port) : 80;
    const targetHost = normalizeHost(parsed.hostname);
    if (isLoopbackHost(targetHost, extraHosts)) {
      const upstream = netConnect(upstreamPort, upstreamHost);
      track(upstream);
      clientSocket.on('error', () => upstream.destroy());
      upstream.on('error', () => {
        if (clientSocket.writable) clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        clientSocket.destroy();
      });
      upstream.once('connect', () => {
        upstream.write(`${req.method ?? 'GET'} ${req.url} HTTP/1.1\r\n${formatHeaders(req.headers)}\r\n`);
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      return;
    }
    if (isProxyRange(targetHost)) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const upstream = netConnect(targetPort, targetHost);
    track(upstream);
    clientSocket.on('error', () => upstream.destroy());
    upstream.on('error', () => {
      if (clientSocket.writable) clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      clientSocket.destroy();
    });
    upstream.once('connect', () => {
      const headers = stripProxyHeaders(req.headers);
      upstream.write(`${req.method ?? 'GET'} ${parsed.pathname}${parsed.search} HTTP/1.1\r\n${formatHeaders(headers)}\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
  });

  let boundHost = '';
  let boundPort = 0;
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = randomLoopbackAddress(upstreamHost);
    try {
      boundPort = await new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(bindPort, candidate, () => {
          server.off('error', reject);
          const address = server.address();
          resolve(typeof address === 'object' && address ? address.port : bindPort);
        });
      });
      boundHost = candidate;
      break;
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') break;
    }
  }
  if (!boundHost) {
    process.stderr.write(`cannot bind proxy router: ${String(lastError)}\n`);
    process.exit(1);
  }
  process.stdout.write(`${boundHost}:${boundPort}\n`);

  const shutdown = () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    server.close(() => process.exit(0));
    server.closeAllConnections();
    setTimeout(() => process.exit(0), 250).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

void main();
