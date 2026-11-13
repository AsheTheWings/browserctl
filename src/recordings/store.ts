// Session recordings in the recordings directory, one per recorded session:
//   <recordings>/<session>.json      who and what was recorded, and when it started and ended
//   <recordings>/<session>.mp4.part  the recording being written, a fragmented MP4 playable as far as it goes
//   <recordings>/<session>.mp4       the finished recording
// Recordings older than the maximum age go, then the oldest while the directory exceeds its cap.

import { readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomic } from '../state/files.ts';

export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_ID = /^s-[A-Za-z0-9_-]{12}$/;

export interface RecordingInfo {
  session: string;
  client: string;
  purpose: 'agent' | 'check';
  source: 'profile' | 'ephemeral' | 'provider';
  profile?: string;
  provider?: string;
  startedAt: string;
  endedAt?: string;
}

export interface Recording extends RecordingInfo {
  bytes: number;
  /** Still being written. */
  active: boolean;
}

/** How a recording ended: its description always follows, and a description that cannot be written is retried. */
export type FinishOutcome = 'finished' | 'description_failed';

function isInfo(value: unknown): value is RecordingInfo {
  const info = value as RecordingInfo;
  return typeof info === 'object' && info !== null && typeof info.session === 'string' && SESSION_ID.test(info.session)
    && typeof info.client === 'string' && (info.purpose === 'agent' || info.purpose === 'check')
    && ['profile', 'ephemeral', 'provider'].includes(info.source) && typeof info.startedAt === 'string'
    && (info.endedAt === undefined || typeof info.endedAt === 'string');
}

export class RecordingStore {
  readonly directory: string;
  readonly #capBytes: number;
  readonly #maxAgeMs: number;
  readonly #writeMetadata: (path: string, text: string) => Promise<void>;
  readonly #recordings = new Map<string, Recording>();

  constructor(
    directory: string,
    capBytes: number,
    options: { maxAgeMs?: number; writeMetadata?: (path: string, text: string) => Promise<void> } = {},
  ) {
    this.directory = directory;
    this.#capBytes = capBytes;
    this.#maxAgeMs = options.maxAgeMs ?? MAX_AGE_MS;
    this.#writeMetadata = options.writeMetadata ?? ((path, text) => writeAtomic(path, text));
  }

  #path(session: string, suffix: '.json' | '.mp4' | '.mp4.part'): string {
    if (!SESSION_ID.test(session)) throw new Error(`not a session id: ${session}`);
    return join(this.directory, `${session}${suffix}`);
  }

  /** Where a recording's video is written while it is active. */
  partPath(session: string): string {
    return this.#path(session, '.mp4.part');
  }

  /** The finished video of a listed recording. */
  videoPath(session: string): string | undefined {
    const recording = this.#recordings.get(session);
    return recording && !recording.active ? this.#path(session, '.mp4') : undefined;
  }

  /**
   * Index the directory. A recording a stopped server left active is finished as far as it was written; a video
   * without its description, or a description without its video, is removed. Returns the sessions whose missing end
   * time could not be written, which the next start writes again.
   */
  async load(): Promise<string[]> {
    this.#recordings.clear();
    const unrewritten: string[] = [];
    const names = new Set(await readdir(this.directory));
    for (const name of names) {
      // A temporary file from an interrupted atomic write.
      if (/^\..*\.tmp$/.test(name)) {
        await rm(join(this.directory, name), { force: true });
        continue;
      }
      const session = name.replace(/\.(json|mp4|mp4\.part)$/, '');
      if (!SESSION_ID.test(session) || this.#recordings.has(session)) continue;
      let info: unknown;
      try {
        info = names.has(`${session}.json`) ? JSON.parse(await readFile(this.#path(session, '.json'), 'utf8')) : undefined;
      } catch {
        info = undefined;
      }
      if (!isInfo(info) || info.session !== session) {
        await this.#remove(session);
        continue;
      }
      if (!names.has(`${session}.mp4`) && names.has(`${session}.mp4.part`)) await rename(this.#path(session, '.mp4.part'), this.#path(session, '.mp4'));
      let video;
      try {
        video = await stat(this.#path(session, '.mp4'));
      } catch {
        await this.#remove(session);
        continue;
      }
      if (!info.endedAt) {
        info.endedAt = video.mtime.toISOString();
        // The video is indexed either way; a description that cannot be rewritten is written at the next start.
        await this.#writeMetadata(this.#path(session, '.json'), `${JSON.stringify(info)}\n`).catch(() => void unrewritten.push(session));
      }
      this.#recordings.set(session, { ...info, bytes: video.size, active: false });
    }
    return unrewritten;
  }

  /** Recordings, newest first. */
  list(): Recording[] {
    return [...this.#recordings.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Describe a recording about to be written to its part path. */
  async begin(info: RecordingInfo): Promise<void> {
    await this.#writeMetadata(this.#path(info.session, '.json'), `${JSON.stringify(info)}\n`);
    this.#recordings.set(info.session, { ...info, bytes: 0, active: true });
  }

  /**
   * Finish a recording once its video is written. The video's rename settles the recording even when its description
   * cannot be rewritten, and the next start rewrites the end time then. A recording with no video at all is removed.
   */
  async finish(session: string, endedAt: Date): Promise<FinishOutcome> {
    const recording = this.#recordings.get(session);
    if (!recording) return 'finished';
    let bytes = 0;
    try {
      bytes = (await stat(this.partPath(session))).size;
    } catch {
      bytes = 0;
    }
    if (bytes === 0) {
      await this.#remove(session);
      return 'finished';
    }
    try {
      await rename(this.partPath(session), this.#path(session, '.mp4'));
    } catch (error) {
      // The part file and its description stay for the next start to finish; nothing is deleted.
      this.#recordings.delete(session);
      throw error;
    }
    const { bytes: _bytes, active: _active, ...info } = recording;
    const finished: RecordingInfo = { ...info, endedAt: endedAt.toISOString() };
    this.#recordings.set(session, { ...finished, bytes, active: false });
    // A full volume that failed the video can fail this too; the settled record above serves and expires it anyway.
    return this.#writeMetadata(this.#path(session, '.json'), `${JSON.stringify(finished)}\n`).then(() => 'finished', () => 'description_failed');
  }

  /**
   * Delete finished recordings that ended before the maximum age, then the oldest while the directory's recordings,
   * active ones included, exceed the cap. Active recordings are never deleted.
   */
  async sweep(now: Date): Promise<string[]> {
    const deleted: string[] = [];
    const sizes = new Map<string, number>();
    for (const recording of this.#recordings.values()) {
      const path = recording.active ? this.partPath(recording.session) : this.#path(recording.session, '.mp4');
      sizes.set(recording.session, await stat(path).then((entry) => entry.size, () => 0));
    }
    const finished = this.list().filter((recording) => !recording.active).reverse();
    let total = [...sizes.values()].reduce((sum, size) => sum + size, 0);
    for (const recording of finished) {
      const ended = Date.parse(recording.endedAt ?? recording.startedAt);
      if (now.getTime() - ended <= this.#maxAgeMs && total <= this.#capBytes) continue;
      await this.#remove(recording.session);
      total -= sizes.get(recording.session) ?? 0;
      deleted.push(recording.session);
    }
    return deleted;
  }

  async #remove(session: string): Promise<void> {
    this.#recordings.delete(session);
    // The description goes last, so an interrupted removal leaves a video that the next load removes.
    await rm(this.#path(session, '.mp4'), { force: true });
    await rm(this.#path(session, '.mp4.part'), { force: true });
    await rm(this.#path(session, '.json'), { force: true });
  }
}
