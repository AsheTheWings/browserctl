// Run a short command as a session's user, so file access in directories that user can write is decided by the
// kernel for that user, never by the server's root privileges.

import { spawn } from 'node:child_process';
import { BrowserctlError } from '../errors.ts';

export interface RunAsOptions {
  uid: number;
  gid: number;
  cwd: string;
  path: string;
  input?: Buffer;
  /** Fail once standard output exceeds this many bytes. */
  maxOutputBytes?: number;
}

export interface RunAsResult {
  status: number;
  output: Buffer;
  /** Whether output went past maxOutputBytes, which stops the command. */
  overflowed: boolean;
}

export function runAs(argv: [string, ...string[]], options: RunAsOptions): Promise<RunAsResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      uid: options.uid,
      gid: options.gid,
      cwd: options.cwd,
      env: { PATH: options.path, LANG: 'C.UTF-8' },
      stdio: [options.input ? 'pipe' : 'ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let overflowed = false;
    child.stdout!.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (options.maxOutputBytes !== undefined && size > options.maxOutputBytes) {
        overflowed = true;
        child.kill('SIGKILL');
        return;
      }
      chunks.push(chunk);
    });
    child.once('error', (error) => reject(new BrowserctlError('internal', `cannot run ${argv[0]}`, { cause: error })));
    child.once('close', (code) => resolve({ status: code ?? 1, output: Buffer.concat(chunks), overflowed }));
    if (options.input) {
      child.stdin!.on('error', () => undefined);
      child.stdin!.end(options.input);
    }
  });
}
