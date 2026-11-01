import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { main } from '../../src/cli.ts';
import { socketPath } from '../../src/admin/socket.ts';
import { BrowserctlServer } from '../../src/server/server.ts';
import { adminEnvironment, runDirectory, testConfig } from '../support/server.ts';
import { assertCataloged, keepTelemetry, memoryTelemetry } from '../support/telemetry.ts';

function capture() {
  const lines = { out: [] as string[], err: [] as string[] };
  return { lines, output: { out: (line: string) => lines.out.push(line), err: (line: string) => lines.err.push(line) } };
}

describe('admin CLI and token store', () => {
  let run: Awaited<ReturnType<typeof runDirectory>>;
  let server: BrowserctlServer;
  let environment: Record<string, string>;

  before(async () => {
    run = await runDirectory();
    server = new BrowserctlServer(testConfig(run.path));
    await server.start();
    environment = adminEnvironment(server.config.stateDirectory);
  });

  after(async () => {
    await server.stop();
    await run.remove();
  });

  it('creates a token shown once and stores only its hash', async () => {
    const { lines, output } = capture();
    assert.equal(await main(['admin', 'tokens', 'create', 'agent-a'], environment, output), 0);
    const token = lines.out[0]!;
    assert.match(token, /^bctl_[A-Za-z0-9_-]{43}$/);
    const stored = await readFile(join(server.config.stateDirectory, 'tokens.json'), 'utf8');
    assert.ok(!stored.includes(token) && !stored.includes(token.slice(5)));
    assert.equal(server.tokens.authenticate(token), 'agent-a');
    assert.equal(server.tokens.authenticate(`${token}x`), undefined);
    assert.equal(server.tokens.authenticate(undefined), undefined);
  });

  it('refuses a duplicate or malformed name', async () => {
    const { lines, output } = capture();
    assert.equal(await main(['admin', 'tokens', 'create', 'agent-a'], environment, output), 1);
    assert.match(lines.err[0]!, /client agent-a exists/);
    assert.equal(await main(['admin', 'tokens', 'create', 'Bad Name'], environment, output), 2);
  });

  it('lists names and creation times without hashes', async () => {
    const { lines, output } = capture();
    assert.equal(await main(['admin', 'tokens', 'list'], environment, output), 0);
    assert.equal(lines.out.length, 1);
    assert.match(lines.out[0]!, /^agent-a\t\d{4}-\d\d-\d\dT/);
  });

  it('revokes a token at once and tells listeners', async () => {
    const { lines, output } = capture();
    assert.equal(await main(['admin', 'tokens', 'create', 'agent-b'], environment, output), 0);
    const token = lines.out[0]!;
    const revoked: string[] = [];
    server.tokens.onRevoked((name) => revoked.push(name));
    assert.equal(await main(['admin', 'tokens', 'revoke', 'agent-b'], environment, output), 0);
    assert.equal(server.tokens.authenticate(token), undefined);
    assert.deepEqual(revoked, ['agent-b']);
    const actions = (await server.audit.read()).map((record) => `${record.client} ${record.action} ${record.subject}`);
    assert.deepEqual(actions, ['admin token.create agent-a', 'admin token.create agent-b', 'admin token.revoke agent-b']);
  });

  it('keeps the state directory and admin socket private to the server user', async () => {
    assert.equal((await stat(server.config.stateDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(socketPath(server.config.stateDirectory))).mode & 0o777, 0o600);
  });

  it('reports a server that is not running', async () => {
    const { lines, output } = capture();
    assert.equal(await main(['admin', 'tokens', 'list'], adminEnvironment(join(run.path, 'elsewhere')), output), 1);
    assert.match(lines.err[0]!, /the server is not running/);
  });

  it('emits only cataloged signals for admin commands and the probe', async () => {
    const telemetry = memoryTelemetry();
    try {
      const { output } = capture();
      assert.equal(await main(['admin', 'tokens', 'list'], environment, output, { startTelemetry: keepTelemetry }), 0);
      assert.equal(await main(['admin', 'telemetry-probe'], environment, output, { startTelemetry: keepTelemetry }), 0);
      const recorded = await telemetry.collect();
      assert.deepEqual(recorded.spans.map((span) => span.name), ['browserctl.admin.command', 'browserctl.qualification']);
      assert.deepEqual(recorded.metrics.map((metric) => metric.name), ['browserctl.qualification']);
      assert.deepEqual(recorded.logs.map((record) => record.body), ['browserctl.qualification']);
      assertCataloged(recorded);
    } finally {
      await telemetry.restore();
    }
  });
});
