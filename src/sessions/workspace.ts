// A session's directories under the session work directory, owned so that each user reads only its own.
//
//   <work>/<id>/                  server, 0711
//   <work>/<id>/profile/          browser user, 0700: Chrome's profile copy
//   <work>/<id>/browser-home/     browser user, 0700: Chrome's HOME
//   <work>/<id>/tmp/              browser user, 0700: Chrome's TMPDIR, short enough for its singleton socket
//   <work>/<id>/files/            session user and group, 0770: the file area the browser and session users share
//   <work>/<id>/files/uploads/    files session_file_put wrote
//   <work>/<id>/files/.downloads/ Chrome's downloads before Playwright saves them
//   <work>/<id>/session-home/     session user, 0700: the worker's and task runs' HOME and TMPDIR

import { chmod, chown, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { UserPair } from './users.ts';

/** Chrome keeps its singleton socket at <TMPDIR>/org.chromium.Chromium.XXXXXX/SingletonSocket and aborts when that
 * exceeds a Unix socket path (107 bytes), so the work directory may be at most this long. */
export const MAX_WORK_DIRECTORY_LENGTH = 107 - '/s-XXXXXXXXXXXX/tmp/org.chromium.Chromium.XXXXXX/SingletonSocket'.length;

/** A problem with the work directory's path, or undefined when Chrome can run under it. */
export function workDirectoryProblem(workDirectory: string): string | undefined {
  const length = Buffer.byteLength(workDirectory.replace(/\/+$/, ''));
  if (length <= MAX_WORK_DIRECTORY_LENGTH) return undefined;
  return `BROWSERCTL_WORK_DIRECTORY: ${length} bytes long; Chrome needs at most ${MAX_WORK_DIRECTORY_LENGTH}`;
}

/** The work directory's ancestors that the session users cannot pass through, which Chrome needs to reach its
 * session directories. */
export async function untraversableAncestors(workDirectory: string): Promise<string[]> {
  const blocked: string[] = [];
  for (let path = dirname(workDirectory); ; path = dirname(path)) {
    if (((await stat(path)).mode & 0o001) === 0) blocked.push(path);
    if (path === dirname(path)) return blocked;
  }
}

export interface Workspace {
  root: string;
  profile: string;
  browserHome: string;
  browserTemp: string;
  files: string;
  uploads: string;
  downloads: string;
  sessionHome: string;
}

export function workspacePaths(workDirectory: string, id: string): Workspace {
  const root = join(workDirectory, id);
  const files = join(root, 'files');
  return {
    root,
    profile: join(root, 'profile'),
    browserHome: join(root, 'browser-home'),
    browserTemp: join(root, 'tmp'),
    files,
    uploads: join(files, 'uploads'),
    downloads: join(files, '.downloads'),
    sessionHome: join(root, 'session-home'),
  };
}

async function directory(path: string, uid: number, gid: number, mode: number): Promise<void> {
  await mkdir(path, { mode });
  await chown(path, uid, gid);
  await chmod(path, mode);
}

export async function createWorkspace(workDirectory: string, id: string, users: UserPair): Promise<Workspace> {
  const paths = workspacePaths(workDirectory, id);
  await directory(paths.root, process.getuid?.() ?? 0, process.getgid?.() ?? 0, 0o711);
  await directory(paths.profile, users.browserUid, users.gid, 0o700);
  await directory(paths.browserHome, users.browserUid, users.gid, 0o700);
  await directory(paths.browserTemp, users.browserUid, users.gid, 0o700);
  await directory(paths.files, users.sessionUid, users.gid, 0o770);
  await directory(paths.uploads, users.sessionUid, users.gid, 0o770);
  await directory(paths.downloads, users.sessionUid, users.gid, 0o770);
  await directory(paths.sessionHome, users.sessionUid, users.gid, 0o700);
  return paths;
}

export async function removeWorkspace(workspace: Workspace): Promise<void> {
  await rm(workspace.root, { recursive: true, force: true, maxRetries: 3 });
}
