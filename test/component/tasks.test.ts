// The task store and the model forwarder, in process.

import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { HttpRouter } from '../../src/server/http.ts';
import { ModelForwarder } from '../../src/tasks/forwarder.ts';
import { KEEP, RunLog, preview, MAX_VALUE_CHARS } from '../../src/tasks/runs.ts';
import { TaskStore } from '../../src/tasks/store.ts';
import { runDirectory } from '../support/server.ts';

describe('task store', () => {
  let run: Awaited<ReturnType<typeof runDirectory>>;
  let store: TaskStore;

  before(async () => {
    run = await runDirectory();
    store = new TaskStore(run.path);
  });

  after(() => run.remove());

  it('keeps every saved revision, attributed to its client', async () => {
    assert.equal((await store.save('login', 'one', 'agent-a')).id, '1');
    assert.equal((await store.save('login', 'two', 'agent-b')).id, '2');
    assert.deepEqual(await store.read('login', '1').then(({ revision, content }) => [revision.client, content]), ['agent-a', 'one']);
    assert.deepEqual(await store.read('login').then(({ revision, content }) => [revision.id, revision.client, content]), ['2', 'agent-b', 'two']);
    await assert.rejects(store.read('login', '3'), /no revision 3/);
    await assert.rejects(store.read('nope'), /no task nope/);
    await assert.rejects(store.save('../x', 'x', 'agent-a'), /a task name is/);
    await assert.rejects(store.save('empty', '', 'agent-a'), /a task is the text/);
  });

  it('replaces the replay cache whole and sweeps interrupted replacements', async () => {
    await store.replaceCache('login', [{ path: 'a.json', content: Buffer.from('1') }, { path: 'sub/b.json', content: Buffer.from('2') }]);
    await store.replaceCache('login', [{ path: 'c.json', content: Buffer.from('3') }]);
    assert.deepEqual((await store.cache('login')).map((file) => [file.path, file.content.toString()]), [['c.json', '3']]);
    await mkdir(join(run.path, 'tasks', 'login', '.cache-dead'));
    await writeFile(join(run.path, 'tasks', 'login', '.cache-dead', 'x'), 'x');
    await store.sweepLeftovers();
    assert.deepEqual((await readdir(join(run.path, 'tasks', 'login'))).sort(), ['cache', 'revisions', 'task.json']);
  });

  it('keeps concurrent readers on a complete cache while a replacement runs', async () => {
    await store.replaceCache('login', [{ path: 'old.json', content: Buffer.from('old') }]);
    const replacement = store.replaceCache('login', [
      { path: 'new.json', content: Buffer.from('new') },
      { path: 'nested/other.json', content: Buffer.from('other') },
    ]);
    const reads = await Promise.all([store.cache('login'), store.cache('login')]);
    await Promise.all([replacement, ...reads]);
    for (const files of reads) {
      assert.ok(files.length > 0, 'a concurrent reader sees the old or new cache');
    }
  });

  it('restores the old cache after an interrupted swap', async () => {
    await store.replaceCache('login', [{ path: 'old.json', content: Buffer.from('old') }]);
    const directory = join(run.path, 'tasks', 'login');
    await rename(join(directory, 'cache'), join(directory, '.cache-old-dead'));
    await mkdir(join(directory, '.cache-dead'));
    await store.sweepLeftovers();
    assert.deepEqual((await store.cache('login')).map((file) => [file.path, file.content.toString()]), [['old.json', 'old']]);
  });
});

describe('run log', () => {
  it('keeps the newest runs, newest first, across a reload and its compaction', async () => {
    const run = await runDirectory();
    try {
      const log = new RunLog(run.path);
      const record = (index: number) => ({
        run: `r-${index}`, task: 't', revision: '1', client: 'c', session: 's', status: 'passed' as const,
        startedAt: '', durationMs: 0, input: preview({ index }), output: undefined, failure: undefined,
      });
      for (let index = 1; index <= 2 * KEEP + 5; index += 1) await log.append(record(index));
      const recent = await new RunLog(run.path).recent();
      assert.equal(recent.length, KEEP);
      assert.equal(recent[0]!.run, `r-${2 * KEEP + 5}`);
      assert.ok((await readFile(join(run.path, 'runs.jsonl'), 'utf8')).split('\n').length <= 2 * KEEP + 1, 'the file is compacted');
      assert.equal(preview('x'.repeat(MAX_VALUE_CHARS * 2)).length, MAX_VALUE_CHARS + 1);
    } finally {
      await run.remove();
    }
  });
});

describe('model forwarder', () => {
  let run: Awaited<ReturnType<typeof runDirectory>>;
  let upstream: ReturnType<typeof createServer>;
  let received: Array<{ authorization: string | undefined; body: string }>;
  let router: HttpRouter;
  let forwarder: ModelForwarder;
  let base: string;

  before(async () => {
    run = await runDirectory();
    received = [];
    upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      received.push({ authorization: request.headers.authorization, body: Buffer.concat(chunks).toString() });
      response.writeHead(request.url === '/v1/responses' ? 200 : 404, { 'content-type': 'application/json' }).end('{"id":"resp_1"}');
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const keyFile = join(run.path, 'key');
    await writeFile(keyFile, 'model-key-synthetic\n', { mode: 0o600 });
    forwarder = new ModelForwarder({ baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`, name: 'm', keyFile });
    router = new HttpRouter();
    forwarder.mount(router);
    base = `http://127.0.0.1:${await router.listen('127.0.0.1', 0)}`;
  });

  after(async () => {
    await router.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await run.remove();
  });

  const post = (token: string | undefined, body = '{"model":"other","input":[]}') =>
    fetch(`${base}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body });

  it('forwards a run token holder\'s request to the configured model with the key until the token is revoked', async () => {
    const credential = forwarder.issue();
    const response = await post(credential.token);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id: 'resp_1' });
    assert.deepEqual(received, [{ authorization: 'Bearer model-key-synthetic', body: '{"model":"m","input":[]}' }]);
    assert.equal((await post(credential.token, '[1]')).status, 400);
    credential.revoke();
    assert.equal((await post(credential.token)).status, 401);
    assert.equal((await post(undefined)).status, 401);
    assert.equal(received.length, 1, 'refused requests never reach the model');
  });

  it('answers 503 when no model is configured', async () => {
    const bare = new ModelForwarder(undefined);
    const bareRouter = new HttpRouter();
    bare.mount(bareRouter);
    const port = await bareRouter.listen('127.0.0.1', 0);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${bare.issue().token}` }, body: '{}' });
      assert.equal(response.status, 503);
    } finally {
      await bareRouter.close();
    }
  });
});
