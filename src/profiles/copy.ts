// Copies of profile directories that leave out Chrome's caches and its Singleton* lock files.

import { chown, cp, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Chrome's cache directories, at the profile root or inside a profile such as Default/. */
export const CACHE_DIRECTORIES = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GrShaderCache',
  'GraphiteDawnCache',
  'ShaderCache',
  'component_crx_cache',
  'extensions_crx_cache',
]);

/** Whether a path inside a profile is volatile: a cache directory, a Singleton* file, or DevToolsActivePort. */
export function isVolatile(relative: string): boolean {
  const name = relative.split('/').pop() ?? '';
  return CACHE_DIRECTORIES.has(name) || name.startsWith('Singleton') || name === 'DevToolsActivePort';
}

/** Copy a profile directory's contents into an existing directory, leaving out volatile files. Symbolic links are
 * copied as links and never followed. */
export async function copyProfile(from: string, to: string): Promise<void> {
  for (const name of await readdir(from)) {
    if (isVolatile(name)) continue;
    await cp(join(from, name), join(to, name), {
      recursive: true,
      verbatimSymlinks: true,
      errorOnExist: true,
      filter: (source) => !isVolatile(source.slice(from.length + 1)),
    });
  }
}

/** Give a directory tree to a user without following symbolic links. */
export async function chownTree(path: string, uid: number, gid: number): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) return;
  await chown(path, uid, gid);
  if (!stat.isDirectory()) return;
  for (const name of await readdir(path)) {
    await chownTree(join(path, name), uid, gid);
  }
}
