import assert from 'node:assert/strict';
import { appendFile, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { appendJsonl, readJson, readJsonl, writeAtomic, writeJson } from '../../src/state/files.ts';
import { runDirectory } from '../support/server.ts';

describe('state files', () => {
  let run: Awaited<ReturnType<typeof runDirectory>>;
  before(async () => {
    run = await runDirectory();
  });
  after(() => run.remove());

  it('replaces a file by rename and leaves no temporary file', async () => {
    const path = join(run.path, 'deep', 'file.json');
    await writeJson(path, { a: 1 });
    await writeJson(path, { a: 2 });
    assert.deepEqual(await readJson(path), { a: 2 });
    assert.deepEqual(await readdir(join(run.path, 'deep')), ['file.json']);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await writeAtomic(join(run.path, 'deep', 'bytes'), new Uint8Array([1, 2]));
    assert.deepEqual([...(await readFile(join(run.path, 'deep', 'bytes')))], [1, 2]);
  });

  it('reads a missing JSON file as undefined', async () => {
    assert.equal(await readJson(join(run.path, 'none.json')), undefined);
  });

  it('appends JSONL records and skips a torn last line', async () => {
    const path = join(run.path, 'events.jsonl');
    await appendJsonl(path, { n: 1 });
    await appendJsonl(path, { n: 2 });
    await appendFile(path, '{"n":');
    assert.deepEqual(await readJsonl(path), [{ n: 1 }, { n: 2 }]);
    assert.deepEqual(await readJsonl(join(run.path, 'none.jsonl')), []);
  });
});
