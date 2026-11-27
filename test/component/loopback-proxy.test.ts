import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { LoopbackProxy } from '../../src/browser/loopback-proxy.ts';
import { verifyExtraCaCertFile } from '../../src/config/config.ts';
import { ConfigError } from '../../src/config/schema.ts';
import { McpEndpoint } from '../../src/mcp/endpoint.ts';
import { Providers } from '../../src/providers/external.ts';
import { HttpRouter } from '../../src/server/http.ts';
import { BrowserctlServer } from '../../src/server/server.ts';
import { mcpClient } from '../support/mcp.ts';
import { runDirectory, testConfig } from '../support/server.ts';

function proxyGet(proxyHost: string, proxyPort: number, targetUrl: string, hostHeader: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: proxyHost,
      port: proxyPort,
      method: 'GET',
      path: targetUrl,
      headers: { host: hostHeader },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

function proxyConnect(proxyHost: string, proxyPort: number, authority: string, payload: string): Promise<{ head: string; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(proxyPort, proxyHost);
    let data = '';
    socket.on('error', reject);
    socket.once('connect', () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    let established = false;
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (!established && data.includes('\r\n\r\n')) {
        established = true;
        const [head] = data.split('\r\n\r\n');
        if (!head!.startsWith('HTTP/1.1 200')) {
          socket.end();
          resolve({ head: head!, body: '' });
          return;
        }
        socket.write(payload);
      }
    });
    socket.on('end', () => {
      const idx = data.indexOf('\r\n\r\n');
      resolve({ head: idx >= 0 ? data.slice(0, idx) : data, body: idx >= 0 ? data.slice(idx + 4) : '' });
    });
  });
}

