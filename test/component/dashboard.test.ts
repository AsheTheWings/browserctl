// Dashboard access and operator actions over HTTP, with a synthetic GitHub provider.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { DashboardAuth } from '../../src/dashboard/auth.ts';
import { GithubSignIn } from '../../src/dashboard/github.ts';
import { BrowserctlServer } from '../../src/server/server.ts';
import { fakeGithub, finishGithubSignIn, GITHUB_SECRET, OWNER_ID, signIn, startGithubSignIn } from '../support/github.ts';
import { runDirectory, testConfig } from '../support/server.ts';

const ORIGIN = 'http://browserctl.example:8443';

describe('dashboard access', () => {
  let run: Awaited<ReturnType<typeof runDirectory>>;
  let server: BrowserctlServer;
  let base: string;
  const github = fakeGithub();

  before(async () => {
    run = await runDirectory();
    server = new BrowserctlServer(testConfig(run.path, { publicBaseUrl: ORIGIN }), github.request);
    await server.start();
    base = `http://127.0.0.1:${server.port}`;
    await server.tokens.create('operator');
  });

  after(async () => {
    await server.stop();
    await run.remove();
  });

  const post = (path: string, cookie: string | undefined, origin: string | undefined, body: unknown = {}) =>
    fetch(`${base}/dashboard/api${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie && { cookie }), ...(origin && { origin }) },
      body: JSON.stringify(body),
    });

  it('opens the dashboard at the service root, with GitHub sign-in', async () => {
    const root = await fetch(base, { redirect: 'manual' });
    assert.equal(root.status, 303);
    assert.equal(root.headers.get('location'), '/dashboard/');
    const page = await fetch(`${base}/dashboard/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /href="\/dashboard\/login">Continue with GitHub/);
  });

  it('exchanges a browser-bound PKCE challenge, looks up the owner, and stores only a session hash', async () => {
    const count = github.requests.length;
    const { start, authorization, callback, cookie } = await startGithubSignIn(base);
    assert.match(start.headers.getSetCookie()[0]!, /HttpOnly; SameSite=Lax; Path=\/dashboard\/login\/callback; Max-Age=600/);
    assert.equal(authorization.origin, 'https://github.com');
    assert.equal(authorization.pathname, '/login/oauth/authorize');
    assert.deepEqual([callback.origin, callback.pathname], [ORIGIN, '/dashboard/login/callback']);
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authorization.searchParams.has('scope'), false);

    assert.equal((await finishGithubSignIn(base, callback)).status, 400);
    const other = await startGithubSignIn(base);
    assert.equal((await finishGithubSignIn(base, callback, other.cookie)).status, 400);
    assert.equal(github.requests.length, count, 'a mismatched browser cannot initiate an exchange');

    const first = await finishGithubSignIn(base, callback, cookie);
    assert.equal(first.status, 303);
    assert.equal(first.headers.get('location'), '/dashboard/');
    const [session, cleared] = first.headers.getSetCookie();
    assert.match(session!, /^browserctl_dashboard=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Lax; Path=\/dashboard; Max-Age=604800$/);
    assert.match(cleared!, /Max-Age=0$/);
    const authCookie = session!.split(';')[0]!;
    const stored = await readFile(join(server.config.stateDirectory, 'dashboard-sessions.json'), 'utf8');
    assert.ok(!stored.includes(authCookie.split('=')[1]!));
    assert.ok(!stored.includes('synthetic-owner'));
    assert.equal((await finishGithubSignIn(base, callback, cookie)).status, 400, 'the callback works once');

    const [exchange, lookup, revoke] = github.requests.slice(count);
    const form = await exchange!.formData();
    assert.equal(form.get('client_secret'), GITHUB_SECRET);
    assert.equal(form.get('redirect_uri'), `${ORIGIN}/dashboard/login/callback`);
    assert.equal(authorization.searchParams.get('code_challenge'), createHash('sha256').update(String(form.get('code_verifier'))).digest('base64url'));
    assert.equal(lookup!.headers.get('authorization'), 'Bearer synthetic-owner');
    assert.equal(revoke!.method, 'DELETE');
    assert.deepEqual(await revoke!.json(), { access_token: 'synthetic-owner' });

    const state = await fetch(`${base}/dashboard/api/state`, { headers: { cookie: authCookie } });
    assert.equal(state.status, 200);
    assert.equal(((await state.json()) as { client: string }).client, `github:${OWNER_ID}`);
  });

  it('refuses nonowners, declined requests, missing codes, and GitHub failures without issuing a cookie', async () => {
    for (const [code, status] of [['other', 401], ['denied', 401], ['missing', 400], ['malformed', 503], ['unavailable', 503]] as const) {
      const { callback, cookie } = await startGithubSignIn(base);
      if (code === 'denied') callback.searchParams.set('error', 'access_denied');
      if (code === 'missing') callback.searchParams.delete('code');
      else callback.searchParams.set('code', code);
      const start = github.requests.length;
      const response = await finishGithubSignIn(base, callback, cookie);
      assert.equal(response.status, status, code);
      assert.equal(response.headers.has('set-cookie'), false);
      if (code === 'other' || code === 'malformed') assert.equal(github.requests.at(-1)?.method, 'DELETE');
      if (code === 'denied' || code === 'missing') assert.equal(github.requests.length, start);
    }
  });

  it('expires pending GitHub sign-ins at 10 minutes', async () => {
    const flow = new GithubSignIn(server.config.github, ORIGIN, github.request);
    const issued = Date.now();
    const { location, browser } = flow.start(issued);
    const callback = new URL('/dashboard/login/callback', ORIGIN);
    callback.searchParams.set('state', new URL(location).searchParams.get('state')!);
    callback.searchParams.set('code', 'owner');
    await assert.rejects(flow.complete(callback, browser, issued + 600_000), /expired/);
  });

  it('does not load sessions issued through admin links or for another owner', async () => {
    const directory = join(run.path, 'old-sessions');
    const previous = new DashboardAuth(directory, OWNER_ID);
    const cookie = await previous.issue(OWNER_ID);
    const request = { headers: { cookie: `browserctl_dashboard=${cookie}` } } as Parameters<DashboardAuth['authenticate']>[0];
    const sameOwner = new DashboardAuth(directory, OWNER_ID);
    await sameOwner.load();
    assert.ok(sameOwner.authenticate(request));
    const newOwner = new DashboardAuth(directory, OWNER_ID + 1);
    await newOwner.load();
    assert.equal(newOwner.authenticate(request), undefined);
    await writeFile(join(directory, 'dashboard-sessions.json'), JSON.stringify({
      version: 1,
      sessions: [{ sha256: createHash('sha256').update(cookie).digest('hex'), client: 'operator', expiresAt: Date.now() + 60_000 }],
    }));
    await sameOwner.load();
    assert.equal(sameOwner.authenticate(request), undefined);
  });

  it('refuses API requests without a dashboard session', async () => {
    assert.equal((await fetch(`${base}/dashboard/api/state`)).status, 401);
    assert.equal((await fetch(`${base}/dashboard/api/state`, { headers: { cookie: 'browserctl_dashboard=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } })).status, 401);
    assert.equal((await post('/profiles', undefined, ORIGIN, { name: 'x' })).status, 401);
  });

  it('refuses state changes and WebSocket upgrades from a foreign Origin', async () => {
    const cookie = await signIn(base);
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
    const cookie = await signIn(base);
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
    const cookie = await signIn(base);
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

  it('signs out one session independently of another session and of the MCP token', async () => {
    const cookie = await signIn(base);
    const other = await signIn(base);
    await server.tokens.revoke('operator');
    assert.equal((await fetch(`${base}/dashboard/api/state`, { headers: { cookie } })).status, 200);
    assert.equal((await post('/logout', cookie, 'http://evil.example')).status, 403);
    const signedOut = await post('/logout', cookie, ORIGIN);
    assert.equal(signedOut.status, 204);
    assert.match(signedOut.headers.getSetCookie()[0]!, /Max-Age=0$/);
    assert.equal((await fetch(`${base}/dashboard/api/state`, { headers: { cookie } })).status, 401);
    assert.equal((await fetch(`${base}/dashboard/api/state`, { headers: { cookie: other } })).status, 200);
  });

  it('serves the dashboard page and noVNC with a restrictive content policy', async () => {
    const cookie = await signIn(base);
    const page = await fetch(`${base}/dashboard/`, { headers: { cookie } });
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy')!, /default-src 'self'/);
    assert.match(await page.text(), /<title>browserctl<\/title>/);
    assert.equal((await fetch(`${base}/dashboard/novnc/core/rfb.js`)).status, 200);
    assert.equal((await fetch(`${base}/dashboard/novnc/package.json`)).status, 404);
    assert.equal((await fetch(`${base}/dashboard/static/..%2F..%2Fserver%2Fserver.ts`)).status, 404);
    // A path that reads as a URL with a scheme stays a file name under the static directory.
    const outside = join(run.path, 'outside.js');
    await writeFile(outside, 'secret');
    for (const path of [`file:${outside}`, `file:${encodeURIComponent(outside)}`, `..%2F..%2F..%2F..%2F..%2F..%2F..%2F..${encodeURIComponent(outside)}`]) {
      assert.equal((await fetch(`${base}/dashboard/static/${path}`)).status, 404, path);
    }
    assert.equal((await fetch(`${base}/dashboard/novnc/${`file:${outside}`}`)).status, 404);
  });

  it('lists recordings and serves a finished one in byte ranges to dashboard sessions only', async () => {
    const session = 's-dashboardrec';
    await server.recordings.begin({ session, client: 'agent-a', purpose: 'check', source: 'profile', profile: 'mail', startedAt: '2026-11-01T10:00:00.000Z' });
    const video = Buffer.from(Array.from({ length: 1000 }, (_, index) => index % 256));
    await writeFile(server.recordings.partPath(session), video);
    const cookie = await signIn(base);
    const url = `${base}/dashboard/api/recordings/${session}/video`;
    assert.equal((await fetch(url, { headers: { cookie } })).status, 404, 'an active recording is not served');

    await server.recordings.finish(session, new Date('2026-11-01T10:05:00.000Z'));
    const state = (await (await fetch(`${base}/dashboard/api/state`, { headers: { cookie } })).json()) as any;
    assert.deepEqual(state.recordings, [{
      session, client: 'agent-a', purpose: 'check', source: 'profile', profile: 'mail',
      startedAt: '2026-11-01T10:00:00.000Z', endedAt: '2026-11-01T10:05:00.000Z', bytes: 1000, active: false,
    }]);
    assert.equal((await fetch(url)).status, 401);
    const whole = await fetch(url, { headers: { cookie } });
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get('content-type'), 'video/mp4');
    assert.equal(whole.headers.get('accept-ranges'), 'bytes');
    assert.deepEqual(Buffer.from(await whole.arrayBuffer()), video);
    const part = await fetch(url, { headers: { cookie, range: 'bytes=100-199' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 100-199/1000');
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), video.subarray(100, 200));
    const tail = await fetch(url, { headers: { cookie, range: 'bytes=-10' } });
    assert.deepEqual(Buffer.from(await tail.arrayBuffer()), video.subarray(990));
    for (const range of ['bytes=1000-', 'bytes=-', 'items=0-1']) {
      const refused = await fetch(url, { headers: { cookie, range } });
      assert.equal(refused.status, 416, range);
      assert.equal(refused.headers.get('content-range'), 'bytes */1000');
    }
    assert.equal((await fetch(`${base}/dashboard/api/recordings/s-unknownnnnnn/video`, { headers: { cookie } })).status, 404);
  });
});
