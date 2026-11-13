// Qualification of the built image: the server runs under the container's exact capability set and
// no-new-privileges, Chrome is sandboxed as a browser user, a session opens and is driven over MCP, and the focused
// screencast follows an animating page near its full rate. Run with BROWSERCTL_QUALIFICATION_LAYOUT naming the OCI
// layout `scripts/image.sh build` wrote and BROWSERCTL_QUALIFICATION_REVISION naming its revision.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { CONTAINER_CAPABILITIES, CONTAINER_CAPABILITY_MASK } from '../../scripts/container.ts';
import { mcpClient, type TestClient } from '../support/mcp.ts';
import { eventually } from '../support/processes.ts';

const IMAGE_TAG = `localhost/browserctl-qualified:${randomBytes(6).toString('hex')}`;
const CONTAINER = `browserctl-qualification-${randomBytes(6).toString('hex')}`;
/** The focused stream sends every frame Chrome paints; the grid's 5 frames per second is far below this. */
const MIN_FOCUSED_FPS = 45;

const PODMAN_ENV = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  // Podman's image store is the operator's own, not the test's run-owned home, so the image is not unpacked into a
  // size-limited temporary filesystem.
  HOME: process.env.BROWSERCTL_QUALIFICATION_HOME ?? process.env.HOME ?? tmpdir(),
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? '',
  ...(process.env.BROWSERCTL_QUALIFICATION_DATA_HOME ? { XDG_DATA_HOME: process.env.BROWSERCTL_QUALIFICATION_DATA_HOME } : {}),
};

