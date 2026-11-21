import assert from 'node:assert/strict';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { it } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { BrowserctlServer } from '../../src/server/server.ts';
import { COOKIE } from '../../src/dashboard/auth.ts';
import { runDirectory, testConfig } from '../support/server.ts';
import { eventually } from '../support/processes.ts';
import { OWNER_ID } from '../support/github.ts';

it('protects provider edits by dashboard credential and sends only scoped editor input', async () => {
  const run = await runDirectory();
  const managementToken = Buffer.alloc(32, 20).toString('base64url');
  const ordinaryToken = Buffer.alloc(32, 19).toString('base64url');
  const profileTokenFile = join(run.path, 'management');
  const tokenFile = join(run.path, 'ordinary');
  const lease = 'a'.repeat(43);
  const endpoint = `/profile-edits/${lease}`;
  const routes: string[] = [];
  const commands: string[] = [];
  const revision = { id: 'revision-1', client: `github:${OWNER_ID}`, createdAt: '2026-01-01T00:00:00.000Z', pinned: false };
  const upstream = new WebSocketServer({ noServer: true });
  const provider = createServer(async (req, res) => {
    const status = req.url === '/status';
    const expected = status ? ordinaryToken : managementToken;
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== `Bearer ${expected}`) return res.writeHead(401).end('{}');
    routes.push(`${req.method} ${req.url}`);
    let body: unknown = {};
    if (status) body = { slots: [], capabilities: { cdp: 'lease', sources: ['profile'], profiles: ['work'], profileManagement: 1 } };
    else if (req.url === '/profile-edits') body = { lease, slot: 1, cdp: 'lease', source: { type: 'profile', name: 'work' } };
    else if (req.url === `${endpoint}/ensure`) body = { cdp: 'lease' };
    else if (req.url === `${endpoint}/save`) body = { revision };
    res.end(JSON.stringify(body));
  });
  provider.on('upgrade', (req, socket, head) => {
    if (req.headers.authorization !== `Bearer ${managementToken}` || req.url !== `${endpoint}/cdp/devtools/browser`) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    upstream.handleUpgrade(req, socket, head, (ws) => ws.on('message', (raw) => {
      const { id, method, sessionId } = JSON.parse(raw.toString()) as { id: number; method: string; sessionId?: string };
      commands.push(method);
      ws.send(JSON.stringify({ id, result: method === 'Target.attachToTarget' ? { sessionId: 'page' } : {} }));
      if (method === 'Target.setDiscoverTargets') ws.send(JSON.stringify({
        method: 'Target.targetCreated', params: { targetInfo: { type: 'page', targetId: 'page-id' } },
      }));
      if (method === 'Page.startScreencast') ws.send(JSON.stringify({
        method: 'Page.screencastFrame', sessionId, params: { data: Buffer.from('image').toString('base64'), sessionId: 1 },
      }));
    }));
  });
  let dashboard: BrowserctlServer | undefined;
  let client: WebSocket | undefined;
  try {
    await writeFile(tokenFile, ordinaryToken, { mode: 0o600 });
    await writeFile(profileTokenFile, managementToken, { mode: 0o600 });
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address() as { port: number };
    const origin = 'http://dashboard.example';
    dashboard = new BrowserctlServer(testConfig(run.path, {
      publicBaseUrl: origin, providers: [{ name: 'demo', leaseUrl: `http://127.0.0.1:${address.port}`, tokenFile, profileTokenFile }],
    }));
    await dashboard.start();
    await dashboard.providers.poll();
    const base = `http://127.0.0.1:${dashboard.port}`;
    const headers = { cookie: `${COOKIE}=${await dashboard.dashboardAuth.issue(OWNER_ID)}`, origin, 'content-type': 'application/json' };
    const separate = { ...headers, cookie: `${COOKIE}=${await dashboard.dashboardAuth.issue(OWNER_ID)}` };
    const post = (path: string, auth = headers, body: unknown = {}) =>
      fetch(`${base}/dashboard/api${path}`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
    assert.equal((await post('/provider-profiles/demo/edit', { ...headers, origin: 'https://other.example' }, { name: 'work' })).status, 403);
    const open = await post('/provider-profiles/demo/edit', headers, { name: 'work' });
    assert.equal(open.status, 201);
    const { edit } = await open.json() as { edit: string };
    assert.notEqual(edit, lease);
    const save = `/profile-edits/${edit}/save`;
    assert.equal((await post(save, separate)).status, 404);
    const view = `${base.replace('http:', 'ws:')}/dashboard/ws/profile-edit/${edit}`;
    await assert.rejects(once(new WebSocket(view, { headers: separate }), 'open'), /404/);
    client = new WebSocket(view, { headers });
    const [frame, binary] = await once(client, 'message');
    assert.equal(binary, true);
    assert.equal(frame.toString(), 'image');
    client.send(JSON.stringify({ method: 'Runtime.evaluate', params: { expression: '42' } }));
    client.send(JSON.stringify({ type: 'navigate', url: 'https://example.test/' }));
    await eventually(() => commands.includes('Page.navigate'));
    assert.ok(!commands.includes('Runtime.evaluate'));
    assert.equal((await post(save)).status, 200);
    assert.ok(routes.includes(`POST ${endpoint}/save`));
    assert.ok(!routes.includes(`DELETE ${endpoint}`));
  } finally {
    client?.terminate();
    await dashboard?.stop();
    for (const ws of upstream.clients) ws.terminate();
    upstream.close();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await run.remove();
  }
});
