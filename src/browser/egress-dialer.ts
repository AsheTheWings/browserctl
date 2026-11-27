// Browser-user per-session egress dialer: listens on a session-private Unix socket and opens non-loopback TCP
// connections as the unprivileged browser user so kernel egress rules apply identically to Chrome itself.

import { lookup } from 'node:dns/promises';
import { chmod, rm } from 'node:fs/promises';
import { connect as netConnect, createServer, isIP, type Socket } from 'node:net';
import { isProxyRange, normalizeHost } from './loopback-proxy.ts';

const MAX_HEADER_BYTES = 2048;

interface DialRequest {
  host: string;
  port: number;
}

function parseRequest(line: string): DialRequest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const host = (parsed as { host?: unknown }).host;
  const port = (parsed as { port?: unknown }).port;
  if (typeof host !== 'string' || !host.trim()) return undefined;
  if (typeof port !== 'number' || !Number.isSafeInteger(port) || port < 1 || port > 65535) return undefined;
  return { host: normalizeHost(host), port };
}

async function resolveTarget(host: string): Promise<{ address: string; family: 4 | 6 } | 'forbidden' | undefined> {
  if (isProxyRange(host)) return 'forbidden';
  const ipVersion = isIP(host);
  if (ipVersion === 4 || ipVersion === 6) {
    return { address: host, family: ipVersion };
  }
  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookup(host, { all: true });
  } catch {
    return undefined;
  }
  if (records.length === 0) return undefined;
  for (const record of records) {
    if (isProxyRange(record.address)) return 'forbidden';
  }
  const first = records[0]!;
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

async function main(): Promise<void> {
  const socketPath = process.argv[2] ?? '';
  if (!socketPath) {
    process.stderr.write('missing egress dialer socket path\n');
    process.exit(2);
  }

  await rm(socketPath, { force: true }).catch(() => undefined);

  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };

  const server = createServer((client) => {
    track(client);
    let buffer: Buffer = Buffer.alloc(0);
    let settled = false;

    const fail = (reason: string) => {
      if (settled) return;
      settled = true;
      if (client.writable) client.end(`ERR ${reason}\n`);
      client.destroy();
    };

    const onData = (chunk: Buffer) => {
      if (settled) return;
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) {
        if (buffer.length > MAX_HEADER_BYTES) {
          client.off('data', onData);
          fail('invalid_request');
        }
        return;
      }
      client.off('data', onData);
      client.pause();
      const line = buffer.subarray(0, newline).toString('utf8').trim();
      const rest = buffer.subarray(newline + 1);
      buffer = Buffer.alloc(0);

      const req = parseRequest(line);
      if (!req) {
        fail('invalid_request');
        return;
      }

      void resolveTarget(req.host).then((target) => {
        if (settled || client.destroyed) return;
        if (target === 'forbidden') {
          fail('forbidden');
          return;
        }
        if (!target) {
          fail('dns_failed');
          return;
        }
        const upstream = netConnect({ host: target.address, port: req.port, family: target.family });
        track(upstream);
        client.on('error', () => upstream.destroy());
        upstream.on('error', (err) => {
          const code = (err as NodeJS.ErrnoException).code ?? 'connect_failed';
          if (!settled) {
            fail(code);
          } else {
            client.destroy();
          }
        });
        upstream.once('connect', () => {
          if (settled || client.destroyed) {
            upstream.destroy();
            return;
          }
          settled = true;
          client.write('OK\n');
          if (rest.length > 0) upstream.write(rest);
          upstream.pipe(client);
          client.pipe(upstream);
          client.resume();
        });
      });
    };

    client.on('data', onData);
    client.on('error', () => {
      settled = true;
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  await chmod(socketPath, 0o600);
  process.stdout.write('ready\n');

  const shutdown = () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    server.close(() => {
      void rm(socketPath, { force: true }).finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 250).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

void main();
