// The agent MCP endpoint with real Chrome and Playwright MCP workers, as container root in the image.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chown, mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
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
