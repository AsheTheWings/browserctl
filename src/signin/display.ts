// Sign-in browsers: Chrome headful on its own Xvfb display, without a window manager or any remote-debugging switch,
// and x11vnc serving that display only on a Unix socket in the session's directory. Every process runs as the
// session's browser user, and the display admits only clients holding its cookie.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, chown, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchChrome } from '../browser/chrome.ts';
import { BrowserctlError } from '../errors.ts';
import { WINDOW, type DisplayOpener, type SessionBrowser } from '../sessions/manager.ts';

const READY_TIMEOUT_MS = 15_000;
const EXIT_TIMEOUT_MS = 5_000;
/** Display numbers start here, one per user pair, clear of displays a host commonly uses. */
const DISPLAY_BASE = 100;

/** An Xauthority file holding one MIT-MAGIC-COOKIE-1 for every host (FamilyWild), so no hostname must match. */
export function xauthority(display: number, cookie: Buffer): Buffer {
  const field = (value: Buffer) => {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(value.length);
    return Buffer.concat([length, value]);
  };
  const family = Buffer.alloc(2);
  family.writeUInt16BE(0xffff);
  return Buffer.concat([family, field(Buffer.alloc(0)), field(Buffer.from(String(display))), field(Buffer.from('MIT-MAGIC-COOKIE-1')), field(cookie)]);
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

/** A sign-in browser: its Chrome, and the Unix socket its display's VNC server listens on. */
export interface DisplayBrowser extends SessionBrowser {
  vncSocket: string;
}

export function isDisplayBrowser(browser: SessionBrowser | undefined): browser is DisplayBrowser {
  return typeof (browser as DisplayBrowser | undefined)?.vncSocket === 'string';
}

export function displayOpener(path: string): DisplayOpener {
  return async (session) => {
    const { users, workspace } = session;
    const display = DISPLAY_BASE + users.index;
    const as = { uid: users.browserUid, gid: users.gid, home: workspace.browserHome, path };
    const authFile = join(workspace.root, 'xauthority');
    await writeFile(authFile, xauthority(display, randomBytes(16)), { mode: 0o600 });
    await chown(authFile, users.browserUid, users.gid);
    await chmod(authFile, 0o600);
    const vncSocket = join(workspace.browserTemp, 'vnc.sock');
    const started: Started[] = [];
    const stopAll = async () => {
      for (const process_ of [...started].reverse()) await stopGroup(process_);
    };
    try {
      // Only the abstract socket: no TCP, and no /tmp/.X11-unix file, which the container's /tmp may lack.
      const xvfb = start('Xvfb', [
        `:${display}`, '-nolisten', 'tcp', '-nolisten', 'unix', '-auth', authFile, '-noreset',
        '-screen', '0', `${WINDOW.width}x${WINDOW.height}x24`, '-displayfd', '3',
      ], { ...as, displayFd: true });
      started.push(xvfb);
      let announced = false;
      (xvfb.child.stdio[3] as NodeJS.ReadableStream).on('data', () => (announced = true));
      await ready(xvfb, async () => announced, 'the display');

      const vnc = start('x11vnc', [
        '-display', `:${display}`, '-auth', authFile, '-rfbport', '0', '-rfbportv6', '0', '-unixsock', vncSocket,
        '-nopw', '-forever', '-shared', '-quiet',
      ], as);
      started.push(vnc);
      await ready(vnc, () => stat(vncSocket).then((entry) => entry.isSocket(), () => false), 'the VNC server');

      const chrome = await launchChrome({
        userDataDir: workspace.profile,
        uid: users.browserUid,
        gid: users.gid,
        home: workspace.browserHome,
        temp: workspace.browserTemp,
        path,
        mode: { kind: 'display', display: `:${display}`, xauthority: authFile },
        windowSize: WINDOW,
      });
      const browser: DisplayBrowser = {
        cdp: undefined,
        pid: chrome.pid,
        vncSocket,
        exit: (timeoutMs) => chrome.requestExit(timeoutMs),
        async stop() {
          await chrome.requestExit(EXIT_TIMEOUT_MS);
          await chrome.kill();
          await stopAll();
        },
      };
      return browser;
    } catch (error) {
      await stopAll();
      throw error;
    }
  };
}
