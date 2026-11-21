import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

test('a single ORAS push refreshes the job token for the final manifest', { timeout: 15_000 }, async () => {
  const oras = process.env.ORAS;
  assert.ok(oras?.startsWith('/'), 'ORAS must name the verified executable by absolute path');
  const directory = await mkdtemp(join(tmpdir(), 'browserctl-publish-'));
  const config = join(directory, 'auth.json');
  const helperPath = fileURLToPath(new URL('../../../scripts/', import.meta.url));
  let issued = 0;
  let exchanged = 0;
  let published = false;
  let host: string;
  const blobs = new Set<string>();
  const realm = () => `http://${host}/registry-token`;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, `http://${host}`);
    const auth = request.headers.authorization;
    const empty = (status: number, headers: Record<string, string> = {}) => response.writeHead(status, headers).end();
    const json = (value: unknown) => response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    const challenge = () => empty(401, { 'WWW-Authenticate': `Bearer realm="${realm()}",service="${host}",scope="repository:test:pull,push"` });
    if (url.pathname === '/forge-token') {
      assert.equal(auth, 'Bearer synthetic-job');
      assert.equal(url.searchParams.get('api-version'), '2.0');
      assert.equal(url.searchParams.get('audience'), `https://${host}`);
      return json({ value: `synthetic-oidc-${++issued}` });
    }
    if (url.pathname === '/registry-token') {
      const expected = Buffer.from(`oidc:synthetic-oidc-${exchanged + 1}`).toString('base64');
      if (auth !== `Basic ${expected}`) return empty(401);
      return json({ token: `synthetic-registry-${++exchanged}` });
    }
    if (auth !== `Bearer synthetic-registry-${exchanged}` || !exchanged) return challenge();
    if (request.method === 'HEAD') {
      const digest = url.pathname.split('/').at(-1)!;
      return empty(blobs.has(digest) ? 200 : 404);
    }
    if (request.method === 'POST' && url.pathname === '/v2/test/blobs/uploads/') {
      return empty(202, { Location: '/upload' });
    }
    if (request.method !== 'PUT') return empty(405);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const digest = 'sha256:' + createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
    if (url.pathname === '/upload') {
      assert.equal(url.searchParams.get('digest'), digest);
      blobs.add(digest);
    } else if (url.pathname === '/v2/test/manifests/run') {
      // The registry session expires just as the client publishes the manifest.
      if (exchanged < 2) return challenge();
      published = true;
    } else {
      return empty(404);
    }
    return empty(201, { 'Docker-Content-Digest': digest });
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    await writeFile(config, JSON.stringify({ credHelpers: { [host]: 'browserctl-oidc' } }));
    await writeFile(join(directory, 'layer.txt'), 'Synthetic layer');
    await run(oras!, ['push', '--plain-http', '--registry-config', config, `${host}/test:run`, 'layer.txt'], {
      cwd: directory,
      timeout: 10_000,
      env: {
        PATH: helperPath + delimiter + process.env.PATH, HOME: directory,
        ARTIFACT_REGISTRY: host, ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-job',
        ACTIONS_ID_TOKEN_REQUEST_URL: `http://${host}/forge-token?api-version=2.0`,
      },
    });
    assert.equal(published, true);
    assert.equal(issued, 2);
    assert.equal(exchanged, 2);
  } finally {
    server.close();
    server.closeAllConnections();
    await rm(directory, { recursive: true });
  }
});
