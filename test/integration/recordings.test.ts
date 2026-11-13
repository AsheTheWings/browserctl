// Recordings with real browsers and ffmpeg, as container root in the image: agent and check sessions are recorded as
// H.264 MP4 at most 10 frames per second and 960 pixels wide; sign-in sessions are not recorded.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { BrowserctlServer } from '../../src/server/server.ts';
import type { Purpose, Session } from '../../src/sessions/manager.ts';
import { visit } from '../support/browser.ts';
import { eventually } from '../support/processes.ts';
import { runDirectory, testConfig } from '../support/server.ts';

assert.equal(process.getuid?.(), 0, 'integration tests run as root in the image: node scripts/test.ts integration');

const ORIGIN = 'http://browserctl.example:8443';
/**
 * A page that repaints ten times a second. It is small and slow enough that a loaded runner still feeds the
 * screencast; the recording's frame rate, not the page's, sets the video's rate.
 */
const ANIMATED = `<!doctype html><title>animated</title><canvas id="c" width="640" height="360"></canvas><script>
const context = document.getElementById('c').getContext('2d');
let frame = 0;
setInterval(() => { context.fillStyle = 'hsl(' + (frame++ % 360) + ', 80%, 50%)'; context.fillRect(0, 0, 640, 360); }, 100);
</script>`;

interface Probe {
  streams: Array<{ codec_name: string; width: number; height: number; r_frame_rate: string; avg_frame_rate: string }>;
  format: { format_name: string; duration: string };
}

function ffprobe(path: string): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,r_frame_rate,avg_frame_rate', '-show_entries', 'format=format_name,duration', '-of', 'json', path], { stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve(JSON.parse(output) as Probe) : reject(new Error(`ffprobe exited ${code}`))));
  });
}

describe('recordings', () => {
  let run: Awaited<ReturnType<typeof runDirectory>>;
  let server: BrowserctlServer;
  let site: ReturnType<typeof createServer>;
  let siteUrl: string;
  let cookie: string;

  before(async () => {
    run = await runDirectory();
    server = new BrowserctlServer(testConfig(run.path, { publicBaseUrl: ORIGIN }));
    await server.start();
    await server.tokens.create('operator');
    const login = await fetch(`http://127.0.0.1:${server.port}/dashboard/login?token=${server.dashboardAuth.link('operator')}`, { redirect: 'manual' });
    cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    site = createServer((_request, response) => response.writeHead(200, { 'content-type': 'text/html' }).end(ANIMATED));
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  });

  after(async () => {
    await server.stop();
    await new Promise<void>((resolve) => site.close(() => resolve()));
    await run.remove();
  });

  /** Wait until the session's screencast has delivered count frames to a grid viewer, about count / 5 seconds. */
  const paint = (session: Session, count: number) =>
    new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/dashboard/ws/screencast/${session.id}?stream=grid`, { headers: { cookie, origin: ORIGIN } });
      let seen = 0;
      let done = false;
      const fail = (error: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(error);
      };
      let first: number | undefined;
      const timer = setTimeout(() => fail(new Error(`only ${seen} of ${count} frames arrived; the session is ${session.state}`)), 60_000);
      ws.on('message', () => {
        first ??= performance.now();
        if (++seen < count) return;
        done = true;
        clearTimeout(timer);
        ws.close();
        resolve(first!);
      });
      ws.once('error', (error) => fail(error));
      ws.once('unexpected-response', (_request, response) => fail(new Error(`the screencast upgrade was refused with ${response.statusCode}`)));
      ws.once('close', (code) => fail(new Error(`the screencast closed with ${code} after ${seen} of ${count} frames`)));
    });

  async function recordSession(client: string, purpose: Purpose): Promise<{ session: Session; elapsedMs: number; paintedMs: number }> {
    const session = await server.sessions.open(client, { kind: 'ephemeral' }, purpose);
    const opened = performance.now();
    let first = opened;
    try {
      await visit(session, siteUrl);
      first = await paint(session, 5);
    } finally {
      await server.sessions.close(session, 'closed');
    }
    const closed = performance.now();
    await eventually(() => server.recordings.list().some((recording) => recording.session === session.id && !recording.active), 40_000);
    // A recording starts with its first painted frame, so it covers the painted period rather than browser startup.
    return { session, elapsedMs: closed - opened, paintedMs: closed - first };
  }

  it('records an agent session as H.264 MP4 at 10 frames per second within 960 pixels', async () => {
    const { session, elapsedMs, paintedMs } = await recordSession('agent-a', 'agent');
    const recording = server.recordings.list().find((entry) => entry.session === session.id)!;
    assert.deepEqual([recording.client, recording.purpose, recording.source], ['agent-a', 'agent', 'ephemeral']);
    const path = server.recordings.videoPath(session.id)!;
    assert.equal(path, join(server.config.recordingsDirectory, `${session.id}.mp4`));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const probe = await ffprobe(path);
    const [video] = probe.streams;
    assert.equal(video!.codec_name, 'h264');
    assert.ok(video!.width <= 960, `width ${video!.width}`);
    assert.equal(video!.r_frame_rate, '10/1');
    assert.match(probe.format.format_name, /mp4/);
    const seconds = Number(probe.format.duration);
    assert.ok(
      seconds >= paintedMs / 1000 - 1 && seconds <= elapsedMs / 1000 + 1,
      `the video covers the painted period of ${(paintedMs / 1000).toFixed(1)} s of ${(elapsedMs / 1000).toFixed(1)} s: ${seconds} s`,
    );

    const served = await fetch(`http://127.0.0.1:${server.port}/dashboard/api/recordings/${session.id}/video`, { headers: { cookie, range: 'bytes=0-7' } });
    assert.equal(served.status, 206);
    assert.equal(Buffer.from(await served.arrayBuffer()).subarray(4, 8).toString(), 'ftyp');
  });

  it('records a check session', async () => {
    const { session } = await recordSession('checker', 'check');
    const recording = server.recordings.list().find((entry) => entry.session === session.id)!;
    assert.equal(recording.purpose, 'check');
    assert.equal((await ffprobe(server.recordings.videoPath(session.id)!)).streams[0]!.codec_name, 'h264');
  });

  it('never records a sign-in session', async () => {
    await server.profiles.create('unrecorded', 'operator');
    const session = await server.sessions.open('operator', { kind: 'profile', profile: 'unrecorded' }, 'sign_in');
    try {
      assert.equal(server.screencasts.forSession(session), undefined, 'a sign-in session has no screencast');
    } finally {
      await server.sessions.close(session, 'closed');
    }
    assert.equal(server.recordings.list().some((recording) => recording.session === session.id), false);
    assert.deepEqual((await readdir(server.config.recordingsDirectory)).filter((name) => name.startsWith(session.id)), []);
  });
});
