// State files: every metadata file is replaced by an atomic rename, and event records are appended as JSONL,
// so a plain copy of the state directory restores it.

import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';

/** Write a file under a temporary name in its directory, flush it, and rename it into place. */
export async function writeAtomic(path: string, data: string | Uint8Array, mode = 0o600): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(temporary, 'wx', mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  const parent = await open(directory, 'r');
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Read a JSON file, or undefined when it does not exist. */
export async function readJson<T>(path: string): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return JSON.parse(text) as T;
}

/** Append one record as a JSON line. */
export async function appendJsonl(path: string, record: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

/** Read every complete record of a JSONL file; a torn last line from an interrupted append is skipped. */
export async function readJsonl<T>(path: string): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records: T[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    try {
      records.push(JSON.parse(line) as T);
    } catch {
      // An interrupted append leaves a partial line; skip it.
    }
  }
  return records;
}

/** Serialize async work on one key, so read-modify-write of a state file never interleaves. */
export class Serializer {
  #tail: Promise<unknown> = Promise.resolve();
  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(work, work);
    this.#tail = next.catch(() => undefined);
    return next;
  }
}
