import assert from 'node:assert/strict';
import { chmod, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { socketPath } from '../../src/admin/socket.ts';
import { TokenStore } from '../../src/auth/tokens.ts';
import { isOwnerOnly, readProtectedFile } from '../../src/config/config.ts';
import { ConfigError } from '../../src/config/schema.ts';
import { BrowserctlServer } from '../../src/server/server.ts';
import { runDirectory, testConfig } from '../support/server.ts';

describe('server startup', () => {
  let run: Awaited<ReturnType<typeof runDirectory>>;
  before(async () => {
    run = await runDirectory();
  });
  after(() => run.remove());

  it('checks protected files on real file modes', async () => {
    const open = join(run.path, 'open-key');
    const closed = join(run.path, 'closed-key');
    await writeFile(open, 'k\n', { mode: 0o644 });
    await chmod(open, 0o644);
    await writeFile(closed, 'k\n', { mode: 0o600 });
    assert.equal(isOwnerOnly(open), false);
    assert.equal(isOwnerOnly(closed), true);
    assert.equal(readProtectedFile(closed, 'INPUT'), 'k');
    assert.throws(() => readProtectedFile(open, 'INPUT'), /INPUT: .* must be readable by its owner alone/);
    assert.throws(() => readProtectedFile(join(run.path, 'none'), 'INPUT'), /INPUT: .* is unreadable/);
  });

  it('refuses to start when a protected file is open to others or missing', async () => {
    const root = join(run.path, 'protected');
    const key = join(run.path, 'open-key');
    const server = new BrowserctlServer(testConfig(root, {
      model: { baseUrl: 'http://127.0.0.1:1/v1', name: 'm', keyFile: key },
      providers: [{ name: 'example', leaseUrl: 'http://192.0.2.10:8000', cdpHost: '192.0.2.10', tokenFile: join(run.path, 'none') }],
    }));
    await assert.rejects(server.start(), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.problems.length, 2);
      assert.match(error.problems[0]!, /^BROWSERCTL_MODEL_KEY_FILE: .* owner alone$/);
      assert.match(error.problems[1]!, /^BROWSERCTL_PROVIDERS example tokenFile: .* unreadable$/);
      return true;
    });
    await server.stop();
  });

  it('keeps tokens across a restart and refuses a malformed token file', async () => {
    const state = join(run.path, 'tokens');
    const first = new TokenStore(state);
    await first.load();
    const kept = await first.create('kept');
    const dropped = await first.create('dropped');
    await first.revoke('dropped');
    const second = new TokenStore(state);
    await second.load();
    assert.equal(second.authenticate(kept), 'kept');
    assert.equal(second.authenticate(dropped), undefined);

    const broken = join(run.path, 'broken');
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, 'tokens.json'), '{"version":1,"clients":[{"name":"x"}]}');
    await assert.rejects(new TokenStore(broken).load(), /tokens.json in the state directory is malformed/);
    const record = { name: 'x', sha256: '0'.repeat(64), createdAt: '2026-01-01T00:00:00.000Z' };
    for (const clients of [[record, record], [{ ...record, name: 'admin' }], [{ ...record, name: 'Bad' }]]) {
      await writeFile(join(broken, 'tokens.json'), JSON.stringify({ version: 1, clients }));
      await assert.rejects(new TokenStore(broken).load(), /malformed/);
    }
    await writeFile(join(broken, 'tokens.json'), '{"vers');
    const server = new BrowserctlServer(testConfig(join(run.path, 'broken-root'), { stateDirectory: broken }));
    await assert.rejects(server.start(), /tokens.json/);
    await server.stop();
  });

  it('reserves the names of browserctl audit actors', async () => {
    const store = new TokenStore(join(run.path, 'reserved'));
    await store.load();
    for (const name of ['admin', 'browserctl']) await assert.rejects(store.create(name), /reserved/);
  });

  it('refuses a second server on the same state directory and leaves the first one serving', async () => {
    const root = join(run.path, 'twice');
    const first = new BrowserctlServer(testConfig(root));
    await first.start();
    try {
      const live = join(first.config.workDirectory, 's-AAAAAAAAAAAA', 'profile');
      await mkdir(live, { recursive: true });
      await first.profiles.create('mail', 'operator');
      const staging = join(first.config.stateDirectory, 'profiles', 'mail', 'revisions', '.staging-abcd');
      await mkdir(staging);
      const second = new BrowserctlServer(testConfig(root));
      await assert.rejects(second.start(), /another server uses this state directory/);
      await second.stop();
      await stat(live);
      await stat(staging);
      assert.deepEqual(await request(socketPath(first.config.stateDirectory), '{"command":"tokens.list"}\n'), { ok: true, result: [] });
    } finally {
      await first.stop();
    }
  });

  it('replaces a stale admin socket left by a stopped server', async () => {
    const root = join(run.path, 'stale');
    const first = new BrowserctlServer(testConfig(root));
    await first.start();
    await first.stop();
    const stale = createServer();
    await new Promise<void>((resolve) => stale.listen(socketPath(first.config.stateDirectory), resolve));
    // Closing a listener without unlinking leaves the path behind, as a crashed server would.
    await new Promise<void>((resolve) => stale.close(() => resolve()));
    await writeFile(socketPath(first.config.stateDirectory), '');
    const second = new BrowserctlServer(testConfig(root));
    await second.start();
    await second.stop();
  });

  it('names the failing step and error code when the port is taken', async () => {
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
    const port = (holder.address() as { port: number }).port;
    const server = new BrowserctlServer(testConfig(join(run.path, 'port'), { port }));
    try {
      await assert.rejects(server.start(), { message: `cannot listen on 127.0.0.1:${port} (EADDRINUSE)` });
    } finally {
      await server.stop();
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });

  it('refuses a work directory the browser users cannot reach, and removes leftover session directories', async () => {
    const closed = join(run.path, 'closed');
    await mkdir(closed, { mode: 0o700 });
    await chmod(closed, 0o700);
    const blocked = new BrowserctlServer({ ...testConfig(join(run.path, 'reach')), workDirectory: join(closed, 'work') });
    await assert.rejects(blocked.start(), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.deepEqual(error.problems, [`BROWSERCTL_WORK_DIRECTORY: browser users cannot pass through ${closed}`]);
      return true;
    });
    await blocked.stop();

    const config = testConfig(join(run.path, 'leftovers'));
    await mkdir(join(config.workDirectory, 's-AAAAAAAAAAAA', 'profile'), { recursive: true });
    await mkdir(join(config.workDirectory, 'keep'), { recursive: true });
    const server = new BrowserctlServer(config);
    await server.start();
    await server.stop();
    assert.deepEqual(await readdir(config.workDirectory), ['keep']);
  });
});

