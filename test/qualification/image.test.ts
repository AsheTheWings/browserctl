// Qualification of the built image: the server runs under the container's exact capability set and
// no-new-privileges, Chrome is sandboxed as a browser user, a session opens and is driven over MCP, and the focused
// screencast follows an animating page near its full rate. Run with BROWSERCTL_QUALIFICATION_LAYOUT naming the OCI
// layout `scripts/image.sh build` wrote and BROWSERCTL_QUALIFICATION_REVISION naming its revision.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { CONTAINER_CAPABILITIES, CONTAINER_CAPABILITY_MASK } from '../../scripts/container.ts';
import { DEVELOPMENT_PASSWORD } from '../support/server.ts';
import { mcpClient, type TestClient } from '../support/mcp.ts';
import { eventually } from '../support/processes.ts';

const IMAGE_TAG = `localhost/browserctl-qualified:${randomBytes(6).toString('hex')}`;
const CONTAINER = `browserctl-qualification-${randomBytes(6).toString('hex')}`;
/**
 * The focused stream sends every frame Chrome paints, so it keeps up with the animating page; the grid's 5 frames
 * per second is far below this. The page and the focused stream must each stay near 60 frames per second, and the
 * stream must stay within five frames per second of the page, so a loaded host fails as too slow rather than
 * hiding a capped stream.
 */
const MIN_PAGE_FPS = 55;
const MIN_FOCUSED_FPS = 55;
const MIN_MEAN_FPS = 55;

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
window.__painted = 0;
(function draw() { window.__painted = ++frame; context.fillStyle = 'hsl(' + (frame % 360) + ', 80%, 50%)'; context.fillRect(0, 0, 1280, 720); requestAnimationFrame(draw); })();
</script>`;

async function pageSample(client: TestClient): Promise<{ painted: number; time: number }> {
  const evaluated = await client.call('browser_evaluate', {
    function: '() => ({ painted: window.__painted, time: performance.now() })',
  });
  assert.equal(evaluated.isError, false, evaluated.text);
  const result = /### Result\s*([\s\S]*?)\s*### Ran Playwright code/.exec(evaluated.text)?.[1] ?? evaluated.text;
  return JSON.parse(result);
}

/** Sample the page and the focused screencast during the same steady-state period. */
async function focusedRates(port: number, session: string, cookie: string, client: TestClient) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/dashboard/ws/screencast/${session}?stream=focused`, {
    headers: { cookie, origin: `http://127.0.0.1:${port}` },
  });
  const stamps: number[] = [];
  socket.on('message', (raw, isBinary) => {
    if (isBinary && (raw as Buffer)[0] === 0xff && (raw as Buffer)[1] === 0xd8) stamps.push(performance.now());
  });
  let recent: number[];
  let pageFps: number;
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    await eventually(() => stamps.length > 0, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const before = await pageSample(client);
    const start = stamps.length;
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    recent = stamps.slice(start);
    const after = await pageSample(client);
    assert.equal(socket.readyState, WebSocket.OPEN, 'the focused screencast stays open throughout the sample');
    pageFps = ((after.painted - before.painted) * 1000) / (after.time - before.time);
  } finally {
    socket.close();
  }
  if (recent.length < 2) return { pageFps, best: 0, mean: 0 };
  const mean = ((recent.length - 1) * 1000) / (recent.at(-1)! - recent[0]!);
  let best = 0;
  for (let first = 0; first < recent.length; first += 1) {
    let last = first;
    while (last + 1 < recent.length && recent[last + 1]! - recent[first]! < 2_000) last += 1;
    const span = recent[last]! - recent[first]!;
    if (span >= 1_500) best = Math.max(best, ((last - first) * 1000) / span);
  }
  return { pageFps, best, mean };
}

