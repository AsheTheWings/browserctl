// The dashboard with real browsers, as container root in the image: sign-in sessions on their own display over
// noVNC, saving and discarding them, and screencasts of agent sessions and of other owners' provider browsers.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chown, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { BrowserctlServer } from '../../src/server/server.ts';
import { cookies, visit } from '../support/browser.ts';
import { fakeProvider } from '../support/fake-provider.ts';
import { eventually, listeningSocketsOf, processesOf } from '../support/processes.ts';
import { runDirectory, testConfig } from '../support/server.ts';

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
    server = new BrowserctlServer(testConfig(run.path, { publicBaseUrl: ORIGIN }));
    await server.start();
    await server.tokens.create('operator');
    const login = await fetch(`http://127.0.0.1:${server.port}/dashboard/login?token=${server.dashboardAuth.link('operator')}`, { redirect: 'manual' });
    cookie = login.headers.get('set-cookie')!.split(';')[0]!;
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
    const opened = await post('/profiles/mail/sign-in');
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    const session = server.sessions.get(opened.body.session)!;
    try {
      assert.equal((await post('/profiles/mail/sign-in')).status, 409, 'one sign-in session per profile');
      const state = (await (await fetch(`http://127.0.0.1:${server.port}/dashboard/api/state`, { headers: { cookie } })).json()) as any;
      const listed = state.sessions.find((entry: any) => entry.id === session.id);
      assert.deepEqual(
        [listed.purpose, listed.source, listed.profile, listed.client, listed.state, listed.view, typeof listed.createdAt],
        ['sign_in', 'profile', 'mail', 'operator', 'ready', 'vnc', 'string'],
      );

      const processes = processesOf(session.users.browserUid);
      const chrome = processes.filter((entry) => entry.cmdline[0]?.endsWith('chrome'));
      assert.ok(chrome.length > 0, 'Chrome runs as the browser user');
      assert.ok(chrome.every((entry) => !entry.cmdline.some((argument) => argument.includes('remote-debugging'))), 'no remote-debugging switch');
      assert.ok(processes.some((entry) => entry.cmdline[0] === 'Xvfb'));
      assert.ok(processes.some((entry) => entry.cmdline[0] === 'x11vnc'));
      assert.deepEqual(listeningSocketsOf(session.users.browserUid), [], 'nothing of the session listens on TCP');

      const rfb = new RfbClient(await socket(`vnc/${session.id}`));
      assert.deepEqual(await rfb.handshake(), { width: 1280, height: 800 });
      // The toolbar strip, black until Chrome's window appears; the address bar changes once it takes focus.
      const toolbar = () => rfb.capture(0, 40, 1280, 50);
      const black = createHash('sha256').update(Buffer.alloc(1280 * 50 * 4)).digest('hex');
      await eventually(async () => (await toolbar()) !== black, 30_000);
      const before = session.lastActivity;
      rfb.pointer(640, 400, 1);
      rfb.pointer(640, 400, 0);
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
      assert.equal(profile.revisions.at(-1)!.client, 'operator');
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

  it('streams an agent session\'s page to grid and focused viewers', async () => {
    const session = await server.sessions.open('agent-a', { kind: 'ephemeral' });
    try {
      await visit(session, `${siteUrl}/animated`);
      const [grid, focused] = await Promise.all([socket(`screencast/${session.id}?stream=grid`), socket(`screencast/${session.id}?stream=focused`)]);
      // The component suite owns the grid's pacing and qualification the focused rate; here real Chrome must feed both.
      const [gridMs, focusedMs] = await Promise.all([frames(grid, 3), frames(focused, 3)]);
      assert.ok(gridMs > 0 && focusedMs > 0);
      const closed = new Promise((resolve) => focused.once('close', resolve));
      await server.sessions.close(session, 'closed');
      await closed;
    } finally {
      await server.sessions.close(session, 'closed');
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
      other = new BrowserctlServer(testConfig(root.path, { publicBaseUrl: ORIGIN, providers: [{ name: 'fake', leaseUrl: provider.url, cdpHost: '127.0.0.1', tokenFile }] }));
      await other.start();
      await other.tokens.create('operator');
      await other.providers.poll();
      const login = await fetch(`http://127.0.0.1:${other.port}/dashboard/login?token=${other.dashboardAuth.link('operator')}`, { redirect: 'manual' });
      const otherCookie = login.headers.get('set-cookie')!.split(';')[0]!;
      const state = (await (await fetch(`http://127.0.0.1:${other.port}/dashboard/api/state`, { headers: { cookie: otherCookie } })).json()) as any;
      assert.deepEqual(state.watched.map((entry: any) => [entry.id, entry.owner]), [['w-fake-3', 'someone-else']]);
      const ws = await new Promise<WebSocket>((resolve, reject) => {
        const opened = new WebSocket(`ws://127.0.0.1:${other!.port}/dashboard/ws/screencast/w-fake-3?stream=focused`, { headers: { cookie: otherCookie, origin: ORIGIN } });
        opened.once('open', () => resolve(opened));
        opened.once('error', reject);
      });
      await frames(ws, 1);
      assert.equal(provider.requests.filter((request) => request.path.startsWith('/leases')).length, 0, 'watching takes no lease');
      ws.close();
      assert.deepEqual(other.recordings.list(), [], 'a watched browser is not recorded');
    } finally {
      await other?.stop();
      await provider?.close();
      await root.remove();
      process.kill(-chrome.pid!, 'SIGKILL');
    }
  });
});
