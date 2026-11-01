// File transfer between an MCP client and a session's file area. The session user reads and writes the files, so
// a name or a link inside the area cannot reach anything that user could not.

import { posix } from 'node:path';
import { BrowserctlError } from '../errors.ts';
import { runAs } from './run-as.ts';
import type { Session } from './manager.ts';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** A relative name inside an area, or a refusal: no absolute path, no `..`, no empty or hidden-control segment. */
export function areaName(name: unknown): string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 1024 || name.includes('\0')) {
    throw new BrowserctlError('invalid_request', 'a file name is required');
  }
  const normalized = posix.normalize(name);
  if (posix.isAbsolute(name) || normalized === '.' || normalized.split('/').some((segment) => segment === '..' || segment === '')) {
    throw new BrowserctlError('invalid_request', `${name}: names must stay inside the session's file area`);
  }
  return normalized;
}

function asSessionUser(session: Session, path: string) {
  return { uid: session.users.sessionUid, gid: session.users.gid, cwd: session.workspace.files, path };
}

/** Write a file into the session's upload area; returns its path in the file area. */
export async function putFile(session: Session, name: unknown, base64: unknown, path: string): Promise<{ path: string; bytes: number }> {
  const relative = areaName(name);
  if (relative.includes('/')) throw new BrowserctlError('invalid_request', `${relative}: upload names have no directories`);
  if (typeof base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new BrowserctlError('invalid_request', 'content_base64 must be base64');
  }
  if (Math.floor((base64.length * 3) / 4) > MAX_FILE_BYTES + 2) throw tooLarge();
  const content = Buffer.from(base64, 'base64');
  if (content.length > MAX_FILE_BYTES) throw tooLarge();
  const target = posix.join('uploads', relative);
  const result = await runAs(['sh', '-c', 'umask 007 && cat > "$1"', 'sh', target], { ...asSessionUser(session, path), input: content });
  if (result.status !== 0) throw new BrowserctlError('invalid_request', `${target}: cannot be written`);
  return { path: target, bytes: content.length };
}

/** Read a file of the session's file area. */
export async function getFile(session: Session, name: unknown, path: string): Promise<{ path: string; content: Buffer }> {
  const relative = areaName(name);
  // A link inside the area may point anywhere; only a regular file whose real path stays inside is read.
  const script = 'r=$(realpath -e -- "$2") && p=$(realpath -e -- "$1") || exit 1; case "$p" in "$r"/*) test -f "$p" && exec cat -- "$p";; esac; exit 1';
  const result = await runAs(['sh', '-c', script, 'sh', relative, session.workspace.files], {
    ...asSessionUser(session, path),
    maxOutputBytes: MAX_FILE_BYTES,
  });
  if (result.overflowed) throw tooLarge();
  if (result.status !== 0) throw new BrowserctlError('not_found', `${relative}: no such file in the session's file area`);
  return { path: relative, content: result.output };
}

function tooLarge(): BrowserctlError {
  return new BrowserctlError('invalid_request', `files are limited to ${MAX_FILE_BYTES} bytes`);
}
