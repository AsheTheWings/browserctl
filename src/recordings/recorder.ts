// Recording agent and check sessions: each session's screencast feeds ffmpeg at a steady 10 frames per second, which
// encodes H.264 at most 960 pixels wide into a fragmented MP4 on its standard output. ffmpeg runs as the recorder
// user with no file access of its own; the server writes the video into the recordings directory. Sign-in sessions
// and watched browsers are never recorded.

import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import type { Session, SessionManager } from '../sessions/manager.ts';
import type { Frame, Viewer } from '../dashboard/screencast.ts';
import { emitEvent } from '../telemetry/signals.ts';
import type { RecordingStore } from './store.ts';

/** The recorder user's UID and GID; the Containerfile creates the same user. */
export const RECORDER_ID = 1090;
export const FRAMES_PER_SECOND = 10;
export const WIDTH = 960;
export const HEIGHT = 600;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
/** ffmpeg gets this long to finish the video once its input ends. */
const FINISH_TIMEOUT_MS = 30_000;
/** Frames are dropped while ffmpeg has this much input it has not read yet. */
const MAX_PENDING_BYTES = 8 * 1024 * 1024;

export function ffmpegArguments(): string[] {
  const box = `${WIDTH}:${HEIGHT}`;
  return [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'image2pipe', '-framerate', String(FRAMES_PER_SECOND), '-c:v', 'mjpeg', '-i', 'pipe:0',
    '-an',
    // Every frame is fitted into one fixed box, so a viewport that changes size never changes the video's size.
    '-vf', `scale=${box}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${box}:-1:-1,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-g', String(FRAMES_PER_SECOND * 10), '-r', String(FRAMES_PER_SECOND),
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4', 'pipe:1',
  ];
}

/** What a recording needs from a session's screencast. */
export interface SessionStream {
  watch(viewer: Viewer): () => void;
  onClose(listener: () => void): void;
}

export interface RecorderOptions {
  sessions: Pick<SessionManager, 'onOpen'>;
  screencasts: { forSession(session: Session): SessionStream | undefined };
  store: Pick<RecordingStore, 'load' | 'begin' | 'finish' | 'partPath' | 'sweep'>;
  path: string;
  /** The encoder command, reading JPEG frames on standard input; ffmpeg with ffmpegArguments() by default. */
  encoder?: [string, ...string[]];
}

function failed(session: Session): void {
  emitEvent('browserctl.recording.failed', { 'browserctl.session.id': session.id, 'error.type': 'internal' });
}

export class Recorder {
  readonly #options: RecorderOptions;
  readonly #active = new Set<Promise<void>>();
  #sweeper: NodeJS.Timeout | undefined;

  constructor(options: RecorderOptions) {
    this.#options = options;
  }

  async start(): Promise<void> {
    await this.#options.store.load();
    await this.#sweep();
    this.#sweeper = setInterval(() => void this.#sweep(), SWEEP_INTERVAL_MS);
    this.#sweeper.unref();
    this.#options.sessions.onOpen((session) => {
      if (session.purpose === 'sign_in') return;
      // A recording that fails ends alone; its session stays open.
      const recording = this.#record(session).catch(() => failed(session));
      this.#active.add(recording);
      void recording.finally(() => this.#active.delete(recording));
    });
  }

  /** Stop sweeping and wait for the recordings of closed sessions to finish. */
  async stop(): Promise<void> {
    clearInterval(this.#sweeper);
    await Promise.allSettled([...this.#active]);
  }

  async #sweep(): Promise<void> {
    await this.#options.store.sweep(new Date()).catch(() => undefined);
  }

  async #record(session: Session): Promise<void> {
    const screencast = this.#options.screencasts.forSession(session);
    if (!screencast) return;
    const { store } = this.#options;
    const { source } = session;
    await store.begin({
      session: session.id,
      client: session.client,
      purpose: session.purpose === 'check' ? 'check' : 'agent',
      source: source.kind,
      ...(source.kind === 'profile' && { profile: source.profile }),
      ...(source.kind === 'provider' && { provider: source.provider }),
      startedAt: new Date(session.createdAt).toISOString(),
    });
    const file = createWriteStream(store.partPath(session.id), { mode: 0o600, flags: 'wx' });
    const root = process.getuid?.() === 0;
    const [command, ...args] = this.#options.encoder ?? ['ffmpeg', ...ffmpegArguments()];
    const ffmpeg: ChildProcess = spawn(command, args, {
      ...(root && { uid: RECORDER_ID, gid: RECORDER_ID }),
      cwd: '/',
      env: { PATH: this.#options.path, LANG: 'C.UTF-8' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const exited = new Promise<number | null>((resolve) => {
      ffmpeg.once('error', () => resolve(null));
      ffmpeg.once('close', (code) => resolve(code));
    });
    ffmpeg.stdin!.on('error', () => undefined);
    // A video that cannot be written, such as on a full volume, ends the recording.
    let failure: Error | undefined;
    const writeFailed = new Promise<void>((resolve) => {
      const fail = (error: Error) => {
        failure ??= error;
        resolve();
      };
      file.on('error', fail);
      ffmpeg.stdout!.on('error', fail);
    });
    ffmpeg.stdout!.pipe(file);

    let latest: Frame | undefined;
    const unwatch = screencast.watch({
      stream: 'recording',
      send(frame) {
        latest = frame;
        return true;
      },
    });
    // A steady frame rate keeps the video's timing true to the session: a page that does not paint repeats its frame.
    const ticker = setInterval(() => {
      if (latest && ffmpeg.stdin!.writable && ffmpeg.stdin!.writableLength < MAX_PENDING_BYTES) ffmpeg.stdin!.write(latest.jpeg);
    }, 1000 / FRAMES_PER_SECOND);

    await Promise.race([session.closed, new Promise<void>((resolve) => screencast.onClose(resolve)), exited, writeFailed]);
    clearInterval(ticker);
    unwatch();
    // Output that can no longer be written would leave ffmpeg blocked on it.
    if (failure) ffmpeg.kill('SIGKILL');
    ffmpeg.stdin!.end();
    const timer = setTimeout(() => ffmpeg.kill('SIGKILL'), FINISH_TIMEOUT_MS);
    const code = await exited;
    clearTimeout(timer);
    // ffmpeg that never started leaves the file open, since its output never ended.
    if (!file.destroyed && !file.writableEnded) file.end();
    if (!file.closed) await once(file, 'close').catch(() => undefined);
    // ffmpeg ends with an error when it got no frame at all, which leaves an empty video that finishing removes.
    if (failure || (code !== 0 && latest)) {
      failed(session);
      // The video is kept as far as it was written, or removed when nothing was.
      await store.finish(session.id, new Date()).catch(() => undefined);
    } else {
      await store.finish(session.id, new Date());
    }
    await this.#sweep();
  }
}
