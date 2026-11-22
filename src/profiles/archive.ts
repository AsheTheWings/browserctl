// Compressed profile revision archives for transferring host-managed profiles to and from compatible remote runtimes.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserctlError } from '../errors.ts';
import { copyProfile, isVolatile } from './copy.ts';

export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

function runTar(args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let total = 0;
    let stderr = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_ARCHIVE_BYTES) {
        child.kill('SIGKILL');
        reject(new BrowserctlError('provider_error', 'profile archive exceeds the size limit'));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      if (stderr.length < 1024) stderr += chunk.toString('utf8');
    });
    child.on('error', () => reject(new BrowserctlError('internal', 'cannot run tar')));
    child.on('exit', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new BrowserctlError('provider_error', `profile archive failed (${code})`));
    });
    if (input) {
      child.stdin!.on('error', () => undefined);
      child.stdin!.end(input);
    }
  });
}

async function hasContent(directory: string): Promise<boolean> {
  for (const name of await readdir(directory)) {
    if (!isVolatile(name)) return true;
  }
  return false;
}

/** Pack one revision directory into a gzipped tar archive without volatile files; returns undefined when empty. */
export async function packRevision(directory: string): Promise<{ archive: Buffer; sha256: string } | undefined> {
  if (!(await hasContent(directory))) return undefined;
  const staging = await mkdtemp(join(tmpdir(), 'browserctl-pack-'));
  try {
    await copyProfile(directory, staging);
    const archive = await runTar(['-czf', '-', '-C', staging, '.']);
    const sha256 = createHash('sha256').update(archive).digest('hex');
    return { archive, sha256 };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function stripVolatileTree(directory: string, prefix = ''): Promise<void> {
  for (const name of await readdir(directory)) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const full = join(directory, name);
    if (isVolatile(relative)) {
      await rm(full, { recursive: true, force: true });
      continue;
    }
    const info = await lstat(full);
    if (info.isDirectory()) await stripVolatileTree(full, relative);
  }
}

/** Verify digest and entry paths, then unpack a gzipped tar archive into an empty destination directory. */
export async function unpackRevision(archive: Buffer, expectedSha256: string, destination: string): Promise<void> {
  if (!SHA256.test(expectedSha256) || archive.length === 0 || archive.length > MAX_ARCHIVE_BYTES) {
    throw new BrowserctlError('provider_error', 'invalid profile archive metadata');
  }
  const actual = createHash('sha256').update(archive).digest('hex');
  if (actual !== expectedSha256) throw new BrowserctlError('provider_error', 'profile archive digest mismatch');
  const listing = (await runTar(['-tzf', '-'], archive)).toString('utf8');
  for (const raw of listing.split('\n')) {
    const entry = raw.trim();
    if (!entry) continue;
    const normalized = entry.replace(/^\.\//, '');
    if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
      throw new BrowserctlError('provider_error', 'profile archive contains an unsafe path');
    }
  }
  await runTar(['-xzf', '-', '-C', destination, '--no-same-owner', '--no-same-permissions'], archive);
  await stripVolatileTree(destination);
}
