// Dashboard access: one-time links, session cookies, Origin checks, and revocation, in process without browsers.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { main } from '../../src/cli.ts';
import { BrowserctlServer } from '../../src/server/server.ts';
import { eventually } from '../support/processes.ts';
import { adminEnvironment, runDirectory, testConfig } from '../support/server.ts';
import { keepTelemetry } from '../support/telemetry.ts';

const ORIGIN = 'http://browserctl.example:8443';

describe('dashboard access', () => {
  let run: Awaited<ReturnType<typeof runDirectory>>;
  let server: BrowserctlServer;
  let base: string;

  before(async () => {
    run = await runDirectory();
    server = new BrowserctlServer(testConfig(run.path, { publicBaseUrl: ORIGIN }));
    await server.start();
    base = `http://127.0.0.1:${server.port}`;
    await server.tokens.create('operator');
    await server.tokens.create('other');
  });

  after(async () => {
    await server.stop();
    await run.remove();
  });

  /** Open a dashboard link and return its session cookie. */
  async function signIn(client = 'operator'): Promise<string> {
    const token = server.dashboardAuth.link(client);
    const response = await fetch(`${base}/dashboard/login?token=${token}`, { redirect: 'manual' });
    assert.equal(response.status, 303);
    return response.headers.get('set-cookie')!.split(';')[0]!;
  }

  const post = (path: string, cookie: string | undefined, origin: string | undefined, body: unknown = {}) =>
    fetch(`${base}/dashboard/api${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie && { cookie }), ...(origin && { origin }) },
      body: JSON.stringify(body),
    });

  it('prints a link that works once and sets an HttpOnly SameSite=Strict cookie for 7 days', async () => {
    const lines: string[] = [];
    const output = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
    assert.equal(await main(['admin', 'dashboard-link', 'operator'], adminEnvironment(server.config.stateDirectory), output, { startTelemetry: keepTelemetry }), 0);
    const link = new URL(lines[0]!);
    assert.equal(link.origin, ORIGIN);
    assert.equal(link.pathname, '/dashboard/login');
    const local = `${base}${link.pathname}${link.search}`;

    const first = await fetch(local, { redirect: 'manual' });
    assert.equal(first.status, 303);
    assert.equal(first.headers.get('location'), '/dashboard/');
    const cookie = first.headers.get('set-cookie')!;
    assert.match(cookie, /^browserctl_dashboard=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/dashboard; Max-Age=604800$/);
    const stored = await readFile(join(server.config.stateDirectory, 'dashboard-sessions.json'), 'utf8');
    assert.ok(!stored.includes(cookie.split(';')[0]!.split('=')[1]!), 'only the session hash is stored');

    assert.equal((await fetch(local, { redirect: 'manual' })).status, 401, 'a link works once');
    const state = await fetch(`${base}/dashboard/api/state`, { headers: { cookie: cookie.split(';')[0]! } });
    assert.equal(state.status, 200);
    assert.equal(((await state.json()) as { client: string }).client, 'operator');

    assert.equal(await main(['admin', 'dashboard-link', 'nobody'], adminEnvironment(server.config.stateDirectory), output, { startTelemetry: keepTelemetry }), 1);
  });

  it('refuses a link after 10 minutes', async () => {
    const token = server.dashboardAuth.link('operator', Date.now() - 10 * 60 * 1000 - 1);
    assert.equal((await fetch(`${base}/dashboard/login?token=${token}`, { redirect: 'manual' })).status, 401);
  });

  it('refuses API requests without a dashboard session', async () => {
    assert.equal((await fetch(`${base}/dashboard/api/state`)).status, 401);
    assert.equal((await fetch(`${base}/dashboard/api/state`, { headers: { cookie: 'browserctl_dashboard=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } })).status, 401);
    assert.equal((await post('/profiles', undefined, ORIGIN, { name: 'x' })).status, 401);
  });

  it('refuses state changes and WebSocket upgrades from a foreign Origin', async () => {
    const cookie = await signIn();
    for (const origin of ['http://evil.example', undefined, 'http://browserctl.example:8444']) {
      assert.equal((await post('/profiles', cookie, origin, { name: 'mail' })).status, 403, `Origin ${origin}`);
    }
    assert.equal((await server.profiles.list()).length, 0);
    const created = await post('/profiles', cookie, ORIGIN, { name: 'mail' });
    assert.equal(created.status, 201);
    assert.deepEqual((await server.profiles.list()).map((profile) => profile.name), ['mail']);

    const upgrade = (origin: string) =>
      new Promise<string>((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:${server.port}/dashboard/ws/screencast/s-missing`, { headers: { cookie, origin } });
        socket.once('unexpected-response', (_request, response) => resolve(String(response.statusCode)));
        socket.once('open', () => resolve('open'));
        socket.once('error', () => resolve('error'));
      });
    assert.equal(await upgrade('http://evil.example'), '403');
    assert.equal(await upgrade(ORIGIN), '404', 'the right Origin reaches the lookup');
  });

  it('manages profiles: pins, current revision, services, and deletion', async () => {
    const cookie = await signIn();
    await server.profiles.addRevision('mail', join(run.path, 'state', 'profiles', 'mail', 'revisions', '1'), 'operator');
    assert.equal((await post('/profiles/mail/revisions/1/pin', cookie, ORIGIN, { pinned: true })).status, 200);
    assert.equal((await post('/profiles/mail/current', cookie, ORIGIN, { revision: '1' })).status, 200);
    let profile = await server.profiles.get('mail');
    assert.equal(profile.current, '1');
    assert.equal(profile.revisions.find((revision) => revision.id === '1')?.pinned, true);
    assert.equal((await post('/profiles/mail/services', cookie, ORIGIN, { name: 'mail', task: 'missing' })).status, 404, 'a service names a saved task');
    await server.tasks.save('mail-check', "import { test } from 'e2e';\ntest('x', async () => {});\n", 'operator');
    assert.equal((await post('/profiles/mail/services', cookie, ORIGIN, { name: 'mail', task: 'mail-check' })).status, 201);
    assert.deepEqual((await server.profiles.get('mail')).services.map((service) => service.task), ['mail-check']);
    assert.equal((await post('/profiles/mail/services/mail/delete', cookie, ORIGIN)).status, 200);
    profile = await server.profiles.get('mail');
    assert.deepEqual(profile.services, []);
    assert.equal((await post('/profiles/mail/delete', cookie, ORIGIN)).status, 200);
    assert.deepEqual(await server.profiles.list(), []);
  });

  it('lists tasks with their revisions and recent runs with their input and output', async () => {
    const cookie = await signIn();
    await server.runs.append({
      run: 'r-1', task: 'mail-check', revision: '1', client: 'agent-a', session: 's-1', status: 'passed',
      startedAt: new Date().toISOString(), durationMs: 1200, input: '{"order":7}', output: '{"status":"shipped"}', failure: undefined,
    });
    const state = (await (await fetch(`${base}/dashboard/api/state`, { headers: { cookie } })).json()) as any;
    assert.deepEqual(state.tasks.map((task: any) => [task.name, task.revisions.map((revision: any) => revision.client)]), [['mail-check', ['operator']]]);
    assert.deepEqual([state.runs[0].run, state.runs[0].client, state.runs[0].input, state.runs[0].output], ['r-1', 'agent-a', '{"order":7}', '{"status":"shipped"}']);
    const source = (await (await fetch(`${base}/dashboard/api/tasks/mail-check/revisions/1`, { headers: { cookie } })).json()) as any;
    assert.match(source.content, /import \{ test \} from 'e2e'/);
  });

  it('ends a client\'s dashboard sessions when its token is revoked', async () => {
    const cookie = await signIn('other');
    assert.equal((await fetch(`${base}/dashboard/api/state`, { headers: { cookie } })).status, 200);
    await server.tokens.revoke('other');
    assert.equal((await fetch(`${base}/dashboard/api/state`, { headers: { cookie } })).status, 401);
    await eventually(async () => !(await readFile(join(server.config.stateDirectory, 'dashboard-sessions.json'), 'utf8')).includes('"other"'));
  });
});
