import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { it } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { isDisplayBrowser, isRecordingBrowser, isWindowBrowser } from '../../src/browser/display.ts';
import { COOKIE } from '../../src/dashboard/auth.ts';
import { bridgeRemoteVnc } from '../../src/dashboard/vnc.ts';
import { packRevision, unpackRevision } from '../../src/profiles/archive.ts';
import { Recorder } from '../../src/recordings/recorder.ts';
import { BrowserctlServer } from '../../src/server/server.ts';
import type { Session } from '../../src/sessions/manager.ts';
import { OWNER_ID } from '../support/github.ts';
import { eventually } from '../support/processes.ts';
import { runDirectory, testConfig } from '../support/server.ts';

function localChromeMajor(): number {
  try {
    const out = execFileSync('chrome', ['--version'], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] });
    const match = /\b(\d+)\.\d+\.\d+\.\d+\b/.exec(out);
    if (match) return Number(match[1]);
  } catch {
    // Chrome is absent in minimal test environments; server leaves chromeMajor undefined so any integer matches.
  }
  return 158;
}

it('manages profiles, noVNC sign-in, live window video, and recordings on a managed-runtime provider', { timeout: 20_000 }, async () => {
  const run = await runDirectory();
  const token = Buffer.alloc(32, 7).toString('base64url');
  const tokenFile = join(run.path, 'runtime-token');
  await writeFile(tokenFile, token, { mode: 0o600 });

  // Prepare a synthetic saved profile archive returned when a sign-in session saves.
  const savedDir = join(run.path, 'saved-profile');
  await mkdir(savedDir, { recursive: true });
  await writeFile(join(savedDir, 'Cookies'), 'signed-in-cookie-data');
  await writeFile(join(savedDir, 'SingletonLock'), 'volatile-should-be-stripped');
  const savedArchive = (await packRevision(savedDir))!;

  const cache = new Map<string, Buffer>();
  const leases = new Map<string, { slot: number; mode: string; source: { type: string; sha256?: string } }>();
  let nextLease = 0;
  const vncReceived: Buffer[] = [];
  const cdpSockets = new WebSocketServer({ noServer: true });
  const vncSockets = new WebSocketServer({ noServer: true });

  cdpSockets.on('connection', (ws) => {
    ws.on('message', (raw, isBinary) => ws.send(raw, { binary: isBinary }));
  });
  vncSockets.on('connection', (ws) => {
    ws.send(Buffer.from('RFB 003.008\n'), { binary: true });
    ws.on('message', (raw) => {
      vncReceived.push(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer));
      ws.send(Buffer.from([0xaa, 0xbb]), { binary: true });
    });
  });

  const provider = createServer(async (request, response) => {
    const path = request.url ?? '';
    const send = (status: number, body: unknown) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (request.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'unauthorized' });

    if (request.method === 'GET' && path === '/status') {
      return send(200, {
        slots: [],
        capabilities: {
          cdp: 'lease',
          sources: ['ephemeral', 'profile'],
          profiles: [],
          managedRuntime: {
            version: 1,
            platform: `${process.platform}-${process.arch}`,
            chromeMajor: localChromeMajor(),
            views: ['screencast', 'window'],
            signIn: 'vnc',
            recording: 'mp4',
          },
        },
      });
    }

    const revMatch = /^\/revisions\/([0-9a-f]{64})$/.exec(path);
    if (revMatch) {
      const sha = revMatch[1]!;
      if (request.method === 'HEAD') {
        response.writeHead(cache.has(sha) ? 200 : 404).end();
        return;
      }
      if (request.method === 'PUT') {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        cache.set(sha, Buffer.concat(chunks));
        return send(200, { sha256: sha });
      }
    }

    if (request.method === 'POST' && path === '/leases') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const id = `mlease-${++nextLease}`;
      leases.set(id, { slot: nextLease, mode: body.mode, source: body.source });
      return send(201, { lease: id, slot: nextLease, cdp: 'lease', source: body.source });
    }

    const leaseMatch = /^\/leases\/([^/]+)(\/ensure|\/heartbeat|\/cdp\/json\/version|\/window|\/recording|\/save)?$/.exec(path);
    const id = leaseMatch?.[1];
    const sub = leaseMatch?.[2] ?? '';
    const lease = id ? leases.get(id) : undefined;
    if (!leaseMatch || !lease) return send(404, { error: 'unknown lease' });

    if (request.method === 'POST' && sub === '/ensure') {
      return send(200, lease.mode === 'sign_in' ? { vnc: 'lease' } : { cdp: 'lease' });
    }
    if (request.method === 'POST' && sub === '/heartbeat') return send(200, { slot: lease.slot });
    if (request.method === 'DELETE' && sub === '') {
      leases.delete(id!);
      return send(200, { slot: lease.slot });
    }
    if (request.method === 'GET' && sub === '/cdp/json/version') {
      return send(200, { Browser: 'Chrome/158.0.0.0' });
    }
    if (request.method === 'GET' && sub === '/window') {
      response.writeHead(200, { 'content-type': 'video/mp4' });
      response.write(Buffer.from('fake-window-mp4-chunk'));
      return;
    }
    if (request.method === 'GET' && sub === '/recording') {
      response.writeHead(200, { 'content-type': 'video/mp4' });
      response.write(Buffer.from('fake-recording-mp4-data'));
      response.end();
      return;
    }
    if (request.method === 'POST' && sub === '/save') {
      leases.delete(id!);
      response.writeHead(200, {
        'content-type': 'application/gzip',
        'x-revision-sha256': savedArchive.sha256,
      }).end(savedArchive.archive);
      return;
    }
    send(404, { error: 'not found' });
  });

  provider.on('upgrade', (request, socket, head) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    const cdp = /^\/leases\/([^/]+)\/cdp\/devtools\/browser$/.exec(request.url ?? '');
    if (cdp && leases.has(cdp[1]!)) {
      cdpSockets.handleUpgrade(request, socket, head, (ws) => cdpSockets.emit('connection', ws));
      return;
    }
    const vnc = /^\/leases\/([^/]+)\/vnc$/.exec(request.url ?? '');
    if (vnc && leases.get(vnc[1]!)?.mode === 'sign_in') {
      vncSockets.handleUpgrade(request, socket, head, (ws) => vncSockets.emit('connection', ws));
      return;
    }
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
  });

  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const providerPort = (provider.address() as AddressInfo).port;

  let server: BrowserctlServer | undefined;
  let vncFront: WebSocketServer | undefined;
  try {
    server = new BrowserctlServer(testConfig(run.path, {
      providers: [{
        name: 'pool',
        leaseUrl: `http://127.0.0.1:${providerPort}`,
        tokenFile,
        managedRuntime: true,
        description: 'Compatible remote Chrome pool.',
      }],
    }));
    await server.start();
    const base = `http://127.0.0.1:${server.port}`;
    await server.providers.poll();

    const cookie = await server.dashboardAuth.issue(OWNER_ID);
    const headers = {
      cookie: `${COOKIE}=${cookie}`,
      origin: server.config.publicBaseUrl,
      'content-type': 'application/json',
    };
    const api = async (path: string, body?: unknown) => {
      const res = await fetch(`${base}/dashboard/api${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: await res.json() as any };
    };

    // 1. State advertises managedRuntime: 'ready'.
    const initial = await api('/state');
    assert.equal(initial.status, 200);
    assert.equal(initial.body.providers[0].managedRuntime, 'ready');

    // 2. Create a profile assigned to the managed-runtime provider, and refuse unknown providers.
    const badProvider = await api('/profiles', { name: 'bad', provider: 'unknown' });
    assert.equal(badProvider.status, 400);
    const created = await api('/profiles', { name: 'cloud-work', provider: 'pool' });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body, { name: 'cloud-work', provider: 'pool' });

    // Notes work identically on host-managed profiles assigned to a remote runtime.
    const note = await api('/profiles/cloud-work/notes', { text: 'Team portal login' });
    assert.equal(note.status, 200);
    assert.equal(note.body.note.text, 'Team portal login');

    // 3. Open a sign-in session via Providers.opener, bridge remote VNC, and save archive into ProfileStore.
    const signInSession = {
      id: 's-signin123456',
      client: `github:${OWNER_ID}`,
      purpose: 'sign_in',
      source: { kind: 'profile', profile: 'cloud-work', runtime: 'pool' },
      revision: undefined,
    } as unknown as Session;
    const signInOpened = await server.providers.opener(signInSession);
    assert.equal(signInOpened.target, undefined);
    assert.ok(isDisplayBrowser(signInOpened.browser) && signInOpened.browser.vncRemote);
    const remoteVnc = signInOpened.browser.vncRemote;

    let inputCount = 0;
    vncFront = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(vncFront, 'listening');
    vncFront.on('connection', (ws) => {
      const { url, headers: remoteHeaders } = remoteVnc();
      bridgeRemoteVnc(ws, url, remoteHeaders, () => { inputCount++; });
    });
    const vncWs = new WebSocket(`ws://127.0.0.1:${(vncFront.address() as AddressInfo).port}`);
    const greeting = await new Promise<Buffer>((resolve, reject) => {
      vncWs.once('message', (data) => resolve(Buffer.from(data as Buffer)));
      vncWs.once('error', reject);
    });
    assert.equal(greeting.toString('utf8'), 'RFB 003.008\n');
    const handshakeAndKey = Buffer.concat([Buffer.from('RFB 003.008\n\x01\x01'), Buffer.from([4, 1, 0, 0, 0, 0, 0, 65])]);
    const echo = once(vncWs, 'message');
    vncWs.send(handshakeAndKey);
    const [reply] = await echo;
    assert.deepEqual(Buffer.from(reply as Buffer), Buffer.from([0xaa, 0xbb]));
    assert.equal(inputCount, 1);
    assert.ok(vncReceived.length > 0);
    vncWs.close();

    // Save archive from remote sign-in and unpack into ProfileStore as revision 2.
    const saved = await signInOpened.browser.saveArchive!(5_000);
    const unpacked = join(run.path, 'unpacked');
    await mkdir(unpacked, { mode: 0o700 });
    await unpackRevision(saved.archive, saved.sha256, unpacked);
    const rev = await server.profiles.addRevision('cloud-work', unpacked, `github:${OWNER_ID}`);
    assert.equal(rev.id, '2');
    assert.equal(await readFile(join(server.profiles.revisionPath('cloud-work', '2'), 'Cookies'), 'utf8'), 'signed-in-cookie-data');
    assert.equal(leases.size, 0, 'remote save released the sign-in lease');

    // 4. Open an agent session on the managed-runtime provider: uploads archive once, exposes window + recording streams.
    let resolveClosed!: () => void;
    const agentSession = {
      id: 's-agent1234567',
      client: 'agent-a',
      purpose: 'agent',
      source: { kind: 'profile', profile: 'cloud-work', runtime: 'pool' },
      createdAt: Date.now(),
      state: 'ready',
      revision: undefined,
      browser: undefined,
      closed: new Promise<void>((resolve) => { resolveClosed = resolve; }),
    } as unknown as Session;
    const opened = await server.providers.opener(agentSession);
    agentSession.browser = opened.browser;
    assert.equal(agentSession.revision, '2');
    assert.equal(cache.size, 1, 'revision archive was uploaded to provider cache');
    assert.ok(opened.target);
    assert.equal((await opened.target!.version()).Browser, 'Chrome/158.0.0.0');
    assert.ok(isWindowBrowser(opened.browser));
    assert.ok(isRecordingBrowser(opened.browser));

    // Window stream delivers MP4 bytes and stops cleanly.
    const winCapture = opened.browser.captureWindow();
    const [winChunk] = await once(winCapture.stream, 'data');
    assert.equal(Buffer.from(winChunk as Buffer).toString('utf8'), 'fake-window-mp4-chunk');
    winCapture.stop();

    // Recorder persists the remote MP4 stream directly to RecordingStore.
    const listeners: Array<(session: Session) => void> = [];
    const recorder = new Recorder({
      sessions: { onOpen: (listener) => listeners.push(listener) },
      screencasts: { forSession: () => undefined },
      store: server.recordings,
      path: server.config.path,
    });
    await recorder.start();
    for (const listener of listeners) listener(agentSession);
    await eventually(() => server!.recordings.list().some((r) => r.session === agentSession.id && !r.active));
    const recording = server.recordings.list().find((r) => r.session === agentSession.id)!;
    assert.equal(recording.source, 'profile');
    assert.equal(recording.profile, 'cloud-work');
    assert.equal(recording.provider, 'pool');
    assert.equal(await readFile(server.recordings.videoPath(agentSession.id)!, 'utf8'), 'fake-recording-mp4-data');

    resolveClosed();
    await opened.browser.stop();
    await recorder.stop();
    assert.equal(leases.size, 0);
  } finally {
    vncFront?.close();
    await server?.stop();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    cdpSockets.close();
    vncSockets.close();
    await run.remove();
  }
});