function request(path: string, text: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path, () => socket.write(text));
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => (buffer += chunk));
    socket.on('error', reject);
    socket.on('close', () => {
      try {
        resolve(buffer === '' ? undefined : JSON.parse(buffer));
      } catch (error) {
        reject(error);
      }
    });
  });
}

describe('admin socket requests', () => {
  let run: Awaited<ReturnType<typeof runDirectory>>;
  let server: BrowserctlServer;
  before(async () => {
    run = await runDirectory();
    server = new BrowserctlServer(testConfig(run.path));
    await server.start();
  });
  after(async () => {
    await server.stop();
    await run.remove();
  });

  it('refuses malformed, unknown, and oversized requests', async () => {
    const path = socketPath(server.config.stateDirectory);
    assert.deepEqual(await request(path, 'not json\n'), { ok: false, error: 'malformed request', errorClass: 'invalid_request' });
    assert.deepEqual(await request(path, '{"command":"nope"}\n'), { ok: false, error: 'unknown admin command', errorClass: 'invalid_request' });
    assert.deepEqual(await request(path, '{"command":"tokens.create","args":{}}\n'), {
      ok: false,
      error: 'a client name is required',
      errorClass: 'invalid_request',
    });
    assert.equal(await request(path, 'x'.repeat(70 * 1024)), undefined);
  });
});
