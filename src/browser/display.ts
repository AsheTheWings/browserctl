// A headful browser on its own Xvfb display with either interactive VNC or a live video encoder.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, chown, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { launchChrome } from './chrome.ts';
import { startProxyRouter, type ProxyRouter } from './loopback-proxy.ts';
import { BrowserctlError } from '../errors.ts';
import { chromeBrowser, type DisplayOpener, type SessionBrowser } from '../sessions/manager.ts';

const READY_TIMEOUT_MS = 15_000;
const FULL_WINDOW = { width: 1920, height: 1080 };
const WINDOW_FPS = 30;
/** One private X11 cookie whose record matches the display number Xvfb allocates. */
function xauthority(cookie: Buffer): Buffer {
  const field = (value: Buffer) => {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(value.length);
    return Buffer.concat([length, value]);
  };
  const family = Buffer.alloc(2);
  family.writeUInt16BE(0xffff);
  return Buffer.concat([family, field(Buffer.alloc(0)), field(Buffer.alloc(0)), field(Buffer.from('MIT-MAGIC-COOKIE-1')), field(cookie)]);
}

interface Started {
  child: ChildProcess;
  exited: Promise<void>;
}

interface StartOptions {
  uid: number;
  gid: number;
  home: string;
  path: string;
  /** Give the process a pipe on fd 3, for Xvfb's -displayfd. */
  displayFd?: boolean;
}

function start(command: string, args: string[], options: StartOptions): Started {
  const child = spawn(command, args, {
    uid: options.uid,
    gid: options.gid,
    cwd: options.home,
    detached: true,
    env: { HOME: options.home, PATH: options.path, LANG: 'C.UTF-8' },
    stdio: options.displayFd ? ['ignore', 'ignore', 'ignore', 'pipe'] : ['ignore', 'ignore', 'ignore'],
  });
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
  return { child, exited };
}

async function stopGroup(started: Started): Promise<void> {
  const pid = started.child.pid;
  if (pid !== undefined) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // The group is gone.
    }
  }
  await started.exited;
}