it('suppresses lease heartbeats while a remote sign-in saveArchive is in flight', { timeout: 20_000 }, async () => {
  const run = await runDirectory();
  const token = Buffer.alloc(32, 9).toString('base64url');
  const tokenFile = join(run.path, 'runtime-token');
  await writeFile(tokenFile, token, { mode: 0o600 });

  const savedDir = join(run.path, 'saved-profile');
  await mkdir(savedDir, { recursive: true });
  await writeFile(join(savedDir, 'Cookies'), 'saved-without-lease-lost');
  const savedArchive = (await packRevision(savedDir))!;

  const leases = new Map<string, { slot: number; mode: string; source: { type: string; sha256?: string } }>();
  let nextLease = 0;
  let saveStarted!: () => void;
  const saveEntered = new Promise<void>((resolve) => { saveStarted = resolve; });
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
  let heartbeatsDuringSave = 0;
  let otherHeartbeats = 0;
  let savingLeaseId: string | undefined;
  let inSave = false;

  const provider = createServer(async (request, response) => {
    const path = request.url ?? '';
    const send = (status: number, body: unknown) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (request.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'unauthorized' });

    if (request.method === 'GET' && path === '/status') {
      return send(200, {
        slots: [],
        capabilities: {
          cdp: 'lease',
          sources: ['ephemeral', 'profile'],
          profiles: [],
          managedRuntime: {
            version: 1,
            platform: `${process.platform}-${process.arch}`,
            chromeMajor: localChromeMajor(),
            views: ['screencast', 'window'],
            signIn: 'vnc',
            recording: 'mp4',
          },
        },
      });
    }

    if (request.method === 'POST' && path === '/leases') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const id = `mlease-${++nextLease}`;
      leases.set(id, { slot: nextLease, mode: body.mode, source: body.source });
      return send(201, { lease: id, slot: nextLease, cdp: 'lease', source: body.source });
    }

    const leaseMatch = /^\/leases\/([^/]+)(\/ensure|\/heartbeat|\/save)?$/.exec(path);
    const id = leaseMatch?.[1];
    const sub = leaseMatch?.[2] ?? '';
    const lease = id ? leases.get(id) : undefined;
    if (!leaseMatch || !lease) return send(404, { error: 'unknown lease' });

    if (request.method === 'POST' && sub === '/ensure') return send(200, { vnc: 'lease' });
    if (request.method === 'POST' && sub === '/heartbeat') {
      if (inSave && id === savingLeaseId) {
        heartbeatsDuringSave += 1;
        return send(404, { error: 'unknown lease' });
      }
      if (inSave && id !== savingLeaseId) otherHeartbeats += 1;
      return send(200, { slot: lease.slot });
    }
    if (request.method === 'DELETE' && sub === '') {
      leases.delete(id!);
      return send(200, { slot: lease.slot });
    }
    if (request.method === 'POST' && sub === '/save') {
      inSave = true;
      savingLeaseId = id;
      saveStarted();
      await saveGate;
      inSave = false;
      savingLeaseId = undefined;
      leases.delete(id!);
      response.writeHead(200, {
        'content-type': 'application/gzip',
        'x-revision-sha256': savedArchive.sha256,
      }).end(savedArchive.archive);
      return;
    }
    send(404, { error: 'not found' });
  });

  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const providerPort = (provider.address() as AddressInfo).port;

  let server: BrowserctlServer | undefined;
  try {
    server = new BrowserctlServer(testConfig(run.path, {
      providers: [{
        name: 'pool',
        leaseUrl: `http://127.0.0.1:${providerPort}`,
        tokenFile,
        managedRuntime: true,
      }],
    }));
    await server.profiles.create('save-hb', 'operator', 'pool');
    await server.profiles.create('clock-hb', 'operator', 'pool');

    const leaseLost: string[] = [];
    const { Providers } = await import('../../src/providers/external.ts');
    const providers = new Providers(server.config.providers, {
      heartbeatMs: 40,
      profiles: server.profiles,
      runtime: { platform: `${process.platform}-${process.arch}`, chromeMajor: localChromeMajor() },
      onLeaseLost: (session) => { leaseLost.push(session.id); },
    });
    await providers.poll();

    const makeSession = (id: string, profile: string) => ({
      id,
      client: `github:${OWNER_ID}`,
      purpose: 'sign_in',
      source: { kind: 'profile', profile, runtime: 'pool' },
      revision: undefined,
    } as unknown as Session);

    const clockOpened = await providers.opener(makeSession('s-clockhb12345', 'clock-hb'));
    const saveOpened = await providers.opener(makeSession('s-savehb123456', 'save-hb'));

    const saving = saveOpened.browser.saveArchive!(5_000);
    await saveEntered;
    await eventually(() => otherHeartbeats >= 3);
    releaseSave();

    const saved = await saving;
    assert.equal(saved.sha256, savedArchive.sha256);
    assert.equal(heartbeatsDuringSave, 0, 'heartbeats must stop while saveArchive is running');
    assert.deepEqual(leaseLost, [], 'onLeaseLost must not fire during saveArchive');

    await clockOpened.browser.stop();
    assert.equal(leases.size, 0);
    providers.stop();
  } finally {
    await server?.stop();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await run.remove();
  }
});
