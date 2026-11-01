// Managed sessions with real Chrome, as container root in the image with the server's capability set.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { main } from '../../src/cli.ts';
import { BrowserctlServer } from '../../src/server/server.ts';
import { launchChrome } from '../../src/browser/chrome.ts';
import { chromeBrowser, WINDOW, type Session } from '../../src/sessions/manager.ts';
import { canRead, eventually, listeningSocketsOf, processesOf, statusField } from '../support/processes.ts';
import { adminEnvironment, runDirectory, testConfig } from '../support/server.ts';
import { assertCataloged, memoryTelemetry, type MemoryTelemetry } from '../support/telemetry.ts';

assert.equal(process.getuid?.(), 0, 'integration tests run as root in the image: node scripts/test.ts integration');

async function treeHash(root: string): Promise<string> {
  const hash = createHash('sha256');
  for (const name of (await readdir(root, { recursive: true })).sort()) {
    const path = join(root, name);
    if ((await stat(path)).isFile()) hash.update(name).update(await readFile(path));
  }
  return hash.digest('hex');
}

/** Open a page through the server's own pipe connection and wait for it to load. */
async function visit(session: Session, url: string): Promise<void> {
  const cdp = session.browser!.cdp!;
  const { targetId } = await cdp.call<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.call<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
  await cdp.call('Page.enable', {}, sessionId);
  const loaded = new Promise<void>((resolve) => {
    const stop = cdp.onEvent((event) => {
      if (event.sessionId === sessionId && event.method === 'Page.loadEventFired') {
        stop();
        resolve();
      }
    });
  });
  await cdp.call('Page.navigate', { url }, sessionId);
  await loaded;
}

async function cookies(session: Session): Promise<string[]> {
  const { cookies: list } = await session.browser!.cdp!.call<{ cookies: Array<{ name: string; value: string }> }>('Storage.getCookies');
  return list.map((cookie) => `${cookie.name}=${cookie.value}`).sort();
}

