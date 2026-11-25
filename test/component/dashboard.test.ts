// Dashboard access and operator actions over HTTP, with a synthetic GitHub provider.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { DashboardAuth } from '../../src/dashboard/auth.ts';
import { GithubSignIn } from '../../src/dashboard/github.ts';
import { BrowserctlServer } from '../../src/server/server.ts';
import { fakeGithub, finishGithubSignIn, GITHUB_SECRET, OWNER_ID, signIn, startGithubSignIn } from '../support/github.ts';
import { eventually } from '../support/processes.ts';
import { DEVELOPMENT_PASSWORD, runDirectory, testConfig } from '../support/server.ts';
import { assertCataloged, memoryTelemetry } from '../support/telemetry.ts';

const ORIGIN = 'http://browserctl.example:8443';
const FAVICON = /<link rel="icon" type="image\/svg\+xml" href="\/dashboard\/static\/assets\/browserctl\.svg">/;

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
    const password = await fetch(`${base}/dashboard/login`, {
      method: 'POST', headers: { origin: ORIGIN }, body: JSON.stringify({ password: DEVELOPMENT_PASSWORD }),
    });
    assert.equal(password.status, 404);
    const root = await fetch(base, { redirect: 'manual' });
    assert.equal(root.status, 303);
    assert.equal(root.headers.get('location'), '/dashboard/');
    const page = await fetch(`${base}/dashboard/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /data-page="github"/);
    assert.match(html, FAVICON);
  });

  it('sets the operator note and inspects and clears both slots through the dashboard', async () => {
    const name = 'dashboard-notes';
    await server.profiles.create(name, 'operator');
    const path = `/profiles/${name}/notes`;
    const cookie = await signIn(base);
    try {
      assert.equal((await post(path, undefined, ORIGIN, { text: 'note' })).status, 401);
      assert.equal((await post(path, cookie, 'https://untrusted.example', { text: 'note' })).status, 403);
      assert.equal((await post(path, cookie, ORIGIN, { text: '  ' })).status, 400);
      assert.equal((await post(path, cookie, ORIGIN, { text: 'note', client: 'spoofed' })).status, 400);
      assert.equal((await post(path, cookie, ORIGIN, { text: 'note', slot: 'agent' })).status, 400);
      assert.equal((await post(path, cookie, ORIGIN, { text: 'first' })).status, 200);
      const saved = await post(path, cookie, ORIGIN, { text: '<b>Work account</b>' });
      assert.equal(saved.status, 200);
      const { note } = await saved.json() as { note: { id: string; client: string; text: string; updatedAt: string } };
      assert.equal(note.client, `github:${OWNER_ID}`);
      assert.equal(note.text, '<b>Work account</b>');
      assert.ok(Number.isFinite(Date.parse(note.updatedAt)));
      const agent = await server.profiles.setNote(name, 'agent', 'Agent context', 'agent-a');
      const state = await fetch(`${base}/dashboard/api/state`, { headers: { cookie } });
      const { profiles } = await state.json() as { profiles: Array<{ name: string; notes: unknown }> };
      assert.deepEqual(profiles.find((profile) => profile.name === name)?.notes, { operator: note, agent });
      for (const id of [note.id, agent.id]) {
        const remove = `${path}/${id}/delete`;
        assert.equal((await post(remove, undefined, ORIGIN)).status, 401);
        assert.equal((await post(remove, cookie, ORIGIN)).status, 200);
        assert.equal((await post(remove, cookie, ORIGIN)).status, 404);
      }
      assert.equal((await server.profiles.get(name)).notes, undefined);
      assert.ok(!(JSON.stringify(await server.audit.read()).includes('Work account')));
    } finally {
      await server.profiles.delete(name);
    }
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
    assert.equal(server.config.dashboard.type, 'github');
    const flow = new GithubSignIn(server.config.dashboard, ORIGIN, github.request);
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

  it('manages profiles: pins, current revision, services, rename, and deletion', async () => {
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
    assert.equal((await post('/profiles/mail/rename', cookie, ORIGIN, { name: 'Bad' })).status, 400);
    const renamed = await post('/profiles/mail/rename', cookie, ORIGIN, { name: 'mail-renamed' });
    assert.equal(renamed.status, 200);
    assert.deepEqual(await renamed.json(), { name: 'mail-renamed' });
    assert.equal((await post('/profiles/mail-renamed/delete', cookie, ORIGIN)).status, 200);
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
    const workspacePolicy = page.headers.get('content-security-policy')!;
    const login = await fetch(`${base}/dashboard/`);
    const loginPolicy = login.headers.get('content-security-policy')!;
    await login.text();
    assert.match(loginPolicy, /default-src 'self'/);
    assert.match(loginPolicy, /img-src 'self' blob:;/);
    assert.equal(
      workspacePolicy,
      loginPolicy.replace("img-src 'self' blob:;", "img-src 'self' blob: data:; media-src 'self' blob:;"),
    );
    const html = await page.text();
    assert.match(html, /<title>browserctl<\/title>/);
    assert.match(html, FAVICON);
    const assets = `${base}/dashboard/static/assets`;
    for (const [name, type] of [
      ['app.js', 'text/javascript'],
      ['main.css', 'text/css'],
      ['browserctl.svg', 'image/svg+xml'],
      ['poppins-latin-400-normal.woff2', 'font/woff2'],
    ] as const) {
      const response = await fetch(`${assets}/${name}`);
      assert.equal(response.status, 200, name);
      assert.ok(response.headers.get('content-type')?.startsWith(type), name);
      await response.arrayBuffer();
    }
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

describe('development dashboard password', () => {
  it('protects the dashboard with a same-origin password and bounds failed attempts', async () => {
    const run = await runDirectory();
    const passwordFile = join(run.path, 'password');
    const makeServer = () => new BrowserctlServer(testConfig(run.path, {
      profile: 'development', publicBaseUrl: ORIGIN, dashboard: { type: 'password', passwordFile },
    }));
    let server = makeServer();
    try {
      await writeFile(passwordFile, DEVELOPMENT_PASSWORD, { mode: 0o600 });
      await server.start();
      const base = `http://127.0.0.1:${server.port}`;
      const route = `${base}/dashboard/login`;
      const login = (password: string, origin = ORIGIN) => fetch(route, {
        method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password }),
      });
      const page = await fetch(base);
      const html = await page.text();
      assert.match(html, /data-page="password"/);
      assert.match(html, FAVICON);
      assert.equal((await fetch(route)).status, 404);
      assert.equal((await fetch(`${route}/callback?code=owner&state=unused`)).status, 404);
      assert.equal((await login(DEVELOPMENT_PASSWORD, 'https://elsewhere.example')).status, 403);
      assert.equal((await login('wrong')).status, 401);
      const signedIn = await login(DEVELOPMENT_PASSWORD);
      assert.equal(signedIn.status, 204);
      const cookie = signedIn.headers.getSetCookie()[0]!.split(';')[0]!;
      const state = await fetch(`${base}/dashboard/api/state`, { headers: { cookie } });
      assert.equal(state.status, 200);
      assert.equal(((await state.json()) as { client: string }).client, 'dashboard:development');
      for (let index = 0; index < 10; index += 1) assert.equal((await login('wrong')).status, 401);
      assert.equal((await login(DEVELOPMENT_PASSWORD)).status, 429);

      await server.stop();
      server = makeServer();
      await server.start();
      const restarted = await fetch(`http://127.0.0.1:${server.port}/dashboard/api/state`, { headers: { cookie } });
      assert.equal(restarted.status, 401);
    } finally {
      await server.stop();
      await run.remove();
    }
  });
});