describe('built image', () => {
  it('runs the server, a sandboxed Chrome, an MCP session, and a focused screencast', async (t) => {
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
      const secret = join(run, 'dashboard-password');
      await writeFile(secret, DEVELOPMENT_PASSWORD, { mode: 0o600 });
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
        '-e', 'BROWSERCTL_DASHBOARD_PASSWORD_FILE=/run/dashboard-password',
        '-v', `${secret}:/run/dashboard-password:ro`,
        '-e', 'OTEL_TRACES_EXPORTER=none', '-e', 'OTEL_METRICS_EXPORTER=none', '-e', 'OTEL_LOGS_EXPORTER=none',
        '-e', 'BROWSERCTL_DEPLOYMENT_ENVIRONMENT=qualification',
        '-v', `${state}:/var/lib/browserctl/state`,
        '-v', `${work}:/var/lib/browserctl/work`,
        IMAGE_TAG,
      ]);
      started = true;
      await eventually(async () => (await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true, 60_000);

      const token = podman(['exec', CONTAINER, 'node', 'bin/browserctl.ts', 'admin', 'tokens', 'create', 'qualification']).trim();
      const build = JSON.parse(podman(['exec', CONTAINER, 'cat', 'build-info.json'])) as { version: string; revision: string };
      assert.deepEqual(build, { version: '0.0.0', revision }, 'the image carries its build');
      assert.equal(
        podman(['exec', CONTAINER, 'dpkg-query', '-W', '-f=${Status}', 'google-chrome-stable']).trim(),
        'install ok installed',
        'the runtime uses the regular Chrome Stable package',
      );
      client = await mcpClient(port, token);
      const guide = await client.client.readResource({ uri: 'browserctl://guides/tasks' });
      const guideText = guide.contents[0] && 'text' in guide.contents[0] ? guide.contents[0].text : '';
      assert.match(guideText, /^# Tasks/m, 'the image serves its task guide');
      assert.match(guideText, /browserctl:\/\/guides\/tasks/, 'the guide names its resource');
      const opened = await client.call('session_open', { ephemeral: true });
      assert.equal(opened.isError, false, opened.text);
      const session = opened.json().id as string;
      const navigated = await client.call('browser_navigate', { url: siteUrl });
      assert.equal(navigated.isError, false, navigated.text);

      const base = `http://127.0.0.1:${port}`;
      const signInPage = await fetch(base);
      assert.equal(signInPage.status, 200);
      assert.match(await signInPage.text(), /data-page="password"/);
      assert.equal((await fetch(`${base}/dashboard/api/state`)).status, 401);
      const login = await fetch(`${base}/dashboard/login`, {
        method: 'POST', headers: { origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({ password: DEVELOPMENT_PASSWORD }),
      });
      assert.equal(login.status, 204);
      const cookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
      const page = await fetch(`${base}/dashboard/`, { headers: { cookie } });
      assert.equal(page.status, 200);
      assert.match(await page.text(), /<title>browserctl<\/title>/);
      assert.equal((await fetch(`${base}/dashboard/novnc/core/rfb.js`)).status, 200);
      const { pageFps, best, mean } = await focusedRates(port, session, cookie, client);
      t.diagnostic(`FPS after warmup: page ${pageFps.toFixed(1)}, focused mean ${mean.toFixed(1)}, focused best ${best.toFixed(1)}`);
      assert.ok(pageFps >= MIN_PAGE_FPS, `the page painted at ${pageFps.toFixed(1)} frames per second`);
      assert.ok(
        best >= MIN_FOCUSED_FPS && mean >= MIN_MEAN_FPS && best >= pageFps - 5,
        `the focused screencast ran at ${best.toFixed(1)} frames per second (best two seconds) and ${mean.toFixed(1)} on average, against the page's ${pageFps.toFixed(1)}`,
      );

      // Exactly the container's capability set, read from the running server rather than its configuration.
      const serverLine = podman(['exec', CONTAINER, 'ps', '-eo', 'uid=,pid=,args='])
        .split('\n')
        .find((line) => /\bnode bin\/browserctl\.ts serve$/.test(line.trim()));
      assert.ok(serverLine, 'the server process runs');
      const serverPid = /^\s*\d+\s+(\d+)\s+/.exec(serverLine!)?.[1];
      const caps = /^CapEff:\s+([0-9a-f]+)$/m.exec(podman(['exec', CONTAINER, 'cat', `/proc/${serverPid}/status`]))?.[1];
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

      const dashboard = await client.call('browser_navigate', { url: base });
      assert.equal(dashboard.isError, false, dashboard.text);
      await eventually(async () => {
        const state = await client!.call('browser_evaluate', {
          function: `() => {
            const password = document.querySelector('[autocomplete="current-password"]');
            return password && getComputedStyle(password).fontFamily.startsWith('Poppins') &&
              document.fonts.check('14px Poppins') ? 'dashboard-form-ready' : null;
          }`,
        });
        return state.text.includes('"dashboard-form-ready"');
      }, 10_000);
      const submit = await client.call('browser_evaluate', {
        function: `() => {
          const password = document.querySelector('[autocomplete="current-password"]');
          password.value = ${JSON.stringify(DEVELOPMENT_PASSWORD)};
          password.form.requestSubmit();
        }`,
      });
      assert.equal(submit.isError, false, submit.text);
      await eventually(async () => {
        const state = await client!.call('browser_evaluate', {
          function: `() => document.querySelector('h1')?.textContent === 'Overview' &&
            document.querySelector('a[href="#recordings"]') &&
            document.querySelector('.sidebar-identity') ? 'dashboard-signed-in' : null`,
        });
        return state.text.includes('"dashboard-signed-in"');
      }, 10_000);

      const controls = await client.call('browser_evaluate', {
        function: `() => {
          const sidebar = document.querySelector('aside');
          return sidebar.querySelector('[aria-label="Sign out"]') &&
            sidebar.querySelector('[aria-label^="Switch to"]') &&
            sidebar.querySelector('button[aria-expanded]') === null ? 'dashboard-sidebar-controls' : null;
        }`,
      });
      assert.ok(controls.text.includes('"dashboard-sidebar-controls"'), controls.text);

      const resized = await client.call('browser_resize', { width: 1600, height: 900 });
      assert.equal(resized.isError, false, resized.text);
      const pointer = await client.call('browser_mouse_move_xy', { x: 800, y: 50 });
      assert.equal(pointer.isError, false, pointer.text);
      const sidebarLayout = async () => {
        const layout = await client!.call('browser_evaluate', {
          function: `() => {
            const sidebar = document.querySelector('aside');
            const nav = sidebar.querySelector('nav');
            const bounds = sidebar.getBoundingClientRect();
            const gap = document.querySelector('h1').getBoundingClientRect().left - bounds.right;
            const rows = Array.from(sidebar.querySelectorAll('nav a, nav svg, .sidebar-tools, .sidebar-tools button, .sidebar-tools svg'), row => {
              const { x, y, height } = row.getBoundingClientRect();
              return { x, y, height };
            });
            return { width: bounds.width, gap, navigationFits: nav.scrollWidth === nav.clientWidth, rows };
          }`,
        });
        assert.equal(layout.isError, false, layout.text);
        const result = /### Result\s*([\s\S]*?)\s*### Ran Playwright code/.exec(layout.text)?.[1] ?? layout.text;
        return JSON.parse(result) as {
          width: number; gap: number; navigationFits: boolean; rows: { x: number; y: number; height: number }[];
        };
      };
      const rail = await sidebarLayout();
      assert.ok(rail.gap > 0 && rail.gap <= 32, `the page starts next to the sidebar (gap: ${rail.gap}px)`);
      assert.ok(rail.navigationFits, 'the sidebar navigation fits within the rail');
      const hover = await client.call('browser_mouse_move_xy', { x: 28, y: 26 });
      assert.equal(hover.isError, false, hover.text);
      const expanded = await sidebarLayout();
      assert.ok(expanded.width > rail.width, 'hover expands the sidebar');
      assert.deepEqual(expanded.rows, rail.rows, 'navigation and footer keep their positions when the sidebar expands');
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
      try {
        podman(['rmi', '-f', `localhost/browserctl-build:${revision}`]);
      } catch {
        // The build image may already be gone.
      }
      await new Promise<void>((resolve) => site.close(() => resolve()));
      // Session directories belong to container users the host user cannot remove; a user-namespace root can.
      const cleaned = spawnSync('podman', ['unshare', 'rm', '-rf', '--', run], { env: PODMAN_ENV, encoding: 'utf8' });
      if (cleaned.status !== 0) await rm(run, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