describe('LoopbackProxy', () => {
  let upstream: ReturnType<typeof createHttpServer>;
  let upstreamPort: number;

  before(async () => {
    upstream = createHttpServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ path: req.url, host: req.headers.host }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamPort = (upstream.address() as { port: number }).port;
  });

  after(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it('forwards allowed loopback HTTP and CONNECT traffic, preserves Host, and refuses unallowed or denied ports', async () => {
    const proxy = await LoopbackProxy.start({ port: 0, hosts: ['dev-alias', '*.gw.invalid'], denyPorts: new Set([8317]) });
    try {
      // Refused before allowing.
      assert.equal((await proxyGet(proxy.host, proxy.port, `http://127.0.0.1:${upstreamPort}/ping`, `127.0.0.1:${upstreamPort}`)).status, 403);
      assert.match((await proxyConnect(proxy.host, proxy.port, `127.0.0.1:${upstreamPort}`, '')).head, /403 Forbidden/);

      // Denied policy port cannot be allowed.
      assert.throws(() => proxy.allow(8317), /denied by server policy/);

      // Allowing opens HTTP + CONNECT for 127.0.0.1, exact extra hosts, and wildcard subdomains, preserving Host header.
      assert.deepEqual(proxy.allow(upstreamPort), [upstreamPort]);
      const ok = await proxyGet(proxy.host, proxy.port, `http://dev-alias:${upstreamPort}/hello?x=1`, `dev-alias:${upstreamPort}`);
      assert.equal(ok.status, 200);
      assert.deepEqual(JSON.parse(ok.body), { path: '/hello?x=1', host: `dev-alias:${upstreamPort}` });

      const wildcardHttp = await proxyGet(proxy.host, proxy.port, `http://app.gw.invalid:${upstreamPort}/gw`, `app.gw.invalid:${upstreamPort}`);
      assert.equal(wildcardHttp.status, 200);
      assert.deepEqual(JSON.parse(wildcardHttp.body), { path: '/gw', host: `app.gw.invalid:${upstreamPort}` });

      // Non-loopback host, bare wildcard apex, and sibling suffix are still refused even on an allowed port.
      assert.equal((await proxyGet(proxy.host, proxy.port, `http://example.com:${upstreamPort}/`, `example.com:${upstreamPort}`)).status, 403);
      assert.equal((await proxyGet(proxy.host, proxy.port, `http://gw.invalid:${upstreamPort}/`, `gw.invalid:${upstreamPort}`)).status, 403);
      assert.equal((await proxyGet(proxy.host, proxy.port, `http://evilgw.invalid:${upstreamPort}/`, `evilgw.invalid:${upstreamPort}`)).status, 403);

      // CONNECT tunnel works for allowed loopback host and wildcard subdomain.
      const tunneled = await proxyConnect(
        proxy.host,
        proxy.port,
        `127.0.0.1:${upstreamPort}`,
        `GET /tunnel HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\nConnection: close\r\n\r\n`,
      );
      assert.match(tunneled.head, /^HTTP\/1\.1 200/);
      assert.match(tunneled.body, /"path":"\/tunnel"/);

      const wildcardConnect = await proxyConnect(
        proxy.host,
        proxy.port,
        `app.gw.invalid:${upstreamPort}`,
        `GET /gw-tunnel HTTP/1.1\r\nHost: app.gw.invalid:${upstreamPort}\r\nConnection: close\r\n\r\n`,
      );
      assert.match(wildcardConnect.head, /^HTTP\/1\.1 200/);
      assert.match(wildcardConnect.body, /"path":"\/gw-tunnel"/);
      assert.match((await proxyConnect(proxy.host, proxy.port, `gw.invalid:${upstreamPort}`, '')).head, /403 Forbidden/);

      // Revoking immediately blocks again.
      assert.deepEqual(proxy.revoke(upstreamPort), [upstreamPort]);
      assert.equal((await proxyGet(proxy.host, proxy.port, `http://127.0.0.1:${upstreamPort}/ping`, `127.0.0.1:${upstreamPort}`)).status, 403);
    } finally {
      await proxy.close();
    }
  });

  it('gates session_loopback_allow behind client token loopback permission', async () => {
    const run = await runDirectory();
    const server = new BrowserctlServer(testConfig(run.path));
    await server.start();
    const proxy = await LoopbackProxy.start({ port: 0, hosts: ['dev-alias'], denyPorts: new Set([8317]) });
    const router = new HttpRouter();
    const fakeSession = { id: 's-loopback0001', state: 'ready', loopbackProxy: proxy } as any;
    const fakeWorker = { call: async () => ({ content: [] }), stop: async () => undefined, exited: new Promise(() => undefined) } as any;
    const endpoint = new McpEndpoint({
      tokens: server.tokens,
      sessions: {
        onClose: () => undefined,
        touch: () => undefined,
        open: async () => fakeSession,
        close: async () => undefined,
        endpoint: () => 'http://127.0.0.1:1/cdp',
        list: () => [fakeSession],
        managedCapacity: () => ({ total: 4, used: 1, available: 3, queued: 0 }),
      } as any,
      profiles: server.profiles,
      providers: new Providers([], { onLeaseLost: () => undefined }),
      tasks: server.tasks,
      runner: server.runner,
      audit: server.audit,
      path: server.config.path,
      publicBaseUrl: 'http://127.0.0.1:1',
      version: '0.0.0',
      idleSeconds: 60,
    });
    endpoint.mount(router);
    const port = await router.listen('127.0.0.1', 0);
    const token = await server.tokens.create('loopback-agent');
    const client = await mcpClient(port, token);
    try {
      // Denied by default before opening or granting.
      const denied = await client.call('session_loopback_allow', { port: upstreamPort });
      assert.deepEqual([denied.isError, denied.text], [true, 'this client cannot allow loopback ports']);

      // Grant permission via TokenStore (same path as `admin tokens loopback allow`).
      await server.tokens.setLoopback('loopback-agent', true);
      assert.equal(server.tokens.canAccessLoopback('loopback-agent'), true);
      const unbound = await client.call('session_loopback_allow', { port: upstreamPort });
      assert.deepEqual([unbound.isError, unbound.text], [true, 'no session is bound; call session_open first']);
    } finally {
      await client.close();
      await endpoint.stop();
      await router.close();
      await proxy.close();
      await server.stop();
      await run.remove();
      void fakeWorker;
    }
  });

  it('validates optional BROWSERCTL_EXTRA_CA_CERT_FILE as a readable PEM certificate', async () => {
    const run = await runDirectory();
    try {
      const base = testConfig(run.path);
      assert.doesNotThrow(() => verifyExtraCaCertFile(base));
      assert.throws(
        () => verifyExtraCaCertFile({ ...base, extraCaCertFile: join(run.path, 'missing.crt') }),
        (error: unknown) => error instanceof ConfigError && /is unreadable/.test(error.message),
      );
      const invalid = join(run.path, 'invalid.crt');
      await writeFile(invalid, 'not a certificate\n', 'utf8');
      assert.throws(
        () => verifyExtraCaCertFile({ ...base, extraCaCertFile: invalid }),
        (error: unknown) => error instanceof ConfigError && /PEM certificate/.test(error.message),
      );
      const valid = join(run.path, 'valid.crt');
      await writeFile(valid, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n', 'utf8');
      assert.doesNotThrow(() => verifyExtraCaCertFile({ ...base, extraCaCertFile: valid }));
    } finally {
      await run.remove();
    }
  });
});
