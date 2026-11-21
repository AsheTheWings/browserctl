// The dashboard with real browsers, as container root in the image: sign-in sessions on their own display over
// noVNC, saving and discarding them, and screencasts of agent sessions and of other owners' provider browsers.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chown, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { chromium } from 'playwright-core';
import { WebSocket } from 'ws';
import { BrowserctlServer } from '../../src/server/server.ts';
import { cookies, visit, visitStartupTab } from '../support/browser.ts';
import { fakeProvider } from '../support/fake-provider.ts';
import { fakeGithub, OWNER_ID, signIn } from '../support/github.ts';
import { eventually, listeningSocketsOf, processesOf } from '../support/processes.ts';
import { runDirectory, testConfig } from '../support/server.ts';
import { memoryTelemetry } from '../support/telemetry.ts';

assert.equal(process.getuid?.(), 0, 'integration tests run as root in the image: node scripts/test.ts integration');

const ORIGIN = 'http://browserctl.example:8443';
/** A page that repaints ten times a second, light enough that a loaded runner still feeds the screencast. */
const ANIMATED = `<!doctype html><title>animated</title><canvas id="c" width="640" height="360"></canvas><script>
const context = document.getElementById('c').getContext('2d');
let frame = 0;
setInterval(() => { context.fillStyle = 'hsl(' + (frame++ % 360) + ', 80%, 50%)'; context.fillRect(0, 0, 640, 360); }, 100);
</script>`;