/** Resolve once a condition holds; fail when the deadline passes or the process exits first. */
async function ready(started: Started, condition: () => Promise<boolean>, what: string): Promise<void> {
  let exited = false;
  void started.exited.then(() => (exited = true));
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!(await condition())) {
    if (exited || Date.now() > deadline) throw new BrowserctlError('browser_failed', `${what} did not start`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** A sign-in browser: its Chrome, and either a local VNC Unix socket or a remote authenticated VNC endpoint. */
export interface DisplayBrowser extends SessionBrowser {
  vncSocket?: string;
  vncRemote?: () => { url: string; headers: Record<string, string> };
}

export function isDisplayBrowser(browser: SessionBrowser | undefined): browser is DisplayBrowser {
  const candidate = browser as DisplayBrowser | undefined;
  return typeof candidate?.vncSocket === 'string' || typeof candidate?.vncRemote === 'function';
}

export interface WindowStream {
  stream: Readable;
  stop(): void;
  onError(listener: () => void): void;
}

export interface WindowBrowser extends SessionBrowser {
  captureWindow(): WindowStream;
}

export function isWindowBrowser(browser: SessionBrowser | undefined): browser is WindowBrowser {
  return typeof (browser as WindowBrowser | undefined)?.captureWindow === 'function';
}

export interface TakeoverBrowser extends SessionBrowser {
  startVnc(): Promise<string>;
  stopVnc(): Promise<void>;
}

export function isTakeoverBrowser(browser: SessionBrowser | undefined): browser is TakeoverBrowser {
  const candidate = browser as TakeoverBrowser | undefined;
  return typeof candidate?.startVnc === 'function' && typeof candidate?.stopVnc === 'function';
}

export interface RecordingBrowser extends SessionBrowser {
  captureRecording(): WindowStream;
}

export function isRecordingBrowser(browser: SessionBrowser | undefined): browser is RecordingBrowser {
  return typeof (browser as RecordingBrowser | undefined)?.captureRecording === 'function';
}

function captureWindow(display: string, xauthority: string, options: StartOptions): WindowStream {
  const { width, height } = FULL_WINDOW;
  const encoder = spawn('ffmpeg', [
    '-nostdin', '-loglevel', 'error',
    '-f', 'x11grab', '-draw_mouse', '1', '-framerate', String(WINDOW_FPS), '-video_size', `${width}x${height}`, '-i', display,
    '-an', '-filter_threads', '1', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-threads', '2',
    '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '23', '-g', '15', '-keyint_min', '15', '-sc_threshold', '0',
    '-movflags', '+empty_moov+default_base_moof+frag_keyframe', '-frag_duration', '200000', '-f', 'mp4', 'pipe:1',
  ], {
    uid: options.uid, gid: options.gid, cwd: options.home,
    env: { HOME: options.home, PATH: options.path, LANG: 'C.UTF-8', XAUTHORITY: xauthority },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return {
    stream: encoder.stdout,
    stop: () => { encoder.kill('SIGKILL'); },
    onError: (listener) => {
      encoder.once('error', listener);
      encoder.once('close', listener);
      encoder.stdout.once('error', listener);
    },
  };
}

export function displayOpener(path: string, agent: boolean, extraCaCertFile?: string): DisplayOpener {
  return async (session) => {
    const { users, workspace } = session;
    const as = { uid: users.browserUid, gid: users.gid, home: workspace.browserHome, path };
    const authFile = join(workspace.root, 'xauthority');
    await writeFile(authFile, xauthority(randomBytes(16)), { mode: 0o600 });
    await chown(authFile, users.browserUid, users.gid);
    await chmod(authFile, 0o600);
    const vncSocket = join(workspace.browserTemp, 'vnc.sock');
    const started: Started[] = [];
    let router: ProxyRouter | undefined;
    let vnc: Started | undefined;
    let startingVnc: Promise<string> | undefined;
    let vncGeneration = 0;
    const stopVnc = async (): Promise<void> => {
      vncGeneration++;
      const active = vnc;
      vnc = undefined;
      if (active) await stopGroup(active);
      await rm(vncSocket, { force: true }).catch(() => undefined);
    };
    const stopAll = async () => {
      await stopVnc();
      if (router) {
        const activeRouter = router;
        router = undefined;
        await activeRouter.close().catch(() => undefined);
      }
      for (const process_ of [...started].reverse()) await stopGroup(process_);
    };
    try {
      // Only the abstract socket: no TCP, and no /tmp/.X11-unix file, which the container's /tmp may lack.
      const xvfb = start('Xvfb', [
        '-nolisten', 'tcp', '-nolisten', 'unix', '-auth', authFile, '-noreset',
        '-screen', '0', `${FULL_WINDOW.width}x${FULL_WINDOW.height}x24`, '-displayfd', '3',
      ], { ...as, displayFd: true });
      started.push(xvfb);
      let announcement = '';
      (xvfb.child.stdio[3] as NodeJS.ReadableStream).setEncoding('ascii').on('data', (chunk: string) => (announcement += chunk));
      await ready(xvfb, async () => /^\d+\n$/.test(announcement), 'the display');
      const display = `:${announcement.trim()}`;
      const startX11vnc = () => start('x11vnc', [
        '-display', display, '-auth', authFile, '-rfbport', '0', '-rfbportv6', '0', '-unixsock', vncSocket,
        '-nopw', '-forever', '-shared', '-quiet',
      ], as);

      if (!agent) {
        const signInVnc = startX11vnc();
        started.push(signInVnc);
        await ready(signInVnc, () => stat(vncSocket).then((entry) => entry.isSocket(), () => false), 'the VNC server');
      }

      const startVnc = async (): Promise<string> => {
        if (vnc && await stat(vncSocket).then((entry) => entry.isSocket(), () => false)) return vncSocket;
        if (startingVnc) return startingVnc;
        const generation = ++vncGeneration;
        const launch = (async () => {
          await rm(vncSocket, { force: true }).catch(() => undefined);
          const server = startX11vnc();
          vnc = server;
          void server.exited.then(() => {
            if (vnc === server) vnc = undefined;
          });
          try {
            await ready(server, () => stat(vncSocket).then((entry) => entry.isSocket(), () => false), 'the VNC server');
          } catch (error) {
            if (vnc === server) vnc = undefined;
            await stopGroup(server);
            await rm(vncSocket, { force: true }).catch(() => undefined);
            throw error;
          }
          if (vncGeneration !== generation) {
            if (vnc === server) vnc = undefined;
            await stopGroup(server);
            await rm(vncSocket, { force: true }).catch(() => undefined);
            throw new BrowserctlError('conflict', 'takeover was released while starting');
          }
          return vncSocket;
        })().finally(() => {
          if (startingVnc === launch) startingVnc = undefined;
        });
        startingVnc = launch;
        return launch;
      };

      if (agent && session.loopbackProxy) {
        router = await startProxyRouter({
          uid: users.browserUid,
          gid: users.gid,
          home: workspace.browserHome,
          path,
          port: session.loopbackProxy.port,
          upstreamHost: session.loopbackProxy.host,
          upstreamPort: session.loopbackProxy.port,
          hosts: session.loopbackProxy.hosts,
        });
      }

      const chrome = await launchChrome({
        userDataDir: workspace.profile,
        uid: users.browserUid,
        gid: users.gid,
        home: workspace.browserHome,
        temp: workspace.browserTemp,
        path,
        mode: { kind: 'display', display, xauthority: authFile, pipe: agent },
        windowSize: FULL_WINDOW,
        ...(router && { proxyServer: `http://${router.host}:${router.port}` }),
        ...(extraCaCertFile && { extraCaCertFile }),
      });
      const browser = chromeBrowser(chrome);
      const displayed = {
        ...browser,
        async stop() {
          try {
            await browser.stop();
          } finally {
            await stopAll();
          }
        },
      };
      return agent
        ? { ...displayed, captureWindow: () => captureWindow(display, authFile, as), startVnc, stopVnc }
        : { ...displayed, vncSocket };
    } catch (error) {
      await stopAll();
      throw error;
    }
  };
}