describe('managed sessions', () => {
  let run: Awaited<ReturnType<typeof runDirectory>>;
  let server: BrowserctlServer;
  let site: ReturnType<typeof createServer>;
  let siteUrl: string;
  let telemetry: MemoryTelemetry;

  before(async () => {
    telemetry = memoryTelemetry();
    run = await runDirectory();
    server = new BrowserctlServer(testConfig(run.path, { sessionLimit: 2 }));
    await server.start();
    // Stands in for the sign-in module's headful browser: the same managed Chrome, headless over the pipe.
    server.sessions.displayOpener = async (session) =>
      chromeBrowser(await launchChrome({
        userDataDir: session.workspace.profile, uid: session.users.browserUid, gid: session.users.gid,
        home: session.workspace.browserHome, temp: session.workspace.browserTemp, path: server.config.path,
        mode: { kind: 'pipe' }, windowSize: WINDOW,
      }));
    site = createServer((request, response) => {
      const headers: Record<string, string> = { 'content-type': 'text/html' };
      if (request.url === '/set') headers['set-cookie'] = 'snap=yes; Max-Age=86400; Path=/';
      if (request.url === '/mutate') headers['set-cookie'] = 'mut=1; Max-Age=86400; Path=/';
      response.writeHead(200, headers).end('<p>ok</p>');
    });
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  });

  after(async () => {
    await server.stop();
    await new Promise<void>((resolve) => site.close(() => resolve()));
    await run.remove();
    await telemetry.restore();
  });

  it('runs Chrome sandboxed as the browser user with CDP only over a pipe', async () => {
    const session = await server.sessions.open('agent-a', { kind: 'ephemeral' });
    try {
      const pid = session.browser!.pid!;
      assert.equal(Number(statusField(pid, 'Uid')!.split(/\s+/)[0]), session.users.browserUid);
      assert.notEqual(session.users.browserUid, 0);
      const { cmdline } = processesOf(session.users.browserUid).find((entry) => entry.pid === pid)!;
      assert.ok(cmdline.includes('--remote-debugging-pipe'));
      assert.ok(!cmdline.some((argument) => argument.startsWith('--remote-debugging-port') || argument === '--no-sandbox'));
      await visit(session, `${siteUrl}/`);
      assert.deepEqual(listeningSocketsOf(session.users.browserUid), [], 'Chrome listens on no TCP port');
      // Chrome's namespace sandbox puts each renderer in a PID namespace of its own, below the container's.
      const depth = (pid: number | 'self') => statusField(pid === 'self' ? process.pid : pid, 'NSpid')!.trim().split(/\s+/).length;
      const renderers = processesOf(session.users.browserUid).filter((entry) => entry.cmdline.join(' ').includes('--type=renderer'));
      assert.ok(renderers.length > 0, 'a renderer runs');
      for (const renderer of renderers) assert.ok(depth(renderer.pid) > depth('self'), 'the renderer is sandboxed in its own PID namespace');
      assert.equal(statusField(pid, 'CapEff'), '0000000000000000');
    } finally {
      await server.sessions.close(session, 'closed');
    }
  });

  it('gives each session its own users and directories only they and the server read', async () => {
    const first = await server.sessions.open('agent-a', { kind: 'ephemeral' });
    const second = await server.sessions.open('agent-b', { kind: 'ephemeral' });
    try {
      assert.equal(new Set([first.users.browserUid, first.users.sessionUid, second.users.browserUid, second.users.sessionUid]).size, 4);
      const { workspace, users } = first;
      assert.equal((await stat(workspace.profile)).uid, users.browserUid);
      assert.equal((await stat(workspace.profile)).mode & 0o7777, 0o700);
      assert.equal((await stat(workspace.files)).mode & 0o7777, 0o770);
      assert.ok(canRead(users.browserUid, users.gid, workspace.profile, true));
      assert.ok(!canRead(users.sessionUid, users.gid, workspace.profile, true), 'the session user cannot read the profile copy');
      assert.ok(canRead(users.sessionUid, users.gid, workspace.files, true));
      assert.ok(canRead(users.browserUid, users.gid, workspace.files, true));
      for (const uid of [second.users.browserUid, second.users.sessionUid]) {
        assert.ok(!canRead(uid, second.users.gid, workspace.profile, true), 'another session cannot read the profile copy');
        assert.ok(!canRead(uid, second.users.gid, workspace.files, true), 'another session cannot read the file area');
      }
    } finally {
      await Promise.all([server.sessions.close(first, 'closed'), server.sessions.close(second, 'closed')]);
    }
    await assert.rejects(stat(first.workspace.root), /ENOENT/);
  });

  it('serves CDP under the capability URL until the session ends', async () => {
    const session = await server.sessions.open('agent-a', { kind: 'ephemeral' });
    const endpoint = server.sessions.endpoint(session);
    const version = (await (await fetch(`${endpoint}/json/version`)).json()) as { webSocketDebuggerUrl: string; Browser: string };
    assert.match(version.Browser, /Chrome/);
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve) => socket.once('open', resolve));
    const reply = new Promise<{ result: { targetInfos: unknown[] } }>((resolve) => socket.once('message', (raw) => resolve(JSON.parse(raw.toString()))));
    socket.send(JSON.stringify({ id: 1, method: 'Target.getTargets' }));
    assert.ok(Array.isArray((await reply).result.targetInfos));
    const closed = new Promise((resolve) => socket.once('close', resolve));
    await server.sessions.close(session, 'closed');
    await closed;
    assert.equal((await fetch(`${endpoint}/json/version`)).status, 404);
  });

  it('starts a profile session on a copy of the current revision and never writes it back', async () => {
    await server.profiles.create('mail', 'operator');
    const agent = await server.sessions.open('agent-a', { kind: 'profile', profile: 'mail' });
    await assert.rejects(server.sessions.saveRevision(agent, 'agent-a', 30_000), /only an open sign-in session can be saved/);
    await server.sessions.close(agent, 'closed');
    const seed = await server.sessions.open('operator', { kind: 'profile', profile: 'mail' }, 'sign_in');
    await visit(seed, `${siteUrl}/set`);
    assert.equal((await server.sessions.saveRevision(seed, 'operator', 30_000)).id, '2');
    assert.equal(seed.state, 'closed');
    assert.deepEqual(processesOf(seed.users.browserUid), []);
    const revision = server.profiles.revisionPath('mail', (await server.profiles.get('mail')).current);
    const before = await treeHash(revision);

    const session = await server.sessions.open('agent-a', { kind: 'profile', profile: 'mail' });
    assert.equal(session.revision, '2');
    assert.deepEqual(await cookies(session), ['snap=yes']);
    await visit(session, `${siteUrl}/mutate`);
    assert.deepEqual(await cookies(session), ['mut=1', 'snap=yes']);
    await server.sessions.close(session, 'closed');
    assert.equal(await treeHash(revision), before, 'the revision is unchanged');
    assert.deepEqual((await server.profiles.get('mail')).revisions.map((entry) => entry.id), ['1', '2']);

    const ephemeral = await server.sessions.open('agent-a', { kind: 'ephemeral' });
    assert.deepEqual(await cookies(ephemeral), [], 'an ephemeral session starts empty');
    await server.sessions.close(ephemeral, 'closed');
  });

  it('queues a session beyond the limit until a place frees', async () => {
    const first = await server.sessions.open('agent-a', { kind: 'ephemeral' });
    const second = await server.sessions.open('agent-a', { kind: 'ephemeral' });
    let third: Session | undefined;
    const waiting = server.sessions.open('agent-a', { kind: 'ephemeral' }).then((session) => (third = session));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(third, undefined);
    await server.sessions.close(first, 'closed');
    await waiting;
    await Promise.all([server.sessions.close(second, 'closed'), server.sessions.close(third!, 'closed')]);
  });

  it('closes idle and expired sessions and stops their processes', async () => {
    const idle = await server.sessions.open('agent-a', { kind: 'ephemeral' });
    await server.sessions.sweep(Date.now() + server.config.idleSeconds * 1000 - 1000);
    assert.equal(idle.state, 'ready');
    await server.sessions.sweep(Date.now() + server.config.idleSeconds * 1000 + 1);
    await idle.closed;
    assert.equal(idle.state, 'closed');
    assert.deepEqual(processesOf(idle.users.browserUid), []);

    const busy = await server.sessions.open('agent-a', { kind: 'ephemeral' });
    busy.createdAt -= server.config.lifetimeSeconds * 1000;
    await server.sessions.sweep(Date.now());
    assert.equal(busy.state, 'closed');
  });

  it('closes a session that is revoked while it starts and leaves no browser behind', async () => {
    await server.tokens.create('agent-d');
    const opening = server.sessions.open('agent-d', { kind: 'ephemeral' });
    await eventually(() => server.sessions.list().some((session) => session.client === 'agent-d'));
    const [session] = server.sessions.list().filter((entry) => entry.client === 'agent-d');
    await server.tokens.revoke('agent-d');
    await assert.rejects(opening, /closed while it opened/);
    assert.equal(session!.state, 'closed');
    assert.deepEqual(processesOf(session!.users.browserUid), []);
    assert.equal(server.sessions.list().length, 0);
  });

  it('closes a client\'s sessions when its token is revoked', async () => {
    await server.tokens.create('agent-c');
    const session = await server.sessions.open('agent-c', { kind: 'ephemeral' });
    await server.tokens.revoke('agent-c');
    await session.closed;
    assert.equal(server.sessions.list().length, 0);
  });

  it('opens and closes an ephemeral session through the admin command', async () => {
    const lines: string[] = [];
    const status = await main(['admin', 'sessions', 'check'], adminEnvironment(server.config.stateDirectory), { out: (line) => lines.push(line), err: (line) => lines.push(line) });
    assert.equal(status, 0, lines.join('\n'));
    assert.match(lines[0]!, /^opened and closed .*Chrome/);
    assert.equal(server.sessions.list().length, 0);
  });

  it('closes every session and stops every Chrome on shutdown', async () => {
    const root = await runDirectory();
    const other = new BrowserctlServer(testConfig(root.path));
    await other.start();
    let sessions: Session[];
    try {
      sessions = await Promise.all([other.sessions.open('a', { kind: 'ephemeral' }), other.sessions.open('b', { kind: 'ephemeral' })]);
    } finally {
      await other.stop();
    }
    for (const session of sessions) {
      assert.equal(session.state, 'closed');
      await eventually(() => processesOf(session.users.browserUid).length === 0);
    }
    assert.deepEqual(await readdir(other.config.workDirectory), []);
    await root.remove();
  });

  it('emits only cataloged session signals', async () => {
    await server.profiles.create('signals', 'operator');
    const session = await server.sessions.open('operator', { kind: 'profile', profile: 'signals' }, 'sign_in');
    await server.sessions.saveRevision(session, 'operator', 30_000);
    const recorded = await telemetry.collect();
    const names = new Set([...recorded.spans.map((span) => span.name), ...recorded.metrics.map((metric) => metric.name)]);
    for (const name of ['browserctl.session.open', 'browserctl.session.close', 'browserctl.snapshot.save', 'browserctl.session.queue.wait', 'browserctl.sessions.live']) {
      assert.ok(names.has(name), name);
    }
    assertCataloged(recorded);
  });
});
