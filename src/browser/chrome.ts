// Managed Chrome processes: started as a browser user with their sandbox on, and with CDP only over a pipe.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { chmod, chown, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { promisify } from 'node:util';
import { BrowserctlError } from '../errors.ts';
import { CdpConnection, type CdpTransport } from './cdp.ts';

const execFileAsync = promisify(execFile);

export interface ChromeOptions {
  userDataDir: string;
  uid: number;
  gid: number;
  /** The browser user's home directory. */
  home: string;
  /** The browser user's temporary directory, where Chrome keeps its singleton socket. */
  temp: string;
  path: string;
  /** A headless CDP browser or a browser on an X display, optionally also controlled over CDP. */
  mode: { kind: 'pipe' } | { kind: 'display'; display: string; xauthority: string; pipe: boolean };
  windowSize: { width: number; height: number };
  /** Optional PAC URL for per-session loopback proxying. */
  proxyPacUrl?: string;
  /** Optional PEM-encoded CA certificate installed into the browser user's NSS trust store before launch. */
  extraCaCertFile?: string;
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
    ...(options.proxyPacUrl ? [`--proxy-pac-url=${options.proxyPacUrl}`, '--proxy-bypass-list=<-loopback>'] : []),
  ];
  if (options.mode.kind === 'pipe') return ['--remote-debugging-pipe', '--headless', ...common, 'about:blank'];
  return [...(options.mode.pipe ? ['--remote-debugging-pipe'] : []), ...common, '--window-position=0,0', 'about:blank'];
}

async function installExtraCaCert(options: Pick<ChromeOptions, 'home' | 'uid' | 'gid' | 'path'>, caCertFile: string): Promise<void> {
  const pkiDir = join(options.home, '.pki');
  const nssdb = join(pkiDir, 'nssdb');
  const db = `sql:${nssdb}`;
  const execOptions = { env: { HOME: options.home, PATH: options.path, LANG: 'C.UTF-8' }, timeout: 10_000 };
  try {
    await mkdir(nssdb, { recursive: true, mode: 0o700 });
    await execFileAsync('certutil', ['-d', db, '-N', '--empty-password'], execOptions);
    await execFileAsync('certutil', ['-d', db, '-A', '-t', 'C,,', '-n', 'browserctl-extra-ca', '-i', caCertFile], execOptions);
    await chown(pkiDir, options.uid, options.gid);
    await chmod(pkiDir, 0o700);
    await chown(nssdb, options.uid, options.gid);
    await chmod(nssdb, 0o700);
    for (const entry of await readdir(nssdb)) {
      const target = join(nssdb, entry);
      await chown(target, options.uid, options.gid);
      await chmod(target, 0o600);
    }
  } catch (error) {
    throw new BrowserctlError('browser_failed', 'cannot install the extra CA certificate', { cause: error });
  }
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
  if (options.extraCaCertFile) await installExtraCaCert(options, options.extraCaCertFile);
  const environment: Record<string, string> = { HOME: options.home, TMPDIR: options.temp, PATH: options.path, LANG: 'C.UTF-8' };
  if (options.mode.kind === 'display') {
    environment.DISPLAY = options.mode.display;
    environment.XAUTHORITY = options.mode.xauthority;
  }
  const pipe = options.mode.kind === 'pipe' || options.mode.pipe;
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