function podman(args: string[], input?: string): string {
  const result = spawnSync('podman', args, { env: PODMAN_ENV, encoding: 'utf8', input });
  if (result.status !== 0) throw new Error(`podman ${args[0]} failed: ${(result.stderr || '').trim()}`);
  return result.stdout;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/** A page that repaints on every animation frame, so its screencast sends frames continuously. */
const ANIMATED = `<!doctype html><title>animated</title><canvas id="c" width="1280" height="720"></canvas><script>
const context = document.getElementById('c').getContext('2d');
let frame = 0;
(function draw() { context.fillStyle = 'hsl(' + (frame++ % 360) + ', 80%, 50%)'; context.fillRect(0, 0, 1280, 720); requestAnimationFrame(draw); })();
</script>`;

/** Count the JPEG frames a focused screencast delivers over a period. */
async function focusedFrames(port: number, session: string, cookie: string): Promise<number> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/dashboard/ws/screencast/${session}?stream=focused`, {
    headers: { cookie, origin: `http://127.0.0.1:${port}` },
  });
  let frames = 0;
  socket.on('message', (raw, isBinary) => {
    if (isBinary && (raw as Buffer)[0] === 0xff && (raw as Buffer)[1] === 0xd8) frames += 1;
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const seconds = 3;
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  socket.close();
  return frames / seconds;
}

describe('built image', () => {
  it('runs the server, a sandboxed Chrome, an MCP session, and a focused screencast', async () => {
    const layout = process.env.BROWSERCTL_QUALIFICATION_LAYOUT;
    const revision = process.env.BROWSERCTL_QUALIFICATION_REVISION;
    assert.ok(layout, 'BROWSERCTL_QUALIFICATION_LAYOUT names the image OCI layout');
    assert.match(revision ?? '', /^[0-9a-f]{40}$/, 'BROWSERCTL_QUALIFICATION_REVISION names the built revision');

    const run = await mkdtemp(join(tmpdir(), 'bq-'));
    // Session users pass through the run directory to the work directory; the browser users never write to the host.
    await chmod(run, 0o711);
    const state = join(run, 'state');
    const work = join(run, 'work');
    await mkdir(state, { mode: 0o700 });
    await mkdir(work, { mode: 0o711 });
    const port = await freePort();
    const site = createServer((_request, response) => response.writeHead(200, { 'content-type': 'text/html' }).end(ANIMATED));
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    const siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}/animated`;
    let client: TestClient | undefined;
    let started = false;
    try {
      podman(['pull', '-q', `oci:${layout}:localhost/browserctl-build:${revision}`]);
      podman(['tag', `localhost/browserctl-build:${revision}`, IMAGE_TAG]);
      podman([
        'run', '-d', '--name', CONTAINER, '--network=host',
        '--cap-drop=all', ...CONTAINER_CAPABILITIES.map((capability) => `--cap-add=${capability}`),
        '--security-opt=no-new-privileges',
        '-e', 'BROWSERCTL_STATE_DIRECTORY=/var/lib/browserctl/state',
        '-e', 'BROWSERCTL_WORK_DIRECTORY=/var/lib/browserctl/work',
        '-e', 'BROWSERCTL_RECORDINGS_DIRECTORY=/var/lib/browserctl/state/recordings',
        '-e', `BROWSERCTL_PORT=${port}`,
        '-e', `BROWSERCTL_PUBLIC_BASE_URL=http://127.0.0.1:${port}`,
        '-e', 'OTEL_TRACES_EXPORTER=none', '-e', 'OTEL_METRICS_EXPORTER=none', '-e', 'OTEL_LOGS_EXPORTER=none',
        '-e', 'BROWSERCTL_DEPLOYMENT_ENVIRONMENT=qualification',
        '-v', `${state}:/var/lib/browserctl/state`,
        '-v', `${work}:/var/lib/browserctl/work`,
        IMAGE_TAG,
      ]);
      started = true;
      await eventually(async () => (await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true, 60_000);

      const token = podman(['exec', CONTAINER, 'node', 'bin/browserctl.ts', 'admin', 'tokens', 'create', 'qualification']).trim();
      const link = podman(['exec', CONTAINER, 'node', 'bin/browserctl.ts', 'admin', 'dashboard-link', 'qualification']).trim();
      const build = JSON.parse(podman(['exec', CONTAINER, 'cat', 'build-info.json'])) as { version: string; revision: string };
      assert.deepEqual(build, { version: '0.0.0', revision }, 'the image carries its build');
      client = await mcpClient(port, token);
      const opened = await client.call('session_open', { ephemeral: true });
      assert.equal(opened.isError, false, opened.text);
      const session = opened.json().id as string;
      const navigated = await client.call('browser_navigate', { url: siteUrl });
      assert.equal(navigated.isError, false, navigated.text);

      const login = await fetch(link, { redirect: 'manual' });
      assert.equal(login.status, 303);
      const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
      // The image holds the dashboard page and noVNC, not just the server.
      const page = await fetch(`http://127.0.0.1:${port}/dashboard/`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /<title>browserctl<\/title>/);
      assert.equal((await fetch(`http://127.0.0.1:${port}/dashboard/novnc/core/rfb.js`)).status, 200);
      const fps = await focusedFrames(port, session, cookie);
      assert.ok(fps >= MIN_FOCUSED_FPS, `the focused screencast ran at ${fps.toFixed(1)} frames per second`);

      // Exactly the container's capability set, read from the running server rather than its configuration.
      const caps = /^CapEff:\s+([0-9a-f]+)$/m.exec(podman(['exec', CONTAINER, 'cat', '/proc/1/status']))?.[1];
      assert.equal(Number.parseInt(caps ?? '', 16), CONTAINER_CAPABILITY_MASK, 'the server holds only its capability set');
      assert.match(podman(['inspect', CONTAINER, '--format', '{{json .HostConfig.SecurityOpt}}']), /no-new-privileges/);

      // Chrome runs as a browser user, and its renderer in its own user and PID namespaces under seccomp, with no caps.
      let renderer: { uid: number; pid: number } | undefined;
      await eventually(() => {
        const processes = podman(['exec', CONTAINER, 'ps', '-eo', 'uid=,pid=,args=']).split('\n');
        assert.equal(processes.filter((line) => /--type=renderer\b/.test(line)).every((line) => !line.includes('--no-sandbox')), true, 'Chrome runs without --no-sandbox');
        const line = processes.find((entry) => /--type=renderer\b/.test(entry));
        if (!line) return false;
        const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)!;
        renderer = { uid: Number(match[1]), pid: Number(match[2]) };
        return true;
      });
      assert.ok(renderer, 'a renderer process runs');
      const { uid, pid } = renderer;
      assert.ok(uid >= 1101 && uid <= 1132, `the browser user is ${uid}`);
      const status = podman(['exec', CONTAINER, 'cat', `/proc/${pid}/status`]);
      assert.equal(Number.parseInt(/^Uid:\s+(\d+)/m.exec(status)?.[1] ?? '', 10), uid);
      const namespaces = /^NSpid:\s+(.+)$/m.exec(status)?.[1]?.trim().split(/\s+/).length ?? 0;
      assert.ok(namespaces >= 2, 'the renderer has its own PID namespace');
      assert.equal(Number.parseInt(/^Seccomp:\s+(\d+)/m.exec(status)?.[1] ?? '', 10), 2, 'the renderer runs under a seccomp filter');
      assert.equal(Number.parseInt(/^CapEff:\s+([0-9a-f]+)$/m.exec(status)?.[1] ?? '', 16), 0, 'the renderer holds no capabilities');
    } catch (error) {
      if (started) throw new Error(`${(error as Error).message}\n${podman(['logs', CONTAINER])}`, { cause: error });
      throw error;
    } finally {
      await client?.call('session_close').catch(() => undefined);
      await client?.close().catch(() => undefined);
      if (started) {
        try {
          podman(['rm', '-f', CONTAINER]);
        } catch {
          // The container may already be gone.
        }
      }
      try {
        podman(['rmi', '-f', IMAGE_TAG]);
      } catch {
        // The tag may never have been created.
      }
      await new Promise<void>((resolve) => site.close(() => resolve()));
      // Session directories belong to container users the host user cannot remove; a user-namespace root can.
      const cleaned = spawnSync('podman', ['unshare', 'rm', '-rf', '--', run], { env: PODMAN_ENV, encoding: 'utf8' });
      if (cleaned.status !== 0) await rm(run, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
