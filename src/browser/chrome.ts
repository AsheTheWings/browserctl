// Managed Chrome processes: started as a browser user with their sandbox on, and with CDP only over a pipe.

import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { BrowserctlError } from '../errors.ts';
import { CdpConnection, type CdpTransport } from './cdp.ts';

export interface ChromeOptions {
  userDataDir: string;
  uid: number;
  gid: number;
  /** The browser user's home directory. */
  home: string;
  /** The browser user's temporary directory, where Chrome keeps its singleton socket. */
  temp: string;
  path: string;
  /** Headless with CDP over the pipe, or headful on an X display without any remote-debugging switch. */
  mode: { kind: 'pipe' } | { kind: 'display'; display: string; xauthority: string };
  windowSize: { width: number; height: number };
}

export interface ChromeProcess {
  pid: number;
  /** The pipe CDP connection; absent for a Chrome without remote debugging. */
  cdp: CdpConnection | undefined;
  exited: Promise<void>;
  /** Ask Chrome to quit gracefully: Browser.close over the pipe, or SIGINT. Resolves whether it exited in time. */
  requestExit(timeoutMs: number): Promise<boolean>;
  /** Kill Chrome's whole process group. */
  kill(): Promise<void>;
}

export function chromeArguments(options: ChromeOptions): string[] {
  const { width, height } = options.windowSize;
  const common = [
    `--user-data-dir=${options.userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--password-store=basic',
    '--disable-dev-shm-usage',
    `--window-size=${width},${height}`,
  ];
  if (options.mode.kind === 'pipe') return ['--remote-debugging-pipe', '--headless', ...common, 'about:blank'];
  return [...common, '--window-position=0,0', 'about:blank'];
}

/** Wraps Chrome's --remote-debugging-pipe file descriptors: NUL-terminated JSON in each direction. */
function pipeTransport(input: Writable, output: Readable): CdpTransport {
  const listeners: Array<(text: string) => void> = [];
  const closers: Array<() => void> = [];
  let buffer = '';
  output.setEncoding('utf8');
  output.on('data', (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const text = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      for (const listener of listeners) listener(text);
    }
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const closer of closers) closer();
  };
  output.on('close', close);
  output.on('error', close);
  input.on('error', close);
  return {
    send: (text) => {
      if (!closed) input.write(`${text}\0`);
    },
    onMessage: (listener) => listeners.push(listener),
    onClose: (listener) => closers.push(listener),
    close: () => {
      input.end();
      close();
    },
  };
}

export async function launchChrome(options: ChromeOptions): Promise<ChromeProcess> {
  const environment: Record<string, string> = { HOME: options.home, TMPDIR: options.temp, PATH: options.path, LANG: 'C.UTF-8' };
  if (options.mode.kind === 'display') {
    environment.DISPLAY = options.mode.display;
    environment.XAUTHORITY = options.mode.xauthority;
  }
  const pipe = options.mode.kind === 'pipe';
  let child: ChildProcess;
  try {
    child = spawn('chrome', chromeArguments(options), {
      uid: options.uid,
      gid: options.gid,
      env: environment,
      cwd: options.home,
      detached: true,
      stdio: pipe ? ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] : ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    throw new BrowserctlError('browser_failed', 'the browser could not be started');
  }
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
  const pid = child.pid;
  if (pid === undefined) {
    await exited;
    throw new BrowserctlError('browser_failed', 'the browser could not be started');
  }
  const cdp = pipe ? new CdpConnection(pipeTransport(child.stdio[3] as Writable, child.stdio[4] as Readable)) : undefined;
  let done = false;
  void exited.then(() => {
    done = true;
  });
  const kill = async () => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // The group is gone.
    }
    await exited;
  };
  const process_: ChromeProcess = {
    pid,
    cdp,
    exited,
    async requestExit(timeoutMs) {
      if (done) return true;
      if (cdp && !cdp.closed) void cdp.exchange({ method: 'Browser.close' });
      // SIGINT is Chrome's graceful quit, which flushes the profile; SIGTERM takes a session-ending path that
      // exits without writing pending cookie changes.
      else child.kill('SIGINT');
      const timer = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs).unref());
      return Promise.race([exited.then(() => true), timer]);
    },
    kill,
  };
  if (cdp) {
    try {
      await Promise.race([
        cdp.call('Browser.getVersion'),
        exited.then(() => {
          throw new BrowserctlError('browser_failed', 'the browser exited while starting');
        }),
        new Promise((_, reject) => setTimeout(() => reject(new BrowserctlError('browser_failed', 'the browser did not start in time')), 30_000).unref()),
      ]);
    } catch (error) {
      await kill();
      throw error;
    }
  }
  return process_;
}
