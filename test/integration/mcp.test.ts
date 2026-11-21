// The agent MCP endpoint with real Chrome and Playwright MCP workers, as container root in the image.

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chown, mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { chromium, type Browser } from 'playwright-core';
import { MAX_FILE_BYTES } from '../../src/sessions/files.ts';
import { BrowserctlServer } from '../../src/server/server.ts';
import { headlessSignIn, visit } from '../support/browser.ts';
import { fakeProvider } from '../support/fake-provider.ts';
import { mcpClient, type TestClient } from '../support/mcp.ts';
import { canRead, eventually, processesOf, statusField } from '../support/processes.ts';
import { runDirectory, testConfig } from '../support/server.ts';

assert.equal(process.getuid?.(), 0, 'integration tests run as root in the image: node scripts/test.ts integration');

const PAGE = `<!doctype html><title>files</title>
<a href="/report.txt" download="report.txt">Get report</a>
<input type="file" aria-label="Pick file">
<p id="cookie"></p><script>document.getElementById('cookie').textContent = document.cookie</script>`;

async function treeHash(root: string): Promise<string> {
  const hash = createHash('sha256');
  for (const name of (await readdir(root, { recursive: true })).sort()) {
    const path = join(root, name);
    if ((await stat(path)).isFile()) hash.update(name).update(await readFile(path));
  }
  return hash.digest('hex');
}

