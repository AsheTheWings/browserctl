// Recording retention and indexing on a real recordings directory, and a recording that cannot write its video,
// without browsers or ffmpeg.

import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Recorder, type RecorderOptions } from '../../src/recordings/recorder.ts';
import { MAX_AGE_MS, RecordingStore, type RecordingInfo } from '../../src/recordings/store.ts';
import type { Session } from '../../src/sessions/manager.ts';
import { eventually } from '../support/processes.ts';
import { runDirectory } from '../support/server.ts';
import { memoryTelemetry } from '../support/telemetry.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-01T12:00:00Z');

/** A session id for recording n. */
const id = (n: number) => `s-recording${String(n).padStart(3, '0')}`.slice(0, 14);

function info(n: number, endedDaysAgo: number): RecordingInfo {
  const ended = NOW.getTime() - endedDaysAgo * DAY;
  return {
    session: id(n),
    client: 'operator',
    purpose: 'agent',
    source: 'ephemeral',
    startedAt: new Date(ended - 60_000).toISOString(),
    endedAt: new Date(ended).toISOString(),
  };
}

describe('recording store', () => {
  let run: Awaited<ReturnType<typeof runDirectory>>;
  let directory: string;

  beforeEach(async () => {
    run = await runDirectory();
    directory = join(run.path, 'recordings');
    await mkdir(directory, { mode: 0o700 });
  });

  afterEach(() => run.remove());

  async function finished(recording: RecordingInfo, bytes: number): Promise<void> {
    await writeFile(join(directory, `${recording.session}.json`), JSON.stringify(recording));
    await writeFile(join(directory, `${recording.session}.mp4`), Buffer.alloc(bytes));
  }

  it('deletes recordings over 7 days old, then the oldest while the directory exceeds its cap', async () => {
    // Oldest first: 9 and 8 days old are expired; the rest total 400 bytes against a 250-byte cap.
    await finished(info(1, 9), 100);
    await finished(info(2, 8), 100);
    await finished(info(3, 6), 100);
    await finished(info(4, 5), 100);
    await finished(info(5, 2), 100);
    await finished(info(6, 1), 100);
    const store = new RecordingStore(directory, 250);
    await store.load();
    assert.equal(store.list().length, 6);

    assert.deepEqual(await store.sweep(NOW), [id(1), id(2), id(3), id(4)]);
    assert.deepEqual(store.list().map((recording) => recording.session), [id(6), id(5)]);
    assert.deepEqual((await readdir(directory)).sort(), [`${id(5)}.json`, `${id(5)}.mp4`, `${id(6)}.json`, `${id(6)}.mp4`]);
    assert.deepEqual(await store.sweep(NOW), [], 'a second sweep finds nothing to delete');
  });

  it('keeps recordings within 7 days and the cap', async () => {
    await finished(info(1, 6.9), 100);
    await finished(info(2, 0), 100);
    const store = new RecordingStore(directory, 200);
    await store.load();
    assert.deepEqual(await store.sweep(NOW), []);
    assert.equal(MAX_AGE_MS, 7 * DAY);
  });

  it('counts an active recording toward the cap but never deletes it', async () => {
    await finished(info(1, 1), 100);
    const store = new RecordingStore(directory, 150);
    await store.load();
    const active: RecordingInfo = { ...info(2, 0), endedAt: undefined };
    await store.begin(active);
    await writeFile(store.partPath(active.session), Buffer.alloc(100));
    assert.deepEqual(await store.sweep(NOW), [id(1)]);
    assert.deepEqual(store.list().map(({ session, active: writing }) => ({ session, writing })), [{ session: id(2), writing: true }]);
    assert.equal(store.videoPath(active.session), undefined, 'an active recording is not served');

    await store.finish(active.session, NOW);
    const [recording] = store.list();
    assert.equal(recording!.active, false);
    assert.equal(recording!.bytes, 100);
    assert.equal(recording!.endedAt, NOW.toISOString());
    assert.equal(store.videoPath(active.session), join(directory, `${active.session}.mp4`));
  });

  it('removes a recording that ends without any video', async () => {
    const store = new RecordingStore(directory, 1000);
    await store.load();
    await store.begin({ ...info(1, 0), endedAt: undefined });
    await writeFile(store.partPath(id(1)), '');
    await store.finish(id(1), NOW);
    assert.deepEqual(store.list(), []);
    assert.deepEqual(await readdir(directory), []);
  });

  it('finishes a part file a stopped server left and removes unpaired or malformed files', async () => {
    const left: RecordingInfo = { ...info(1, 0), endedAt: undefined };
    await writeFile(join(directory, `${left.session}.json`), JSON.stringify(left));
    await writeFile(join(directory, `${left.session}.mp4.part`), Buffer.alloc(50));
    await writeFile(join(directory, `${id(2)}.mp4`), Buffer.alloc(10));
    await writeFile(join(directory, `${id(3)}.json`), JSON.stringify(info(3, 0)));
    await writeFile(join(directory, `${id(4)}.json`), '{not json');
    await writeFile(join(directory, `${id(4)}.mp4`), Buffer.alloc(10));
    await writeFile(join(directory, `.${id(5)}.json.0123456789ab.tmp`), '{}');
    const store = new RecordingStore(directory, 1000);
    await store.load();

    assert.deepEqual(store.list().map(({ session, active, bytes }) => ({ session, active, bytes })), [{ session: left.session, active: false, bytes: 50 }]);
    assert.deepEqual((await readdir(directory)).sort(), [`${left.session}.json`, `${left.session}.mp4`]);
    const saved = JSON.parse(await readFile(join(directory, `${left.session}.json`), 'utf8')) as RecordingInfo;
    assert.ok(saved.endedAt, 'the finished recording gets an end time');
  });

  it('settles a finished video when its description cannot be written, then repairs it on load', async () => {
    let calls = 0;
    const store = new RecordingStore(directory, 1000, {
      // The description of a recording begins once and is rewritten when it ends; only that rewrite fails here.
      writeMetadata: async (path, text) => {
        calls += 1;
        if (calls === 2) throw new Error('ENOSPC: no space left on device, write');
        await writeFile(path, text);
      },
    });
    await store.load();
    const recording: RecordingInfo = { ...info(1, 0), endedAt: undefined };
    await store.begin(recording);
    await writeFile(store.partPath(recording.session), Buffer.alloc(64));

    await store.finish(recording.session, NOW);
    assert.equal(calls, 2);
    const [listed] = store.list();
    assert.equal(listed!.active, false, 'the finished video is listed as finished');
    assert.equal(listed!.bytes, 64);
    assert.equal(listed!.endedAt, NOW.toISOString());
    assert.equal(store.videoPath(recording.session), join(directory, `${recording.session}.mp4`));
    assert.equal((await readFile(join(directory, `${recording.session}.json`), 'utf8')).includes('"endedAt"'), false, 'the rewrite failed');
    assert.deepEqual(await store.sweep(NOW), [], 'the recording is finished, so the sweep considers it');

    const reloaded = new RecordingStore(directory, 1000);
    await reloaded.load();
    const [repaired] = reloaded.list();
    assert.equal(repaired!.active, false);
    assert.ok(repaired!.endedAt);
    const saved = JSON.parse(await readFile(join(directory, `${recording.session}.json`), 'utf8')) as RecordingInfo;
    assert.equal(saved.endedAt, repaired!.endedAt, 'the next start writes the end time');
  });

  it('keeps the part file and description when the finished video cannot be renamed', async () => {
    const store = new RecordingStore(directory, 1000);
    await store.load();
    const recording: RecordingInfo = { ...info(1, 0), endedAt: undefined };
    await store.begin(recording);
    await writeFile(store.partPath(recording.session), Buffer.alloc(32));
    // A directory where the video should go makes the rename fail while the part file stays intact.
    await mkdir(join(directory, `${recording.session}.mp4`));

    await assert.rejects(store.finish(recording.session, NOW));
    assert.deepEqual(store.list(), [], 'the unfinished recording is not listed as active');
    assert.deepEqual((await readdir(directory)).sort(), [`${recording.session}.json`, `${recording.session}.mp4`, `${recording.session}.mp4.part`].sort());

    // Once the rename can succeed, the next start finishes the recording from the part file.
    await rm(join(directory, `${recording.session}.mp4`), { recursive: true });
    const reloaded = new RecordingStore(directory, 1000);
    assert.deepEqual(await reloaded.load(), []);
    const [listed] = reloaded.list();
    assert.equal(listed!.active, false);
    assert.equal(listed!.bytes, 32);
    assert.ok(listed!.endedAt);
  });

  it('indexes a recording whose description cannot be rewritten at startup and reports it', async () => {
    const recording: RecordingInfo = { ...info(1, 0), endedAt: undefined };
    await writeFile(join(directory, `${recording.session}.json`), JSON.stringify(recording));
    await writeFile(join(directory, `${recording.session}.mp4`), Buffer.alloc(48));
    const store = new RecordingStore(directory, 1000, {
      writeMetadata: async () => {
        throw new Error('ENOSPC: no space left on device, write');
      },
    });
    assert.deepEqual(await store.load(), [recording.session]);
    const [listed] = store.list();
    assert.equal(listed!.active, false, 'the video is indexed despite the description');
    assert.ok(listed!.endedAt);
    assert.equal(listed!.bytes, 48);
  });
});