describe('dashboard sign-in Connect lifecycle', () => {
  it('resumes ready or starting sign-ins and waits for saving or closing ones without conflict', async () => {
    const run = await runDirectory();
    const { AuditLog } = await import('../../src/audit.ts');
    const { Dashboard } = await import('../../src/dashboard/dashboard.ts');
    const { PasswordSignIn } = await import('../../src/dashboard/password.ts');
    const { BrowserctlError } = await import('../../src/errors.ts');
    const { ProfileStore } = await import('../../src/profiles/store.ts');
    const { RecordingStore } = await import('../../src/recordings/store.ts');
    const { HttpRouter } = await import('../../src/server/http.ts');
    const { RunLog } = await import('../../src/tasks/runs.ts');
    const { TaskStore } = await import('../../src/tasks/store.ts');

    const passwordFile = join(run.path, 'password');
    await writeFile(passwordFile, DEVELOPMENT_PASSWORD, { mode: 0o600 });
    const profiles = new ProfileStore(join(run.path, 'profiles'));
    await profiles.create('acct', 'operator');
    const auth = new DashboardAuth(run.path);
    const cookie = `browserctl_dashboard=${await auth.issue()}`;

    type FakeSession = {
      id: string;
      client: string;
      purpose: 'sign_in';
      source: { kind: 'profile'; profile: string };
      createdAt: number;
      lastActivity: number;
      state: 'starting' | 'ready' | 'saving' | 'closing' | 'closed';
      revision: string;
      closed: Promise<void>;
      resolveClosed: () => void;
    };
    const active = new Map<string, FakeSession>();
    const openListeners: Array<(session: FakeSession) => void> = [];
    let nextId = 0;
    let openCalls = 0;

    const makeSession = (profile: string, state: FakeSession['state'] = 'ready'): FakeSession => {
      let resolveClosed!: () => void;
      const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
      const id = `s-signin${String(++nextId).padStart(6, '0')}`;
      return {
        id,
        client: 'dashboard:development',
        purpose: 'sign_in',
        source: { kind: 'profile', profile },
        createdAt: Date.now(),
        lastActivity: Date.now(),
        state,
        revision: '1',
        closed,
        resolveClosed,
      };
    };

    const closeSession = (session: FakeSession) => {
      active.delete(session.id);
      session.state = 'closed';
      session.resolveClosed();
    };

    const sessions = {
      list: () => [...active.values()],
      get: (id: string) => active.get(id),
      usesProfile: (name: string) => [...active.values()].some((s) => s.source.profile === name),
      renameProfile: (name: string, nextName: string) => {
        for (const session of active.values()) {
          if (session.source.profile === name) session.source.profile = nextName;
        }
      },
      closeProfile: async (name: string) => {
        for (const session of [...active.values()]) {
          if (session.source.profile === name) closeSession(session);
        }
      },
      onOpen: (listener: (session: FakeSession) => void) => { openListeners.push(listener); },
      offOpen: (listener: (session: FakeSession) => void) => {
        const index = openListeners.indexOf(listener);
        if (index >= 0) openListeners.splice(index, 1);
      },
      onClose: () => undefined,
      open: async (_client: string, source: { kind: 'profile'; profile: string }) => {
        openCalls += 1;
        if ([...active.values()].some((s) => s.source.profile === source.profile)) {
          throw new BrowserctlError('conflict', `profile ${source.profile} already has a sign-in session`);
        }
        const created = makeSession(source.profile, 'ready');
        active.set(created.id, created);
        for (const listener of [...openListeners]) listener(created);
        return created;
      },
    };

    const router = new HttpRouter();
    const dashboard = new Dashboard({
      publicBaseUrl: ORIGIN,
      auth,
      signIn: { password: new PasswordSignIn(passwordFile) },
      sessions: sessions as any,
      profiles,
      tasks: new TaskStore(join(run.path, 'tasks')),
      runs: new RunLog(join(run.path, 'runs.jsonl')),
      checks: { check: async () => undefined } as any,
      providers: { states: () => [], managedRuntimeState: () => null } as any,
      screencasts: { get: () => undefined } as any,
      recordings: new RecordingStore(join(run.path, 'recordings'), 1024 * 1024),
      audit: new AuditLog(run.path),
    });
    dashboard.mount(router);
    const port = await router.listen('127.0.0.1', 0);
    const connect = async () => {
      const res = await fetch(`http://127.0.0.1:${port}/dashboard/api/profiles/acct/sign-in`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, origin: ORIGIN },
        body: '{}',
      });
      return { status: res.status, body: await res.json() as { session?: string; error?: string } };
    };

    try {
      // 1. Opens a fresh sign-in session and reuses it while ready.
      const first = await connect();
      assert.equal(first.status, 201);
      const resumed = await connect();
      assert.equal(resumed.status, 200);
      assert.equal(resumed.body.session, first.body.session);
      assert.equal(openCalls, 1);

      // 2. While saving, concurrent Connect clicks wait for close and coalesce onto one fresh session.
      const firstSession = active.get(first.body.session!)!;
      firstSession.state = 'saving';
      const pendingA = connect();
      const pendingB = connect();
      await Promise.resolve();
      closeSession(firstSession);
      const [nextA, nextB] = await Promise.all([pendingA, pendingB]);
      assert.equal(nextA.body.session, nextB.body.session);
      assert.notEqual(nextA.body.session, firstSession.id);
      assert.equal(openCalls, 2);

      // 3. While closing, Connect waits for close and opens a fresh session.
      const secondSession = active.get(nextA.body.session!)!;
      secondSession.state = 'closing';
      const afterClose = connect();
      await Promise.resolve();
      closeSession(secondSession);
      const third = await afterClose;
      assert.equal(third.status, 201);
      assert.notEqual(third.body.session, secondSession.id);
      assert.equal(openCalls, 3);
      closeSession(active.get(third.body.session!)!);

      // 4. While starting outside the dashboard map, Connect waits for ready and reuses it.
      const external = makeSession('acct', 'starting');
      active.set(external.id, external);
      const waitingStart = connect();
      await Promise.resolve();
      external.state = 'ready';
      for (const listener of [...openListeners]) listener(external);
      const joined = await waitingStart;
      assert.equal(joined.status, 200);
      assert.equal(joined.body.session, external.id);
      assert.equal(openCalls, 3);

      // 5. Renaming an active profile updates the live session, and deleting closes the live session.
      const renameRes = await fetch(`http://127.0.0.1:${port}/dashboard/api/profiles/acct/rename`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, origin: ORIGIN },
        body: JSON.stringify({ name: 'acct-renamed' }),
      });
      assert.equal(renameRes.status, 200);
      assert.equal(external.source.profile, 'acct-renamed');
      const deleteRes = await fetch(`http://127.0.0.1:${port}/dashboard/api/profiles/acct-renamed/delete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, origin: ORIGIN },
        body: '{}',
      });
      assert.equal(deleteRes.status, 200);
      assert.equal(active.size, 0, 'deleting an in-use profile closes its active session');
      assert.deepEqual(await profiles.list(), []);
    } finally {
      await dashboard.stop();
      await router.close();
      await run.remove();
    }
  });

  it('lists the built-in managed provider with capacity ahead of external providers in state', async () => {
    const run = await runDirectory();
    const passwordFile = join(run.path, 'password');
    await writeFile(passwordFile, DEVELOPMENT_PASSWORD, { mode: 0o600 });
    const server = new BrowserctlServer(testConfig(run.path, {
      profile: 'development',
      publicBaseUrl: ORIGIN,
      sessionLimit: 6,
      dashboard: { type: 'password', passwordFile },
    }));
    await server.start();
    try {
      const login = await fetch(`http://127.0.0.1:${server.port}/dashboard/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ password: DEVELOPMENT_PASSWORD }),
      });
      assert.equal(login.status, 204);
      const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
      const res = await fetch(`http://127.0.0.1:${server.port}/dashboard/api/state`, { headers: { cookie } });
      assert.equal(res.status, 200);
      const state = await res.json() as {
        providers: Array<{
          name: string;
          builtIn: boolean;
          reachable: boolean;
          managedRuntime: string | null;
          checkedAt: string | null;
          sources: string[];
          capacity?: { total: number; used: number; available: number; queued?: number };
        }>;
      };
      assert.equal(state.providers.length, 1);
      assert.deepEqual(state.providers[0], {
        name: 'managed',
        description: 'Browserctl-managed browsers and saved profiles.',
        builtIn: true,
        reachable: true,
        managedRuntime: null,
        error: null,
        checkedAt: null,
        sources: ['ephemeral', 'profile'],
        capacity: { total: 6, used: 0, available: 6, queued: 0 },
        slots: [],
      });
    } finally {
      await server.stop();
      await run.remove();
    }
  });

  it('logs window stream closure reasons and traces session teardown', async () => {
    const run = await runDirectory();
    const telemetry = memoryTelemetry();
    const { AuditLog } = await import('../../src/audit.ts');
    const { Dashboard } = await import('../../src/dashboard/dashboard.ts');
    const { PasswordSignIn } = await import('../../src/dashboard/password.ts');
    const { ProfileStore } = await import('../../src/profiles/store.ts');
    const { RecordingStore } = await import('../../src/recordings/store.ts');
    const { HttpRouter } = await import('../../src/server/http.ts');
    const { RunLog } = await import('../../src/tasks/runs.ts');
    const { TaskStore } = await import('../../src/tasks/store.ts');

    const passwordFile = join(run.path, 'password');
    await writeFile(passwordFile, DEVELOPMENT_PASSWORD, { mode: 0o600 });
    const auth = new DashboardAuth(run.path);
    const closeListeners: Array<(session: any) => void> = [];
    const captures: Array<{ stream: PassThrough; stopped: boolean; error: () => void }> = [];

    const session = {
      id: 's-windowlog001',
      client: 'agent-a',
      purpose: 'agent',
      source: { kind: 'ephemeral' },
      createdAt: Date.now(),
      lastActivity: Date.now(),
      state: 'ready' as 'ready' | 'closing' | 'closed',
      closers: [] as Array<(reason: string) => Promise<void>>,
      browser: {
        captureWindow() {
          const stream = new PassThrough();
          const listeners: Array<() => void> = [];
          const entry = {
            stream,
            stopped: false,
            error: () => listeners.splice(0).forEach((listener) => listener()),
          };
          captures.push(entry);
          stream.write(Buffer.from('ftyp'));
          return {
            stream,
            stop: () => {
              entry.stopped = true;
              stream.end();
            },
            onError: (listener: () => void) => listeners.push(listener),
          };
        },
      },
    };

    const sessions = {
      list: () => (session.state === 'closed' ? [] : [session]),
      get: (id: string) => (id === session.id && session.state !== 'closed' ? session : undefined),
      onClose: (listener: (closed: any) => void) => { closeListeners.push(listener); },
    };

    const router = new HttpRouter();
    const dashboard = new Dashboard({
      publicBaseUrl: ORIGIN,
      auth,
      signIn: { password: new PasswordSignIn(passwordFile) },
      sessions: sessions as any,
      profiles: new ProfileStore(join(run.path, 'profiles')),
      tasks: new TaskStore(join(run.path, 'tasks')),
      runs: new RunLog(join(run.path, 'runs.jsonl')),
      checks: { check: async () => undefined } as any,
      providers: { states: () => [], managedRuntimeState: () => null } as any,
      screencasts: { get: () => undefined } as any,
      recordings: new RecordingStore(join(run.path, 'recordings'), 1024 * 1024),
      audit: new AuditLog(run.path),
    });
    dashboard.mount(router);
    const port = await router.listen('127.0.0.1', 0);
    const openStream = async (cookie: string, signal?: AbortSignal) => {
      const response = await fetch(`http://127.0.0.1:${port}/dashboard/api/sessions/${session.id}/window`, {
        headers: { cookie },
        signal,
      });
      assert.equal(response.status, 200);
      const reader = response.body!.getReader();
      const first = await reader.read();
      assert.equal(first.done, false);
      return reader;
    };

    try {
      const cookieA = `browserctl_dashboard=${await auth.issue()}`;
      const abort = new AbortController();
      const readerA = await openStream(cookieA, abort.signal);
      assert.equal(session.closers.length, 1);
      abort.abort();
      await readerA.read().catch(() => undefined);
      await eventually(async () => (await telemetry.collect()).logs.some((log) =>
        log.body === 'browserctl.dashboard.window.closed' && log.attributes['browserctl.window.close_reason'] === 'client_closed'));
      assert.equal(session.closers.length, 0, 'client disconnect removes its session closer');

      const cookieB = `browserctl_dashboard=${await auth.issue()}`;
      const readerB = await openStream(cookieB);
      const logout = await fetch(`http://127.0.0.1:${port}/dashboard/api/logout`, {
        method: 'POST',
        headers: { cookie: cookieB, origin: ORIGIN },
      });
      assert.equal(logout.status, 204);
      await readerB.read().catch(() => undefined);
      await eventually(async () => (await telemetry.collect()).logs.some((log) =>
        log.body === 'browserctl.dashboard.window.closed' && log.attributes['browserctl.window.close_reason'] === 'sign_out'));

      const readerC = await openStream(cookieA);
      captures.at(-1)!.error();
      await readerC.read().catch(() => undefined);
      await eventually(async () => (await telemetry.collect()).logs.some((log) =>
        log.body === 'browserctl.dashboard.window.closed' && log.attributes['browserctl.window.close_reason'] === 'failed'));

      const readerEof = await openStream(cookieA);
      captures.at(-1)!.stream.end();
      await readerEof.read().catch(() => undefined);
      await eventually(async () => (await telemetry.collect()).logs.filter((log) =>
        log.body === 'browserctl.dashboard.window.closed' && log.attributes['browserctl.window.close_reason'] === 'failed').length === 2);

      // Session teardown closes the window stream cleanly during closers, before browser.stop() / onClose finishes.
      const readerD = await openStream(cookieA);
      const activeCapture = captures.at(-1)!;
      session.state = 'closing';
      for (const closer of [...session.closers].reverse()) await closer('closed');
      assert.equal(activeCapture.stopped, true, 'session closer stops the encoder before browser shutdown');
      const eof = await readerD.read();
      assert.equal(eof.done, true, 'session close ends the HTTP stream cleanly');
      await eventually(async () => (await telemetry.collect()).logs.some((log) =>
        log.body === 'browserctl.dashboard.window.closed' && log.attributes['browserctl.window.close_reason'] === 'session_closed'));
      assert.equal(session.closers.length, 0);

      const signals = await telemetry.collect();
      assertCataloged(signals);
      const closedReasons = signals.logs
        .filter((log) => log.body === 'browserctl.dashboard.window.closed')
        .map((log) => log.attributes);
      assert.deepEqual(closedReasons, [
        { 'browserctl.session.id': session.id, 'browserctl.window.close_reason': 'client_closed' },
        { 'browserctl.session.id': session.id, 'browserctl.window.close_reason': 'sign_out' },
        { 'browserctl.session.id': session.id, 'browserctl.window.close_reason': 'failed' },
        { 'browserctl.session.id': session.id, 'browserctl.window.close_reason': 'failed' },
        { 'browserctl.session.id': session.id, 'browserctl.window.close_reason': 'session_closed' },
      ]);
      assert.equal(signals.logs.filter((log) => log.body === 'browserctl.dashboard.window.failed').length, 2);
    } finally {
      await dashboard.stop();
      await router.close();
      await telemetry.restore();
      await run.remove();
    }
  });
});
