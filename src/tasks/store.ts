// Persisted tasks: each a name, immutable e2e test file revisions attributed to their clients, and one replay cache.
//
//   <state>/tasks/<name>/task.json           metadata, replaced by atomic rename
//   <state>/tasks/<name>/revisions/<id>.e2e.ts  one revision's test file, never changed after it is written
//   <state>/tasks/<name>/cache/              the task's replay cache, replaced whole after each run

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BrowserctlError } from '../errors.ts';
import { Serializer, readJson, writeAtomic, writeJson } from '../state/files.ts';

export const TASK_NAME = /^[a-z][a-z0-9-]{0,62}$/;
export const MAX_TASK_BYTES = 1024 * 1024;

export interface TaskRevision {
  id: string;
  createdAt: string;
  client: string;
  sha256: string;
  bytes: number;
}

export interface Task {
  name: string;
  createdAt: string;
  revisions: TaskRevision[];
}

/** A cache file: a relative path inside the cache and its content. */
export interface CacheFile {
  path: string;
  content: Buffer;
}

export class TaskStore {
  readonly #root: string;
  readonly #locks = new Map<string, Serializer>();

  constructor(stateDirectory: string) {
    this.#root = join(stateDirectory, 'tasks');
  }

  #lock(name: string): Serializer {
    let lock = this.#locks.get(name);
    if (!lock) this.#locks.set(name, (lock = new Serializer()));
    return lock;
  }

  #directory(name: string): string {
    if (typeof name !== 'string' || !TASK_NAME.test(name)) {
      throw new BrowserctlError('invalid_request', 'a task name is lower-case letters, digits, and hyphens');
    }
    return join(this.#root, name);
  }

  async list(): Promise<Task[]> {
    let names: string[];
    try {
      names = await readdir(this.#root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const tasks: Task[] = [];
    for (const name of names.filter((entry) => TASK_NAME.test(entry)).sort()) {
      const task = await readJson<Task>(join(this.#root, name, 'task.json'));
      if (task) tasks.push(task);
    }
    return tasks;
  }

  async get(name: string): Promise<Task> {
    const task = await readJson<Task>(join(this.#directory(name), 'task.json'));
    if (!task) throw new BrowserctlError('not_found', `no task ${name}`);
    return task;
  }

  /** A revision's test file, the latest when no revision is given. */
  async read(name: string, revision?: string): Promise<{ revision: TaskRevision; content: string }> {
    const task = await this.get(name);
    const entry = revision === undefined ? task.revisions.at(-1) : task.revisions.find((candidate) => candidate.id === revision);
    if (!entry) throw new BrowserctlError('not_found', `task ${name} has no revision ${revision}`);
    const content = await readFile(join(this.#directory(name), 'revisions', `${entry.id}.e2e.ts`), 'utf8');
    return { revision: entry, content };
  }

  /** Store a test file as the task's new latest revision, creating the task when it is new. */
  async save(name: string, content: unknown, client: string): Promise<TaskRevision> {
    const directory = this.#directory(name);
    if (typeof content !== 'string' || content.length === 0) throw new BrowserctlError('invalid_request', 'a task is the text of an e2e test file');
    const bytes = Buffer.byteLength(content);
    if (bytes > MAX_TASK_BYTES) throw new BrowserctlError('invalid_request', `a task is at most ${MAX_TASK_BYTES} bytes`);
    return this.#lock(name).run(async () => {
      const task = (await readJson<Task>(join(directory, 'task.json'))) ?? { name, createdAt: new Date().toISOString(), revisions: [] };
      const id = String(Math.max(0, ...task.revisions.map((revision) => Number(revision.id))) + 1);
      const revision: TaskRevision = { id, createdAt: new Date().toISOString(), client, sha256: createHash('sha256').update(content).digest('hex'), bytes };
      await mkdir(join(directory, 'revisions'), { recursive: true, mode: 0o700 });
      await writeAtomic(join(directory, 'revisions', `${id}.e2e.ts`), content);
      task.revisions.push(revision);
      await writeJson(join(directory, 'task.json'), task);
      return revision;
    });
  }

  /** The task's replay cache files. */
  async cache(name: string): Promise<CacheFile[]> {
    const root = join(this.#directory(name), 'cache');
    const files: CacheFile[] = [];
    let entries: string[];
    try {
      entries = await readdir(root, { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    for (const path of entries.sort()) {
      const content = await readFile(join(root, path)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'EISDIR') return undefined;
        throw error;
      });
      if (content) files.push({ path, content });
    }
    return files;
  }

  /** Replace the task's replay cache whole, so a reader sees the old cache or the new one. */
  async replaceCache(name: string, files: CacheFile[]): Promise<void> {
    const directory = this.#directory(name);
    return this.#lock(name).run(async () => {
      const staging = join(directory, `.cache-${randomBytes(4).toString('hex')}`);
      const old = join(directory, `.cache-old-${randomBytes(4).toString('hex')}`);
      await mkdir(staging, { mode: 0o700 });
      try {
        for (const file of files) {
          const path = join(staging, file.path);
          await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          await writeFile(path, file.content, { mode: 0o600 });
        }
        await rename(join(directory, 'cache'), old).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
        await rename(staging, join(directory, 'cache'));
      } finally {
        await rm(staging, { recursive: true, force: true });
        await rm(old, { recursive: true, force: true });
      }
    });
  }

  /** Remove the staging directories an interrupted cache replacement left behind. */
  async sweepLeftovers(): Promise<void> {
    for (const task of await this.list()) {
      const directory = this.#directory(task.name);
      for (const entry of await readdir(directory)) {
        if (entry.startsWith('.cache-')) await rm(join(directory, entry), { recursive: true, force: true });
      }
    }
  }
}