describe('recorder', () => {
  const session = (id: string): { session: Session; close: () => void } => {
    let close!: () => void;
    const closed = new Promise<void>((resolve) => (close = resolve));
    return {
      session: {
        id,
        client: 'operator',
        purpose: 'agent',
        source: { kind: 'ephemeral' },
        createdAt: Date.now(),
        state: 'ready',
        closed,
      } as Session,
      close,
    };
  };

  /** Run a recorder over a store, hand it one session, and return the log records it emitted. */
  async function recorded(store: RecorderOptions['store'], work: (open: (session: Session) => void) => Promise<void>) {
    const telemetry = memoryTelemetry();
    let open: ((session: Session) => void) | undefined;
    const recorder = new Recorder({
      sessions: { onOpen: (listener) => (open = listener) },
      // A session whose screencast never sends a frame: the video is the encoder's output alone.
      screencasts: { forSession: () => ({ watch: () => () => undefined, onClose: () => undefined }) },
      store,
      path: process.env.PATH ?? '/usr/bin:/bin',
      encoder: [process.execPath, '-e', 'process.stdout.write("encoded"); process.stdin.resume(); process.stdin.on("end", () => process.exit(0))'],
    });
    try {
      await recorder.start();
      await work(open!);
      await recorder.stop();
      return (await telemetry.collect()).logs;
    } finally {
      await telemetry.restore();
    }
  }

  const reported = (logs: Array<{ body: unknown; attributes: Record<string, unknown> }>, id: string) =>
    logs.some((record) => record.body === 'browserctl.recording.failed' && record.attributes['browserctl.session.id'] === id);

  it('ends a recording whose video cannot be written, leaves the session open, and reports it', async () => {
    const run = await runDirectory();
    try {
      const begun: string[] = [];
      const finished: string[] = [];
      const { session: opened, close } = session('s-recorderfail1');
      const logs = await recorded(
        {
          load: async () => [],
          begin: async (recording) => void begun.push(recording.session),
          finish: async (name) => {
            finished.push(name);
            return 'finished';
          },
          sweep: async () => [],
          // A directory that does not exist, so opening the video fails as a full volume's write would.
          partPath: () => join(run.path, 'missing', 'video.mp4.part'),
        },
        async (open) => {
          open(opened);
          await eventually(() => finished.length > 0);
        },
      );
      close();
      assert.deepEqual(begun, [opened.id]);
      assert.deepEqual(finished, [opened.id]);
      assert.equal(opened.state, 'ready', 'the session is not closed by its recording');
      assert.ok(reported(logs, opened.id), 'the failure is reported as a log record');
    } finally {
      await run.remove();
    }
  });

  it('reports a finished recording whose description could not be written', async () => {
    const run = await runDirectory();
    try {
      const finished: string[] = [];
      const { session: opened, close } = session('s-recorderdesc1');
      const logs = await recorded(
        {
          load: async () => [],
          begin: async () => undefined,
          finish: async (name) => {
            finished.push(name);
            return 'description_failed';
          },
          sweep: async () => [],
          partPath: () => join(run.path, 'video.mp4.part'),
        },
        async (open) => {
          open(opened);
          close();
          await eventually(() => finished.length > 0);
        },
      );
      assert.ok(reported(logs, opened.id));
    } finally {
      await run.remove();
    }
  });

  it('reports a recording whose finished video could not be renamed, leaving the session open', async () => {
    const run = await runDirectory();
    try {
      const attempted: string[] = [];
      const { session: opened, close } = session('s-recorderrename1');
      const logs = await recorded(
        {
          load: async () => [],
          begin: async () => undefined,
          finish: async (name) => {
            attempted.push(name);
            throw new Error('EIO: i/o error, rename');
          },
          sweep: async () => [],
          partPath: () => join(run.path, 'video.mp4.part'),
        },
        async (open) => {
          open(opened);
          close();
          await eventually(() => attempted.length > 0);
        },
      );
      assert.ok(reported(logs, opened.id));
      assert.equal(opened.state, 'ready');
    } finally {
      await run.remove();
    }
  });

  it('reports a description rewritten at startup that failed again', async () => {
    const logs = await recorded(
      {
        load: async () => ['s-oldrepair01'],
        begin: async () => undefined,
        finish: async () => 'finished',
        sweep: async () => [],
        partPath: () => '/nonexistent/video.mp4.part',
      },
      async () => undefined,
    );
    assert.ok(reported(logs, 's-oldrepair01'));
  });
});