/** A minimal RFB 3.8 client over the dashboard's VNC WebSocket, enough to complete the handshake and type. */
class RfbClient {
  readonly socket: WebSocket;
  #buffer = Buffer.alloc(0);
  #waiters: Array<() => void> = [];
  #bytesPerPixel = 4;

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (raw) => {
      this.#buffer = Buffer.concat([this.#buffer, raw as Buffer]);
      for (const waiter of this.#waiters.splice(0)) waiter();
    });
  }

  async read(length: number): Promise<Buffer> {
    const deadline = Date.now() + 15_000;
    while (this.#buffer.length < length) {
      if (Date.now() > deadline) throw new Error('the VNC server sent too little');
      await new Promise<void>((resolve) => {
        this.#waiters.push(resolve);
        setTimeout(resolve, 500).unref();
      });
    }
    const chunk = this.#buffer.subarray(0, length);
    this.#buffer = this.#buffer.subarray(length);
    return chunk;
  }

  send(bytes: number[] | Buffer): void {
    this.socket.send(Buffer.from(bytes));
  }

  async handshake(): Promise<{ width: number; height: number }> {
    assert.equal((await this.read(12)).toString(), 'RFB 003.008\n');
    this.send(Buffer.from('RFB 003.008\n'));
    const count = (await this.read(1))[0]!;
    const types = [...(await this.read(count))];
    assert.ok(types.includes(1), 'the VNC server offers no authentication only behind the dashboard');
    this.send([1]);
    assert.equal((await this.read(4)).readUInt32BE(0), 0);
    this.send([1]);
    const init = await this.read(24);
    await this.read(init.readUInt32BE(20));
    this.#bytesPerPixel = init[4]! / 8;
    return { width: init.readUInt16BE(0), height: init.readUInt16BE(2) };
  }

  /** A hash of a screen region's pixels, from a full raw framebuffer update. */
  async capture(x: number, y: number, width: number, height: number): Promise<string> {
    this.send([3, 0, x >> 8, x & 0xff, y >> 8, y & 0xff, width >> 8, width & 0xff, height >> 8, height & 0xff]);
    for (;;) {
      const type = (await this.read(1))[0];
      if (type === 2) continue; // Bell
      if (type === 3) {
        const header = await this.read(7);
        await this.read(header.readUInt32BE(3));
        continue;
      }
      assert.equal(type, 0, 'a framebuffer update');
      const rectangles = (await this.read(3)).readUInt16BE(1);
      const hash = createHash('sha256');
      for (let index = 0; index < rectangles; index += 1) {
        const rectangle = await this.read(12);
        hash.update(await this.read(rectangle.readUInt16BE(4) * rectangle.readUInt16BE(6) * this.#bytesPerPixel));
      }
      return hash.digest('hex');
    }
  }

  pointer(x: number, y: number, buttons: number): void {
    this.send([5, buttons, x >> 8, x & 0xff, y >> 8, y & 0xff]);
  }

  key(keysym: number, down: boolean): void {
    this.send([4, down ? 1 : 0, 0, 0, (keysym >>> 24) & 0xff, (keysym >>> 16) & 0xff, (keysym >>> 8) & 0xff, keysym & 0xff]);
  }

  type(text: string): void {
    for (const character of text) {
      this.key(character.charCodeAt(0), true);
      this.key(character.charCodeAt(0), false);
    }
  }
}

describe('dashboard', () => {
  let run: Awaited<ReturnType<typeof runDirectory>>;
  let server: BrowserctlServer;
  let site: ReturnType<typeof createServer>;
  let siteUrl: string;
  let cookie: string;
  const visited: string[] = [];

  before(async () => {
    run = await runDirectory();
    server = new BrowserctlServer(testConfig(run.path, { publicBaseUrl: ORIGIN }), fakeGithub().request);
    await server.start();
    cookie = await signIn(`http://127.0.0.1:${server.port}`);
    site = createServer((request, response) => {
      visited.push(request.url ?? '');
      const headers: Record<string, string> = { 'content-type': 'text/html' };
      if (request.url === '/set') headers['set-cookie'] = 'snap=yes; Max-Age=86400; Path=/';
      // The page asks for /loaded once it has loaded, so its cookie is in the browser by then.
      const page = '<!doctype html><title>site</title><p>site</p><script>addEventListener("load", () => fetch("/loaded"))</script>';
      response.writeHead(200, headers).end(request.url === '/animated' ? ANIMATED : page);
    });
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  });

  after(async () => {
    await server.stop();
    await new Promise<void>((resolve) => site.close(() => resolve()));
    await run.remove();
  });

  const post = async (path: string, body: unknown = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.port}/dashboard/api${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: ORIGIN },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as any };
  };

  const socket = (path: string) =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/dashboard/ws/${path}`, { headers: { cookie, origin: ORIGIN } });
      ws.once('open', () => resolve(ws));
      ws.once('unexpected-response', (_request, response) => reject(new Error(`upgrade refused: ${response.statusCode}`)));
      ws.once('error', reject);
    });

  /** The milliseconds a screencast socket takes to deliver count JPEG frames after its first. */
  const frames = (ws: WebSocket, count: number, deadlineMs = 60_000) =>
    new Promise<number>((resolve, reject) => {
      let first: number | undefined;
      let seen = 0;
      let done = false;
      const fail = (error: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error(`only ${seen} of ${count + 1} frames arrived`)), deadlineMs);
      ws.on('message', (raw, isBinary) => {
        if (!isBinary || (raw as Buffer)[0] !== 0xff || (raw as Buffer)[1] !== 0xd8) return;
        first ??= performance.now();
        if (seen++ === count) {
          done = true;
          clearTimeout(timer);
          resolve(performance.now() - first);
        }
      });
      ws.once('error', (error) => fail(error));
      ws.once('unexpected-response', (_request, response) => fail(new Error(`the screencast upgrade was refused with ${response.statusCode}`)));
      ws.once('close', (code) => fail(new Error(`the screencast closed with ${code} after ${seen} of ${count + 1} frames`)));
    });

  it('signs in on a display without remote debugging, typed through noVNC, and saves a current revision', async () => {
    assert.equal((await post('/profiles', { name: 'mail' })).status, 201);
    const starts = await Promise.all([post('/profiles/mail/sign-in'), post('/profiles/mail/sign-in')]);
    const opened = starts.find((entry) => entry.status === 201);
    assert.ok(opened, JSON.stringify(starts));
    const session = server.sessions.get(opened.body.session)!;
    try {
      assert.deepEqual(starts.map(({ status }) => status).sort(), [200, 201]);
      assert.ok(starts.every(({ body }) => body.session === session.id), 'concurrent connects share one session');
      assert.deepEqual(await post('/profiles/mail/sign-in'), { status: 200, body: { session: session.id } });
      assert.equal((await post('/profiles/missing/sign-in')).status, 404);
      const connect = `http://127.0.0.1:${server.port}/dashboard/api/profiles/mail/sign-in`;
      assert.equal((await fetch(connect, { method: 'POST', headers: { origin: ORIGIN } })).status, 401);
      assert.equal((await fetch(connect, { method: 'POST', headers: { cookie, origin: 'https://untrusted.example' } })).status, 403);
      const state = (await (await fetch(`http://127.0.0.1:${server.port}/dashboard/api/state`, { headers: { cookie } })).json()) as any;
      const listed = state.sessions.find((entry: any) => entry.id === session.id);
      assert.deepEqual(
        [listed.purpose, listed.source, listed.profile, listed.client, listed.state, listed.view, typeof listed.createdAt],
        ['sign_in', 'profile', 'mail', `github:${OWNER_ID}`, 'ready', 'vnc', 'string'],
      );

      const rfb = new RfbClient(await socket(`vnc/${session.id}`));
      assert.deepEqual(await rfb.handshake(), { width: 1920, height: 1080 });
      // The toolbar strip, black until Chrome's window appears; the address bar changes once it takes focus.
      const toolbar = () => rfb.capture(0, 40, 1920, 50);
      const black = createHash('sha256').update(Buffer.alloc(1920 * 50 * 4)).digest('hex');
      await eventually(async () => (await toolbar()) !== black, 30_000);

      const processes = processesOf(session.users.browserUid);
      const chrome = processes.filter((entry) => entry.cmdline[0]?.endsWith('chrome'));
      assert.ok(chrome.length > 0, 'Chrome runs as the browser user');
      assert.ok(chrome.every((entry) => !entry.cmdline.some((argument) => argument.includes('remote-debugging'))), 'no remote-debugging switch');
      assert.ok(processes.some((entry) => entry.cmdline[0] === 'Xvfb'));
      assert.ok(processes.some((entry) => entry.cmdline[0] === 'x11vnc'));
      assert.deepEqual(listeningSocketsOf(session.users.browserUid), [], 'nothing of the session listens on TCP');

      const before = session.lastActivity;
      rfb.pointer(960, 540, 1);
      rfb.pointer(960, 540, 0);
      await eventually(() => session.lastActivity > before, 5_000);
      const unfocused = await toolbar();
      rfb.key(0xffe3, true);
      rfb.type('l');
      rfb.key(0xffe3, false);
      await eventually(async () => (await toolbar()) !== unfocused, 10_000);
      rfb.type(`${siteUrl}/set`);
      rfb.key(0xff0d, true);
      rfb.key(0xff0d, false);
      await eventually(() => visited.includes('/set') && visited.includes('/loaded'), 30_000);
      rfb.socket.close();

      const saved = await post(`/sessions/${session.id}/save`);
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      const profile = await server.profiles.get('mail');
      assert.equal(profile.current, saved.body.revision);
      assert.equal(profile.revisions.at(-1)!.client, `github:${OWNER_ID}`);
      assert.equal(session.state, 'closed');
    } finally {
      await server.sessions.close(session, 'closed');
    }

    const check = await server.sessions.open('operator', { kind: 'profile', profile: 'mail' });
    try {
      assert.deepEqual(await cookies(check), ['snap=yes'], 'the saved revision holds the cookie set in the sign-in session');
    } finally {
      await server.sessions.close(check, 'closed');
    }
  });

  it('discards a sign-in session without a revision', async () => {
    const before = (await server.profiles.get('mail')).revisions.length;
    const opened = await post('/profiles/mail/sign-in');
    const session = server.sessions.get(opened.body.session)!;
    assert.equal((await post(`/sessions/${session.id}/discard`)).status, 200);
    assert.equal(session.state, 'closed');
    assert.equal((await server.profiles.get('mail')).revisions.length, before);
  });

  it('streams an authenticated, read-only full window at 1080p30 and closes it on sign-out', async () => {
    const session = await server.sessions.open('agent-a', { kind: 'ephemeral' });
    const base = `http://127.0.0.1:${server.port}`;
    const url = `${base}/dashboard/api/sessions/${session.id}/window`;
    const viewer = await signIn(base);
    const abort = new AbortController();
    try {
      const snapshot = (await (await fetch(`${base}/dashboard/api/state`, { headers: { cookie } })).json()) as any;
      assert.equal(snapshot.sessions.find((entry: any) => entry.id === session.id)?.view, 'window');
      assert.equal((await fetch(url)).status, 401);
      const response = await fetch(url, {
        headers: { cookie: viewer },
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]),
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'video/mp4');
      const reader = response.body!.getReader();
      let video = Buffer.alloc(0);
      while (!video.includes('moof') && video.length < 1024 * 1024) {
        const { done, value } = await reader.read();
        assert.ok(!done, 'the live MP4 ended before the first fragment');
        video = Buffer.concat([video, value]);
      }
      assert.equal(video.subarray(4, 8).toString(), 'ftyp');
      assert.ok(video.includes('avc1') && video.includes('moof'));
      const encoder = () => processesOf(session.users.browserUid).find((entry) => entry.cmdline[0] === 'ffmpeg');
      const args = encoder()!.cmdline;
      assert.equal(args[args.indexOf('-video_size') + 1], '1920x1080');
      assert.equal(args[args.indexOf('-framerate') + 1], '30');
      assert.ok(!processesOf(session.users.browserUid).some((entry) => entry.cmdline[0] === 'x11vnc'), 'the agent display has no interactive viewer');

      const logout = await fetch(`${base}/dashboard/api/logout`, { method: 'POST', headers: { cookie: viewer, origin: ORIGIN } });
      assert.equal(logout.status, 204);
      await eventually(() => encoder() === undefined);
      assert.equal((await fetch(url, { headers: { cookie: viewer } })).status, 401);
      assert.equal((await fetch(`${base}/dashboard/api/state`, { headers: { cookie } })).status, 200);
      assert.equal(session.state, 'ready');
    } finally {
      abort.abort();
      await server.sessions.close(session, 'closed');
    }
  });

  it('fits the live window, shows loading during startup, and stops encoding on close', async () => {
    const agent = await server.sessions.open('agent-a', { kind: 'ephemeral' });
    try {
      const viewer = await server.sessions.open('viewer', { kind: 'ephemeral' }, 'check');
      try {
        const browser = await chromium.connectOverCDP(server.sessions.endpoint(viewer));
        try {
          const base = `http://127.0.0.1:${server.port}`;
          const context = browser.contexts()[0]!;
          const [name, value] = cookie.split('=');
          await context.addCookies([{ name: name!, value: value!, url: base }]);
          await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
          const page = await context.newPage();
          await page.goto(`${base}/dashboard/`);
          const tile = page.getByRole('button').filter({ hasText: agent.id });
          const videoRequest = Promise.withResolvers<void>();
          await page.route('**/window', async (route) => {
            await videoRequest.promise;
            await route.continue();
          });
          try {
            await tile.click();
            const dialog = page.getByRole('dialog');
            await dialog.getByText('ephemeral · agent-a', { exact: true }).waitFor();
            await dialog.getByRole('button', { name: `Copy session ID ${agent.id}` }).click();
            await dialog.getByText('Copied', { exact: true }).waitFor();
            assert.equal(await page.evaluate(() => navigator.clipboard.readText()), agent.id);
            const loading = dialog.getByRole('status').filter({ hasText: 'Starting live video…' });
            await loading.waitFor();
            assert.ok(await loading.locator('svg').isVisible());
            assert.equal(await dialog.getByLabel('Live browser window').getAttribute('poster'), null);
          } finally {
            videoRequest.resolve();
          }
          await page.waitForFunction(() => {
            const video = document.querySelector('dialog video');
            return video instanceof HTMLVideoElement && video.currentTime > 0;
          }, null, { timeout: 20_000 });
          await page.getByText('Starting live video…').waitFor({ state: 'hidden' });
          const ratio = await page.getByLabel('Live browser window').evaluate((video) => {
            const { width, height } = video.getBoundingClientRect();
            return width / height;
          });
          assert.ok(Math.abs(ratio - 16 / 9) < 0.01, 'the expanded stage fits the full frame');
          const encoding = () => processesOf(agent.users.browserUid).some((entry) => entry.cmdline[0] === 'ffmpeg');
          assert.ok(encoding(), 'the viewer has a live encoder');
          const dialog = page.getByRole('dialog');
          await page.getByRole('button', { name: 'Full screen', exact: true }).click();
          const isFullscreen = () => document.fullscreenElement?.classList.contains('viewer-surface') === true;
          await page.waitForFunction(isFullscreen);
          assert.equal(await dialog.getByRole('button').count(), 0, 'fullscreen has no viewer actions');
          await page.keyboard.press('Escape');
          await dialog.waitFor({ state: 'hidden' });
          await page.waitForFunction(() => document.fullscreenElement === null);
          await eventually(() => !encoding(), 5_000);

          await page.evaluate(() => {
            const request = Element.prototype.requestFullscreen;
            Element.prototype.requestFullscreen = function (options) {
              Element.prototype.requestFullscreen = request;
              const entered = request.call(this, options);
              void entered.then(() => {
                document.documentElement.dataset.fullscreenEntered = 'true';
                return document.exitFullscreen();
              });
              return entered;
            };
          });
          await page.getByRole('button', { name: `Open ${agent.id} fullscreen` }).click();
          await page.waitForFunction(() => document.documentElement.dataset.fullscreenEntered === 'true');
          await dialog.waitFor({ state: 'hidden' });

          await page.evaluate(() => {
            const request = Element.prototype.requestFullscreen;
            Element.prototype.requestFullscreen = function () {
              Element.prototype.requestFullscreen = request;
              return Promise.reject(new DOMException('Fullscreen unavailable', 'NotAllowedError'));
            };
          });
          await page.getByRole('button', { name: `Open ${agent.id} fullscreen` }).click();
          await dialog.getByRole('button', { name: 'Full screen', exact: true }).waitFor();
          await dialog.getByRole('button', { name: 'Close viewer' }).click();
          await dialog.waitFor({ state: 'hidden' });

          await tile.focus();
          await tile.click();
          await dialog.waitFor();
          await page.keyboard.press('Escape');
          await dialog.waitFor({ state: 'hidden' });
          assert.ok(await tile.evaluate((card) => document.activeElement === card));
          assert.equal(agent.state, 'ready');
        } finally {
          await browser.close();
        }
      } finally {
        await server.sessions.close(viewer, 'closed');
      }
    } finally {
      await server.sessions.close(agent, 'closed');
    }
  });

  it('shows only finished recordings and fills the latest five slots on Overview', async () => {
    const viewer = await server.sessions.open('viewer', { kind: 'ephemeral' }, 'check');
    try {
      const browser = await chromium.connectOverCDP(server.sessions.endpoint(viewer));
      try {
        const base = `http://127.0.0.1:${server.port}`;
        const context = browser.contexts()[0]!;
        const [name, value] = cookie.split('=');
        await context.addCookies([{ name: name!, value: value!, url: base }]);
        const page = await context.newPage();
        await page.route('**/dashboard/api/state', (route) => route.fulfill({
          json: {
            sessions: [], watched: [],
            recordings: Array.from({ length: 7 }, (_, index) => ({
              session: `s-${String(index).padStart(12, '0')}`,
              client: 'agent-a', purpose: 'agent', source: 'ephemeral', bytes: 1024,
              startedAt: `2026-11-01T10:0${6 - index}:00.000Z`,
              ...(index > 0 && { endedAt: '2026-11-01T10:07:00.000Z' }),
              active: index === 0,
            })),
          },
        }));
        await page.goto(`${base}/dashboard/`);
        const table = page.getByRole('table', { name: 'Recordings' });
        const plays = table.getByRole('button', { name: 'Play' });
        await table.waitFor();
        assert.equal(await plays.count(), 5);
        assert.equal(await table.getByText('s-000000000000', { exact: true }).count(), 0);
        assert.equal(await table.getByText('s-000000000006', { exact: true }).count(), 0);

        await page.getByRole('link', { name: 'All recordings' }).click();
        await table.getByText('s-000000000006', { exact: true }).waitFor();
        assert.equal(await plays.count(), 6);
        assert.equal(await table.getByText('s-000000000000', { exact: true }).count(), 0);
      } finally {
        await browser.close();
      }
    } finally {
      await server.sessions.close(viewer, 'closed');
    }
  });

  it('selects a profile provider from the create form at desktop and mobile widths', async () => {
    const viewer = await server.sessions.open('viewer', { kind: 'ephemeral' }, 'check');
    try {
      const browser = await chromium.connectOverCDP(server.sessions.endpoint(viewer));
      try {
        const base = `http://127.0.0.1:${server.port}`;
        const context = browser.contexts()[0]!;
        const [name, value] = cookie.split('=');
        await context.addCookies([{ name: name!, value: value!, url: base }]);
        const page = await context.newPage();
        await page.route('**/dashboard/api/state', (route) => route.fulfill({
          json: { sessions: [], watched: [], recordings: [], profiles: [], tasks: [],
            providers: [{ name: 'external', profileManagement: true }] },
        }));
        await page.route('**/dashboard/api/provider-profiles/external', (route) =>
          route.fulfill({ json: route.request().method() === 'POST'
            ? { name: route.request().postDataJSON().name, current: null, revisions: [] }
            : { profiles: [] } }));
        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: 800 });
          await page.goto(`${base}/dashboard/?viewport=${width}#profiles`);
          const field = page.getByRole('textbox', { name: 'Profile name' });
          const picker = page.getByRole('combobox', { name: 'Provider' });
          const create = page.getByRole('button', { name: 'Create profile' });
          assert.match(await picker.innerText(), /Managed/);
          await field.fill(`profile-${width}`);
          const [inputBox, pickerBox, createBox] = await Promise.all([field.boundingBox(), picker.boundingBox(), create.boundingBox()]);
          assert.ok(inputBox && pickerBox && createBox);
          if (width === 1280) {
            assert.equal(inputBox.y, pickerBox.y);
            assert.equal(pickerBox.y, createBox.y);
            assert.ok(inputBox.x < pickerBox.x && pickerBox.x < createBox.x);
          }
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          await picker.press('Enter');
          const external = page.getByRole('option', { name: 'external' });
          await external.waitFor();
          if (width === 1280) {
            const managedOption = page.getByRole('option', { name: 'Managed' });
            await eventually(() => managedOption.evaluate((node) => document.activeElement === node));
            await page.keyboard.press('End');
            await eventually(() => external.evaluate((node) => document.activeElement === node));
            await page.keyboard.press('Enter');
          } else {
            await external.click();
          }
          await eventually(() => picker.evaluate((node) => document.activeElement === node));
          assert.equal(await picker.innerText(), 'external');
          assert.equal(await field.inputValue(), `profile-${width}`);
          assert.equal(await field.evaluate((input: HTMLInputElement) => input.validationMessage), '');
          const request = page.waitForRequest((candidate) =>
            candidate.method() === 'POST' && candidate.url().endsWith('/dashboard/api/provider-profiles/external'));
          await create.click();
          assert.deepEqual((await request).postDataJSON(), { name: `profile-${width}` });
          await page.getByRole('heading', { name: `profile-${width}` }).waitFor();
        }
      } finally {
        await browser.close();
      }
    } finally {
      await server.sessions.close(viewer, 'closed');
    }
  });

  it('switches a profile card between revisions, attributed notes, and sign-in checks', async () => {
    const name = 'tabbed-profile';
    const client = `github:${OWNER_ID}`;
    await server.profiles.create(name, client);
    try {
      for (let index = 0; index < 4; index++) await server.profiles.addRevision(name, server.profiles.revisionPath(name, '1'), client);
      const agentNote = Array.from({ length: 20 }, () => 'Agent line').join('\n');
      await server.profiles.setNote(name, 'agent', agentNote, 'agent-a');
      const viewer = await server.sessions.open('viewer', { kind: 'ephemeral' }, 'check');
      try {
        const browser = await chromium.connectOverCDP(server.sessions.endpoint(viewer));
        try {
          const base = `http://127.0.0.1:${server.port}`;
          const context = browser.contexts()[0]!;
          const [key, value] = cookie.split('=');
          await context.addCookies([{ name: key!, value: value!, url: base }]);
          // The fixture's configured public origin differs from its dynamically allocated loopback URL.
          await context.route('**/dashboard/api/profiles/*/notes', async (route) => {
            const response = await route.fetch({ headers: { ...await route.request().allHeaders(), origin: ORIGIN } });
            await route.fulfill({ response });
          });
          const page = await context.newPage();
          await page.setViewportSize({ width: 1280, height: 800 });
          await page.goto(`${base}/dashboard/#profiles`);
          const tabs = page.getByRole('tablist', { name: `${name} details` });
          const card = page.locator('[data-slot="card"]').filter({ has: tabs });
          const revisions = tabs.getByRole('tab', { name: 'Revisions' });
          await revisions.waitFor();
          assert.equal(await revisions.getAttribute('aria-selected'), 'true');
          const table = page.getByRole('table', { name: `${name} revisions` });
          await table.waitFor();
          const minimumHeight = await card.evaluate((element) => parseFloat(getComputedStyle(element).minHeight));
          assert.ok((await card.boundingBox())!.height > minimumHeight, 'revisions can grow the card');
          await revisions.press('ArrowRight');
          const notes = page.getByRole('tabpanel', { name: 'Notes' });
          const agentText = notes.getByText(agentNote, { exact: true });
          await agentText.waitFor();
          assert.equal(await table.isVisible(), false);
          assert.equal((await card.boundingBox())!.height, minimumHeight);
          assert.ok(await agentText.evaluate((element) => element.scrollHeight > element.clientHeight), 'long agent text scrolls');
          const editor = notes.getByRole('textbox', { name: 'Operator note text' });
          const profileName = page.getByRole('textbox', { name: 'Profile name' });
          const fieldSizes = (field: Element) => {
            const rootSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
            return [undefined, '::placeholder'].map((part) => parseFloat(getComputedStyle(field, part).fontSize) / rootSize);
          };
          assert.deepEqual(await profileName.evaluate(fieldSizes), [0.875, 0.875]);
          assert.deepEqual(await editor.evaluate(fieldSizes), [0.875, 0.875]);
          const save = notes.getByRole('button', { name: 'Save note' });
          await editor.focus();
          const outlineExtent = await editor.evaluate((element) => {
            const style = getComputedStyle(element);
            return parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth);
          });
          const editorBox = (await editor.boundingBox())!;
          assert.ok((await save.boundingBox())!.y > editorBox.y + editorBox.height + outlineExtent,
            'the focused editor outline leaves a gap before the footer');
          const connect = card.getByRole('button', { name: 'Connect' });
          assert.equal((await save.boundingBox())!.height, (await connect.boundingBox())!.height);
          const counter = notes.getByText(/^\d+\/240$/);
          const counterWidth = (await counter.boundingBox())!.width;
          await editor.fill('x'.repeat(241));
          assert.equal(await editor.inputValue(), '');
          const note = '🙂'.repeat(240);
          await editor.fill(note);
          await editor.press('Control+End');
          await page.keyboard.insertText('x');
          assert.equal(await editor.inputValue(), note);
          assert.equal(await counter.textContent(), '240/240');
          assert.equal((await counter.boundingBox())!.width, counterWidth);
          assert.equal(await counter.evaluate((element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            return new Set(Array.from(range.getClientRects(), (rect) => rect.top)).size;
          }), 1, 'the count and limit stay on the same line');
          const written = page.waitForResponse((response) => response.url().endsWith(`/profiles/${name}/notes`));
          await save.click();
          const response = await written;
          assert.equal(response.status(), 200, await response.text());
          await notes.getByText(client, { exact: false }).waitFor();
          assert.equal((await server.profiles.get(name)).notes?.operator?.text, note);
          assert.equal((await card.boundingBox())!.height, minimumHeight);
          await page.setViewportSize({ width: 820, height: 800 });
          assert.equal((await card.boundingBox())!.height, minimumHeight);
          assert.ok(await save.evaluate((element) => element.getBoundingClientRect().bottom <= element.closest('[role="tabpanel"]')!.getBoundingClientRect().bottom), 'the tablet layout keeps Save note in view');
          await page.setViewportSize({ width: 375, height: 800 });
          assert.deepEqual(await editor.evaluate(fieldSizes), [1, 1]);
          assert.equal((await card.boundingBox())!.height, minimumHeight);
          await agentText.scrollIntoViewIfNeeded();
          assert.ok(await notes.evaluate((element) => element.scrollTop > 0 && element.scrollWidth === element.clientWidth), 'stacked notes scroll vertically to the agent note');
          await page.setViewportSize({ width: 1280, height: 800 });
          await tabs.getByRole('tab', { name: 'Sign-in checks' }).click();
          const checks = page.getByRole('tabpanel', { name: 'Sign-in checks' });
          const message = checks.getByText('A saved check task is required to add a service.');
          await message.waitFor();
          const layout = await message.evaluate((element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            const text = range.getBoundingClientRect();
            const panel = element.closest('[role="tabpanel"]')!.getBoundingClientRect();
            const card = element.closest('[data-slot="card"]')!.getBoundingClientRect();
            return {
              cardHeight: card.height,
              horizontalOffset: text.x + text.width / 2 - (panel.x + panel.width / 2),
              verticalOffset: text.y + text.height / 2 - (panel.y + panel.height / 2),
            };
          });
          assert.equal(layout.cardHeight, minimumHeight);
          assert.ok(Math.abs(layout.horizontalOffset) <= 1 && Math.abs(layout.verticalOffset) <= 2, JSON.stringify(layout));
          assert.equal(await editor.isVisible(), false);

          const task = `${name}-check`;
          await server.tasks.save(task, "import { test } from 'e2e';\ntest('check', async () => {});\n", client);
          for (let index = 0; index < 5; index++) await server.profiles.addService(name, `service-${index}`, task);
          await page.reload();
          await tabs.getByRole('tab', { name: 'Sign-in checks' }).click();
          const addService = checks.getByRole('button', { name: 'Add service' });
          await addService.scrollIntoViewIfNeeded();
          assert.equal((await card.boundingBox())!.height, minimumHeight);
          assert.ok(await checks.evaluate((element) => element.scrollTop > 0), 'the service controls can scroll into view');
        } finally {
          await browser.close();
        }
      } finally {
        await server.sessions.close(viewer, 'closed');
      }
    } finally {
      await server.profiles.delete(name);
    }
  });

  it('streams an agent session\'s page to grid and focused viewers', async () => {
    const telemetry = memoryTelemetry();
    let session: Awaited<ReturnType<typeof server.sessions.open>> | undefined;
    try {
      session = await server.sessions.open('agent-a', { kind: 'ephemeral' });
      const pageUrl = `${siteUrl}/`;
      const cdp = session.browser!.cdp!;
      const captures = new Map<string, number>();
      const visible = new Map<string, boolean>();
      const stopObserving = cdp.onEvent(({ method, params, sessionId }) => {
        if (!sessionId) return;
        if (method === 'Page.screencastVisibilityChanged') visible.set(sessionId, params?.visible === true);
        if (method === 'Page.screencastFrame') captures.set(sessionId, (captures.get(sessionId) ?? 0) + 1);
      });
      void session.closed.then(stopObserving);
      // Use Chrome's startup tab so the check has one foreground paint source.
      const page = await visitStartupTab(session, pageUrl);
      const { result } = await cdp.call<{ result: { value: string[] } }>('Runtime.evaluate', {
        expression: '[location.href, document.visibilityState]',
        returnByValue: true,
      }, page);
      assert.deepEqual(result.value, [pageUrl, 'visible']);

      const [grid, focused] = await Promise.all([socket(`screencast/${session.id}?stream=grid`), socket(`screencast/${session.id}?stream=focused`)]);
      const received = [grid, focused].map((ws) => {
        const images = new Set<string>();
        ws.on('message', (raw, binary) => {
          if (!binary || images.size >= 4) return;
          const jpeg = raw as Buffer;
          if (jpeg[0] === 0xff && jpeg[1] === 0xd8) images.add(createHash('sha256').update(jpeg).digest('hex'));
        });
        return images;
      });
      // Change the visible page until both viewers have fresh frames. Pacing is checked separately.
      let hue = 0;
      await eventually(async () => {
        if (received.every((images) => images.size === 4)) return true;
        await cdp.call('Runtime.evaluate', { expression: `document.body.style.background = "hsl(${hue++ * 29}, 80%, 50%)"` }, page);
        return false;
      }, 60_000).catch(async (cause) => {
        const { metrics, spans } = await telemetry.collect();
        const delivered = metrics.filter(({ name }) => name === 'browserctl.screencast.frames').map(({ attributes }) => attributes['browserctl.stream']);
        const startup = spans.filter(({ name }) => name === 'browserctl.screencast.capture_start').map(({ attributes }) => attributes);
        const tabs = [...new Set([...visible.keys(), ...captures.keys()])].map((id) => ({ visible: visible.get(id), captures: captures.get(id) ?? 0 }));
        throw new Error(
          `grid and focused viewers received ${received.map((images) => images.size).join(' and ')} of 4 distinct JPEGs each; `
          + `capture startup ${JSON.stringify(startup)}, Chrome capture sessions ${JSON.stringify(tabs)}, server deliveries ${JSON.stringify(delivered)}, `
          + `WebSocket states ${grid.readyState} and ${focused.readyState}`,
          { cause },
        );
      });
      const closed = new Promise((resolve) => focused.once('close', resolve));
      await server.sessions.close(session, 'closed');
      await closed;
    } finally {
      try {
        if (session) await server.sessions.close(session, 'closed');
      } finally {
        await telemetry.restore();
      }
    }
  });

  it('watches another owner\'s provider browser read-only', async () => {
    const uid = 1099;
    const home = join(run.path, 'provider-browser');
    await mkdir(home, { mode: 0o700 });
    await chown(home, uid, uid);
    const chrome = spawn('chrome', ['--headless', '--remote-debugging-port=0', `--user-data-dir=${home}`, '--no-first-run', `${siteUrl}/animated`], {
      uid, gid: uid, cwd: home, env: { HOME: home, TMPDIR: home, PATH: server.config.path }, stdio: 'ignore', detached: true,
    });
    const root = await runDirectory();
    let other: BrowserctlServer | undefined;
    let provider: Awaited<ReturnType<typeof fakeProvider>> | undefined;
    try {
      let port = 0;
      await eventually(async () => {
        port = Number((await readFile(join(home, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n')[0]);
        return port > 0;
      });
      provider = await fakeProvider({ browserPort: port });
      provider.others.push({ slot: 3, owner: 'someone-else' });
      const tokenFile = join(root.path, 'provider-token');
      await writeFile(tokenFile, provider.token, { mode: 0o600 });
      other = new BrowserctlServer(testConfig(root.path, { publicBaseUrl: ORIGIN, providers: [{ name: 'fake', leaseUrl: provider.url, cdpHost: '127.0.0.1', tokenFile }] }), fakeGithub().request);
      await other.start();
      await other.providers.poll();
      const otherCookie = await signIn(`http://127.0.0.1:${other.port}`);
      const state = (await (await fetch(`http://127.0.0.1:${other.port}/dashboard/api/state`, { headers: { cookie: otherCookie } })).json()) as any;
      assert.deepEqual(state.watched.map((entry: any) => [entry.id, entry.owner]), [['w-fake-3', 'someone-else']]);
      const ws = await new Promise<WebSocket>((resolve, reject) => {
        const opened = new WebSocket(`ws://127.0.0.1:${other!.port}/dashboard/ws/screencast/w-fake-3?stream=focused`, { headers: { cookie: otherCookie, origin: ORIGIN } });
        opened.once('open', () => resolve(opened));
        opened.once('error', reject);
      });
      await frames(ws, 1);
      assert.equal(provider.requests.filter((request) => request.path.startsWith('/leases')).length, 0, 'watching takes no lease');
      const disconnected = new Promise<number>((resolve) => ws.once('close', resolve));
      const logout = await fetch(`http://127.0.0.1:${other.port}/dashboard/api/logout`, {
        method: 'POST', headers: { cookie: otherCookie, origin: ORIGIN },
      });
      assert.equal(logout.status, 204);
      assert.equal(await disconnected, 1008);
      assert.deepEqual(other.recordings.list(), [], 'a watched browser is not recorded');
    } finally {
      await other?.stop();
      await provider?.close();
      await root.remove();
      process.kill(-chrome.pid!, 'SIGKILL');
    }
  });
});
