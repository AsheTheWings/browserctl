// Persisted browser profiles: a name, immutable snapshot revisions with one current, pins, and tracked services.
//
//   <state>/profiles/<name>/profile.json     metadata, replaced by atomic rename
//   <state>/profiles/<name>/revisions/<id>/  one revision's files, never changed after it is created

import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserctlError } from '../errors.ts';
import { Serializer, readJson, writeJson } from '../state/files.ts';
import { copyProfile } from './copy.ts';
import { revisionsToDelete } from './retention.ts';

export const PROFILE_NAME = /^[a-z][a-z0-9-]{0,62}$/;
export const SERVICE_NAME = /^[a-z][a-z0-9-]{0,62}$/;

export interface Revision {
  id: string;
  sequence: number;
  createdAt: string;
  client: string;
  pinned: boolean;
}

export interface ServiceCheck {
  result: 'signed_in' | 'signed_out';
  time: string;
  run: string;
}

export interface Service {
  name: string;
  /** The check task's name. */
  task: string;
  lastCheck?: ServiceCheck;
}

export interface Profile {
  name: string;
  createdAt: string;
  current: string;
  revisions: Revision[];
  services: Service[];
}

export class ProfileStore {
  readonly #root: string;
  readonly #locks = new Map<string, Serializer>();

  constructor(stateDirectory: string) {
    this.#root = join(stateDirectory, 'profiles');
  }

  #lock(name: string): Serializer {
    let lock = this.#locks.get(name);
    if (!lock) this.#locks.set(name, (lock = new Serializer()));
    return lock;
  }

  #directory(name: string): string {
    if (!PROFILE_NAME.test(name)) throw new BrowserctlError('invalid_request', 'a profile name is lower-case letters, digits, and hyphens');
    return join(this.#root, name);
  }

  revisionPath(name: string, id: string): string {
    if (!/^[0-9]{1,12}$/.test(id)) throw new BrowserctlError('invalid_request', 'a revision id is a number');
    return join(this.#directory(name), 'revisions', id);
  }

  async list(): Promise<Profile[]> {
    let names: string[];
    try {
      names = await readdir(this.#root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const profiles: Profile[] = [];
    for (const name of names.filter((entry) => PROFILE_NAME.test(entry)).sort()) {
      const profile = await readJson<Profile>(join(this.#root, name, 'profile.json'));
      if (profile) profiles.push(profile);
    }
    return profiles;
  }

  /** Remove the staging and deleted directories an interrupted revision or deletion left behind. */
  async sweepLeftovers(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.#root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const name of names) {
      if (name.startsWith('.deleted-')) await rm(join(this.#root, name), { recursive: true, force: true });
      else if (PROFILE_NAME.test(name)) {
        const revisions = join(this.#root, name, 'revisions');
        for (const entry of await readdir(revisions).catch(() => [] as string[])) {
          if (entry.startsWith('.staging-')) await rm(join(revisions, entry), { recursive: true, force: true });
        }
      }
    }
  }

  async get(name: string): Promise<Profile> {
    const profile = await readJson<Profile>(join(this.#directory(name), 'profile.json'));
    if (!profile) throw new BrowserctlError('not_found', `no profile ${name}`);
    return profile;
  }

  async #save(profile: Profile): Promise<void> {
    await writeJson(join(this.#directory(profile.name), 'profile.json'), profile);
  }

  /** Create a profile whose first revision is empty. */
  create(name: string, client: string): Promise<Profile> {
    return this.#lock(name).run(async () => {
      const directory = this.#directory(name);
      if (await readJson(join(directory, 'profile.json'))) throw new BrowserctlError('conflict', `profile ${name} exists`);
      await mkdir(join(directory, 'revisions', '1'), { recursive: true, mode: 0o700 });
      const createdAt = new Date().toISOString();
      const profile: Profile = {
        name,
        createdAt,
        current: '1',
        revisions: [{ id: '1', sequence: 1, createdAt, client, pinned: false }],
        services: [],
      };
      await this.#save(profile);
      return profile;
    });
  }

  /** Delete a profile; the caller checks that no session uses it. */
  delete(name: string): Promise<void> {
    return this.#lock(name).run(async () => {
      await this.get(name);
      const directory = this.#directory(name);
      const doomed = join(this.#root, `.deleted-${name}-${randomBytes(4).toString('hex')}`);
      await rename(directory, doomed);
      await rm(doomed, { recursive: true, force: true });
    });
  }

  /** Apply a change to a profile's metadata under its lock. */
  update(name: string, change: (profile: Profile) => void): Promise<Profile> {
    return this.#lock(name).run(async () => {
      const profile = await this.get(name);
      change(profile);
      await this.#save(profile);
      return profile;
    });
  }

  setPinned(name: string, id: string, pinned: boolean): Promise<Profile> {
    return this.update(name, (profile) => {
      const revision = profile.revisions.find((entry) => entry.id === id);
      if (!revision) throw new BrowserctlError('not_found', `no revision ${id}`);
      revision.pinned = pinned;
    });
  }

  setCurrent(name: string, id: string): Promise<Profile> {
    return this.update(name, (profile) => {
      if (!profile.revisions.some((entry) => entry.id === id)) throw new BrowserctlError('not_found', `no revision ${id}`);
      profile.current = id;
    });
  }

  addService(name: string, service: string, task: string): Promise<Profile> {
    if (!SERVICE_NAME.test(service)) throw new BrowserctlError('invalid_request', 'a service name is lower-case letters, digits, and hyphens');
    return this.update(name, (profile) => {
      if (profile.services.some((entry) => entry.name === service)) throw new BrowserctlError('conflict', `service ${service} exists`);
      profile.services.push({ name: service, task });
    });
  }

  removeService(name: string, service: string): Promise<Profile> {
    return this.update(name, (profile) => {
      if (!profile.services.some((entry) => entry.name === service)) throw new BrowserctlError('not_found', `no service ${service}`);
      profile.services = profile.services.filter((entry) => entry.name !== service);
    });
  }

  /** Copy the profile's current revision, without volatile files, into an existing empty directory. */
  async copyCurrent(name: string, destination: string): Promise<string> {
    return this.#lock(name).run(async () => {
      const profile = await this.get(name);
      await copyProfile(this.revisionPath(name, profile.current), destination);
      return profile.current;
    });
  }

  /** Copy a directory into a new revision, make it current, and apply retention. */
  addRevision(name: string, source: string, client: string): Promise<Revision> {
    return this.#lock(name).run(async () => {
      const profile = await this.get(name);
      const sequence = Math.max(0, ...profile.revisions.map((revision) => revision.sequence)) + 1;
      const id = String(sequence);
      const revisions = join(this.#directory(name), 'revisions');
      const staging = join(revisions, `.staging-${randomBytes(4).toString('hex')}`);
      await mkdir(staging, { mode: 0o700 });
      try {
        await copyProfile(source, staging);
        await rename(staging, join(revisions, id));
      } catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error;
      }
      const revision: Revision = { id, sequence, createdAt: new Date().toISOString(), client, pinned: false };
      profile.revisions.push(revision);
      profile.current = id;
      const doomed = revisionsToDelete(profile.revisions, profile.current);
      profile.revisions = profile.revisions.filter((entry) => !doomed.includes(entry.id));
      await this.#save(profile);
      for (const old of doomed) await rm(join(revisions, old), { recursive: true, force: true });
      return revision;
    });
  }
}