describe('agent MCP sessions', () => {
  let run: Awaited<ReturnType<typeof runDirectory>>;
  let server: BrowserctlServer;
  let site: ReturnType<typeof createServer>;
  let siteUrl: string;
  let tokenA: string;
  let tokenB: string;

  before(async () => {
    run = await runDirectory();
    server = new BrowserctlServer(testConfig(run.path));
    await server.start();
    server.sessions.displayOpener = headlessSignIn(server.config.path);
    tokenA = await server.tokens.create('agent-a');
    tokenB = await server.tokens.create('agent-b');
    site = createServer((request, response) => {
      if (request.url === '/report.txt') {
        response.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename=report.txt' }).end('downloaded-bytes');
        return;
      }
      const headers: Record<string, string> = { 'content-type': 'text/html' };
      if (request.url === '/set') headers['set-cookie'] = 'snap=yes; Max-Age=86400; Path=/';
      if (request.url === '/clear') headers['set-cookie'] = 'snap=; Max-Age=0; Path=/';
      response.writeHead(200, headers).end(PAGE);
    });
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  });

  after(async () => {
    await server.stop();
    await new Promise<void>((resolve) => site.close(() => resolve()));
    await run.remove();
  });

  async function open(token: string, args: Record<string, unknown> = { ephemeral: true }): Promise<{ client: TestClient; id: string; status: any }> {
    const client = await mcpClient(server.port, token);
    const opened = await client.call('session_open', args);
    assert.equal(opened.isError, false, opened.text);
    return { client, id: opened.json().id, status: opened.json() };
  }

  it('binds an approved existing browser to one MCP client and detaches without closing the tab', { timeout: 60_000 }, async () => {
    const consumerRoot = await runDirectory();
    const secret = randomBytes(32).toString('base64url');
    const tokenFile = join(consumerRoot.path, 'attach-token');
    let requestedBy: string | string[] | undefined;
    let attached: WebSocket | undefined;
    let browserSocket: WebSocket | undefined;
    let refuse = true;
    const wss = new WebSocketServer({ noServer: true });
    const provider = createServer((request, response) => {
      assert.equal(request.headers.authorization, `Bearer ${secret}`);
      assert.equal(request.url, '/v1/capabilities');
      response.end(JSON.stringify({ protocol: 'browserctl.existing-browser.v1', sources: ['existing'] }));
    });
    let chrome: ReturnType<typeof spawn> | undefined;
    let chromeExited: Promise<unknown> | undefined;
    let operator: Browser | undefined;
    let consumer: BrowserctlServer | undefined;
    let client: TestClient | undefined;
    let outsider: TestClient | undefined;
    try {
      await writeFile(tokenFile, secret, { mode: 0o600 });
      // The operator fixture is outside both servers' session user pools.
      const userDataDir = join(consumerRoot.path, 'operator-browser');
      chrome = spawn('chrome', ['--headless', '--no-sandbox', '--no-first-run', '--disable-dev-shm-usage',
        '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`, 'about:blank'], {
        env: { PATH: server.config.path, HOME: consumerRoot.path, TMPDIR: consumerRoot.path, LANG: 'C.UTF-8' },
        stdio: 'ignore',
      });
      chromeExited = once(chrome, 'close');
      void chromeExited.catch(() => undefined);
      let chromeUrl: string | undefined;
      await eventually(async () => {
        const marker = await readFile(join(userDataDir, 'DevToolsActivePort'), 'utf8').catch(() => '');
        const [port, path] = marker.trim().split('\n');
        if (!port || !path?.startsWith('/devtools/browser/')) return false;
        chromeUrl = `ws://127.0.0.1:${port}${path}`;
        return true;
      });
      operator = await chromium.connectOverCDP(chromeUrl!, { noDefaults: true });
      const tab = await operator.contexts()[0]!.newPage();
      await tab.goto(siteUrl);
      provider.on('upgrade', (request, socket, head) => {
        assert.equal(request.url, '/v1/attach/existing');
        assert.equal(request.headers.authorization, `Bearer ${secret}`);
        requestedBy = request.headers['x-browserctl-client'];
        if (refuse) {
          socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
          return;
        }
        const upstream = new WebSocket(chromeUrl!);
        upstream.once('error', () => socket.destroy());
        socket.once('close', () => upstream.terminate());
        upstream.once('open', () => wss.handleUpgrade(request, socket, head, (ws) => {
          attached = ws;
          browserSocket = upstream;
          ws.on('message', (data) => upstream.send(data, { binary: false }));
          upstream.on('message', (data) => ws.send(data, { binary: false }));
          upstream.once('close', () => ws.terminate());
        }));
      });
      provider.listen(0, '127.0.0.1');
      await once(provider, 'listening');
      const attachUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
      consumer = new BrowserctlServer(testConfig(consumerRoot.path, { providers: [{ name: 'workstation', attachUrl, tokenFile }] }));
      await consumer.start();
      client = await mcpClient(consumer.port, await consumer.tokens.create('trusted-agent'));
      outsider = await mcpClient(consumer.port, await consumer.tokens.create('other-agent'));
      await consumer.providers.poll();
      assert.deepEqual((await client.call('providers_list')).json().find((x: { name: string }) => x.name === 'workstation'),
        { name: 'workstation', reachable: true, sources: ['existing'] });
      assert.deepEqual((await client.call('profiles_list')).json(), []);
      const args = { provider: 'workstation', source: { type: 'existing' }, client: 'forged' };
      assert.equal((await client.call('session_open', args)).isError, true);
      assert.equal(requestedBy, undefined);
      const source = { provider: 'workstation', source: { type: 'existing' } };
      assert.match((await client.call('session_open', source)).text, /attachment was denied/);
      assert.deepEqual((await client.call('session_status')).json(), { bound: false });
      refuse = false;
      const opened = await client.call('session_open', source);
      assert.equal(opened.isError, false, opened.text);
      assert.equal(requestedBy, 'trusted-agent');
      assert.equal(opened.json().source, 'existing');
      assert.match((await client.call('browser_tabs', { action: 'list' })).text, /files/);
      assert.equal((await outsider.call('browser_tabs', { action: 'list' })).isError, true);
      assert.equal(consumer.screencasts.get(opened.json().id), undefined);
      assert.deepEqual(consumer.recordings.list(), []);
      assert.match((await client.call('task_run', { name: 'anything' })).text, /cannot drive an existing browser/);
      const detached = once(attached!, 'close', { signal: AbortSignal.timeout(5_000) });
      assert.equal((await client.call('session_close')).isError, false);
      await detached;
      assert.equal(await tab.title(), 'files');
      const again = await client.call('session_open', source);
      assert.equal(again.isError, false, again.text);
      attached!.terminate();
      await eventually(async () => !(await client!.call('session_status')).json().bound);
      assert.equal(await tab.title(), 'files');
    } finally {
      attached?.terminate();
      browserSocket?.terminate();
      await outsider?.close();
      await client?.close();
      await consumer?.stop();
      await operator?.close().catch(() => undefined);
      chrome?.kill('SIGTERM');
      await chromeExited?.catch(() => undefined);
      wss.close();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      await consumerRoot.remove();
    }
  });

  it('leases private provider-local state without sharing or writing back browser changes', async () => {
    const hostRoot = await runDirectory();
    const consumerRoot = await runDirectory();
    const secret = randomBytes(32).toString('base64url');
    const hostToken = join(hostRoot.path, 'provider-token');
    const consumerToken = join(consumerRoot.path, 'provider-token');
    await Promise.all([writeFile(hostToken, secret, { mode: 0o600 }), writeFile(consumerToken, secret, { mode: 0o600 })]);
    const host = new BrowserctlServer(testConfig(hostRoot.path, { providerTokenFile: hostToken }));
    let consumer: BrowserctlServer | undefined;
    let agent: TestClient | undefined;
    const browsers: Browser[] = [];
    try {
      await host.start();
      host.sessions.displayOpener = headlessSignIn(host.config.path);
      await host.profiles.create('work', 'operator');
      const signIn = await host.sessions.open('operator', { kind: 'profile', profile: 'work' }, 'sign_in');
      await visit(signIn, `${siteUrl}/set`);
      await host.sessions.saveRevision(signIn, 'operator', 10_000);
      const base = `http://127.0.0.1:${host.port}`;
      consumer = new BrowserctlServer(testConfig(consumerRoot.path, { providers: [{ name: 'remote', leaseUrl: base, tokenFile: consumerToken }] }));
      await consumer.start();
      await consumer.profiles.create('work', 'operator');
      agent = await mcpClient(consumer.port, await consumer.tokens.create('remote-agent'));
      await eventually(async () => (await agent!.call('providers_list')).json().some((provider: { name: string; sources: string[] }) => provider.name === 'remote' && provider.sources.includes('profile')));
      assert.deepEqual((await agent.call('profiles_list')).json(), [
        { name: 'work', provider: 'managed', current_revision: '1', services: [], notes: [] }, { name: 'work', provider: 'remote' },
      ]);
      assert.equal((await fetch(`${base}/status`)).status, 401);
      assert.equal((await fetch(`${base}/status`, { headers: { authorization: `Bearer ${tokenA}` } })).status, 401);
      const opened = await agent.call('session_open', { provider: 'remote', source: { type: 'profile', name: 'work' } });
      assert.equal(opened.isError, false, opened.text);
      assert.equal(opened.json().provider, 'remote');
      assert.equal((await agent.call('browser_navigate', { url: `${siteUrl}/` })).isError, false);
      assert.match((await agent.call('browser_snapshot')).text, /snap=yes/);
      assert.equal(consumer.screencasts.get(opened.json().id), undefined, 'a consuming operator cannot watch a private lease');
      assert.equal((await agent.call('session_close')).isError, false);
      async function openRemote(source: { type: 'ephemeral' } | { type: 'profile'; name: string }) {
        const auth = { authorization: `Bearer ${secret}` };
        const response = await fetch(`${base}/leases`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ owner: 'test', source }) });
        assert.equal(response.status, 201, await response.clone().text());
        const { lease, port } = await response.json() as { lease: string; port?: number };
        assert.equal(port, undefined);
        const path = `/leases/${lease}`;
        assert.equal((await fetch(`${base}${path}/ensure`, { method: 'POST', headers: auth })).status, 200);
        assert.equal((await fetch(`${base}${path}/cdp/json/version`)).status, 401);
        const socket = `${base.replace('http:', 'ws:')}${path}/cdp/devtools/browser`;
        await assert.rejects(chromium.connectOverCDP(socket, { timeout: 5_000 }), /401/);
        await assert.rejects(chromium.connectOverCDP(socket.replace(lease, 'A'.repeat(43)), { headers: auth, timeout: 5_000 }), /404/);
        const browser = await chromium.connectOverCDP(socket, { headers: auth, timeout: 10_000 });
        browsers.push(browser);
        const page = await browser.contexts()[0]!.newPage();
        await page.goto(`${siteUrl}/`);
        return { browser, page, release: async () => {
          assert.equal((await fetch(`${base}${path}`, { method: 'DELETE', headers: auth })).status, 200);
          assert.equal((await fetch(`${base}${path}/cdp/json/version`, { headers: auth })).status, 404);
        } };
      }
      const fromProfile = { type: 'profile', name: 'work' } as const;
      const signedIn = await openRemote(fromProfile);
      assert.match(await signedIn.page.locator('#cookie').innerText(), /snap=yes/);
      const hosted = host.sessions.list().find((session) => session.purpose === 'provider_lease');
      assert.ok(hosted);
      assert.equal(hosted.registration, undefined, 'no capability endpoint on the provider');
      assert.equal(host.screencasts.get(hosted.id), undefined);

      const isolated = await openRemote({ type: 'ephemeral' });
      assert.equal(await isolated.page.locator('#cookie').innerText(), '');
      await signedIn.page.goto(`${siteUrl}/clear`);
      assert.equal(await signedIn.page.locator('#cookie').innerText(), '');
      await signedIn.release();
      await eventually(() => !signedIn.browser.isConnected());
      await hosted.closed;
      assert.equal(host.sessions.get(hosted.id), undefined);
      assert.equal((await host.profiles.get('work')).current, '2');
      const again = await openRemote(fromProfile);
      assert.match(await again.page.locator('#cookie').innerText(), /snap=yes/, 'the saved source is unchanged after the previous lease');
      assert.equal(await isolated.page.locator('#cookie').innerText(), '');
    } finally {
      await Promise.allSettled(browsers.map((browser) => browser.close()));
      await agent?.close();
      await consumer?.stop();
      await host.stop();
      await Promise.all([consumerRoot.remove(), hostRoot.remove()]);
    }
  });

  it('drives the bound session through a Playwright worker running as the session user', async () => {
    const { client, id } = await open(tokenA);
    try {
      const session = server.sessions.get(id)!;
      const workers = processesOf(session.users.sessionUid).filter((entry) => entry.cmdline.some((argument) => argument.endsWith('src/worker/playwright.ts')));
      assert.equal(workers.length, 1, 'one worker runs as the session user');
      assert.equal(Number(statusField(workers[0]!.pid, 'Gid')!.split(/\s+/)[0]), session.users.gid);
      assert.ok(!workers[0]!.cmdline.join(' ').includes('/cdp/'), 'the capability URL is not in argv');
      assert.equal((await client.call('session_open', { ephemeral: true })).text, 'a session is already bound; call session_close first');

      const navigated = await client.call('browser_navigate', { url: `${siteUrl}/` });
      assert.equal(navigated.isError, false, navigated.text);
      const snapshot = (await client.call('browser_snapshot')).text;
      const link = /link "Get report" \[ref=(\w+)\]/.exec(snapshot)?.[1];
      const picker = /"Pick file"[^\n]*\[ref=(\w+)\]/.exec(snapshot)?.[1];
      assert.ok(link && picker, snapshot);

      const put = await client.call('session_file_put', { name: 'in.txt', content_base64: Buffer.from('uploaded-bytes').toString('base64') });
      assert.deepEqual(put.json(), { path: 'uploads/in.txt', bytes: 14 });
      const uploaded = (await stat(join(session.workspace.uploads, 'in.txt')));
      assert.equal(uploaded.uid, session.users.sessionUid);
      await client.call('browser_click', { element: 'Pick file', target: picker });
      const upload = await client.call('browser_file_upload', { paths: [join(session.workspace.uploads, 'in.txt')] });
      assert.equal(upload.isError, false, upload.text);
      const value = await client.call('browser_evaluate', { function: '() => document.querySelector("input").files[0]?.name' });
      assert.match(value.text, /"in\.txt"/);

      const click = await client.call('browser_click', { element: 'Get report', target: link });
      assert.match(click.text, /Download/);
      await eventually(async () => (await client.call('session_file_get', { name: 'report.txt' })).isError === false);
      const report = (await client.call('session_file_get', { name: 'report.txt' })).json();
      assert.equal(Buffer.from(report.content_base64, 'base64').toString(), 'downloaded-bytes');

      assert.equal((await client.call('session_close')).json().closed, id);
      assert.deepEqual((await client.call('session_status')).json(), { bound: false });
      assert.deepEqual(processesOf(session.users.sessionUid), []);
    } finally {
      await client.close();
    }
  });

  it('refuses files over 25 MiB and names outside the file area', async () => {
    const { client, id } = await open(tokenA);
    try {
      const session = server.sessions.get(id)!;
      const big = Buffer.alloc(MAX_FILE_BYTES + 1, 1).toString('base64');
      assert.equal((await client.call('session_file_put', { name: 'big.bin', content_base64: big })).text, `files are limited to ${MAX_FILE_BYTES} bytes`);
      const exact = await client.call('session_file_put', { name: 'max.bin', content_base64: Buffer.alloc(MAX_FILE_BYTES, 1).toString('base64') });
      assert.equal(exact.isError, false, exact.text);
      for (const name of ['../escape', '/etc/passwd', 'uploads/../../x', 'a/b']) {
        assert.equal((await client.call('session_file_put', { name, content_base64: 'eA==' })).isError, true, name);
      }
      for (const name of ['../profile/Local State', '/etc/passwd', '..']) {
        assert.equal((await client.call('session_file_get', { name })).isError, true, name);
      }
      await symlink('/etc/passwd', join(session.workspace.files, 'outside'));
      await symlink(join(session.workspace.profile, 'Local State'), join(session.workspace.files, 'profile-file'));
      for (const name of ['outside', 'profile-file']) {
        assert.equal((await client.call('session_file_get', { name })).text, `${name}: no such file in the session's file area`);
      }
      // The over-limit file is refused on the way out too.
      const huge = join(session.workspace.files, 'huge.bin');
      await writeFile(huge, Buffer.alloc(MAX_FILE_BYTES + 1));
      await chown(huge, session.users.sessionUid, session.users.gid);
      assert.equal((await client.call('session_file_get', { name: 'huge.bin' })).text, `files are limited to ${MAX_FILE_BYTES} bytes`);
      assert.equal((await client.call('session_file_get', { name: 'uploads/max.bin' })).isError, false);
    } finally {
      await client.close();
    }
  });

  it('keeps each client to its own sessions', async () => {
    const a = await open(tokenA);
    const b = await open(tokenB);
    try {
      const sessionA = server.sessions.get(a.id)!;
      const sessionB = server.sessions.get(b.id)!;
      assert.equal(b.client.transport.sessionId === a.client.transport.sessionId, false);
      assert.equal((await b.client.call('session_status')).json().id, b.id);
      const guessed = sessionA.registration!.endpoint(`http://127.0.0.1:${server.port}`).replace(/[A-Za-z0-9_-]{43}$/, 'A'.repeat(43));
      assert.equal((await fetch(`${guessed}/json/version`)).status, 404);
      await b.client.call('session_file_put', { name: 'b.txt', content_base64: 'Yg==' });
      assert.equal((await a.client.call('session_file_get', { name: `../${b.id}/files/uploads/b.txt` })).isError, true);
      for (const uid of [sessionB.users.sessionUid, sessionB.users.browserUid]) {
        assert.ok(!canRead(uid, sessionB.users.gid, sessionA.workspace.files, true), 'another session cannot read the file area');
      }
      await a.client.call('session_close');
      assert.equal(sessionB.state, 'ready', 'closing one client\'s session leaves the other open');
    } finally {
      await a.client.close();
      await b.client.close();
    }
  });

  it('starts an agent session on its profile\'s cookies and leaves the revision unchanged', async () => {
    await server.profiles.create('mail', 'operator');
    const seed = await server.sessions.open('operator', { kind: 'profile', profile: 'mail' }, 'sign_in');
    await visit(seed, `${siteUrl}/set`);
    await server.sessions.saveRevision(seed, 'operator', 30_000);
    const revision = server.profiles.revisionPath('mail', (await server.profiles.get('mail')).current);
    const before = await treeHash(revision);
    const { client, status } = await open(tokenA, { profile: 'mail' });
    try {
      assert.equal(status.revision, '2');
      const cookies = await client.call('browser_cookie_list', {});
      assert.match(cookies.text, /snap/);
      await client.call('browser_navigate', { url: `${siteUrl}/` });
      await client.call('browser_cookie_set', { name: 'mut', value: '1', url: siteUrl });
      await client.call('session_close');
    } finally {
      await client.close();
    }
    assert.equal(await treeHash(revision), before);
    assert.equal((await server.profiles.get('mail')).revisions.length, 2);
  });

  it('closes a revoked client\'s session, its capability path, and its CDP connections', async () => {
    const token = await server.tokens.create('agent-revoked');
    const { client, id, status } = await open(token);
    assert.equal(status.cdp_endpoint, undefined, 'agents never get the capability URL');
    const session = server.sessions.get(id)!;
    const endpoint = session.registration!.endpoint(`http://127.0.0.1:${server.port}`);
    const { webSocketDebuggerUrl } = (await (await fetch(`${endpoint}/json/version`)).json()) as { webSocketDebuggerUrl: string };
    const socket = new WebSocket(webSocketDebuggerUrl);
    await new Promise((resolve, reject) => socket.once('open', resolve).once('error', reject));
    const socketClosed = new Promise((resolve) => socket.once('close', resolve));
    await server.tokens.revoke('agent-revoked');
    await session.closed;
    await socketClosed;
    assert.equal((await fetch(`${endpoint}/json/version`)).status, 404);
    await client.client.close();
  });

  it('closes a session whose worker dies', async () => {
    const { client, id } = await open(tokenA);
    const session = server.sessions.get(id)!;
    const [worker] = processesOf(session.users.sessionUid).filter((entry) => entry.cmdline.some((argument) => argument.endsWith('src/worker/playwright.ts')));
    process.kill(worker!.pid, 'SIGKILL');
    await session.closed;
    assert.deepEqual((await client.call('session_status')).json(), { bound: false });
    await client.close();
  });

  it('closes a dropped connection\'s session', async () => {
    const { client, id } = await open(tokenA);
    const session = server.sessions.get(id)!;
    await client.close();
    await session.closed;
    assert.equal(server.sessions.get(id), undefined);
  });

  it('drives a provider browser through the relay and releases its lease on shutdown', async () => {
    // A provider browser: Chrome with a debugging port on loopback, as the test stage's user outside the session pool.
    const uid = 1099;
    const gid = 1099;
    const home = join(run.path, 'provider-browser');
    await mkdir(home, { mode: 0o700 });
    await chown(home, uid, gid);
    const chrome = spawn('chrome', ['--headless', '--remote-debugging-port=0', `--user-data-dir=${home}`, '--no-first-run', 'about:blank'], {
      uid, gid, cwd: home, env: { HOME: home, TMPDIR: home, PATH: server.config.path }, stdio: 'ignore', detached: true,
    });
    try {
      let port = 0;
      await eventually(async () => {
        port = Number((await readFile(join(home, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n')[0]);
        return port > 0;
      });
      const provider = await fakeProvider({ browserPort: port });
      const tokenFile = join(run.path, 'provider-token');
      await writeFile(tokenFile, provider.token, { mode: 0o600 });
      const root = await runDirectory();
      const other = new BrowserctlServer(testConfig(root.path, { providers: [{ name: 'fake', leaseUrl: provider.url, cdpHost: '127.0.0.1', tokenFile }] }));
      await other.start();
      try {
        const token = await other.tokens.create('agent-p');
        const client = await mcpClient(other.port, token);
        const opened = await client.call('session_open', { provider: 'fake', slot: 2 });
        assert.equal(opened.isError, false, opened.text);
        assert.equal(opened.json().source, 'provider');
        assert.equal((await client.call('browser_navigate', { url: `${siteUrl}/` })).isError, false);
        assert.match((await client.call('browser_snapshot')).text, /Get report/);
        assert.equal(provider.leases.size, 1);
        await other.stop();
        assert.equal(provider.leases.size, 0, 'shutdown releases the lease');
        await client.client.close().catch(() => undefined);
      } finally {
        await other.stop();
        await root.remove();
        await provider.close();
      }
    } finally {
      process.kill(-chrome.pid!, 'SIGKILL');
    }
  });
});
