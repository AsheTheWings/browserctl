// Task runs, the model forwarder, and service checks with real Chrome and e2e, as container root in the image.

import assert from 'node:assert/strict';
import { chmod, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BrowserctlServer } from '../../src/server/server.ts';
import { CHECK_CLIENT } from '../../src/tasks/checks.ts';
import { TaskRunner } from '../../src/tasks/runner.ts';
import { headlessSignIn, visit } from '../support/browser.ts';
import { fakeModel, type FakeModel } from '../support/fake-model.ts';
import { mcpClient, type TestClient } from '../support/mcp.ts';
import { eventually, processesOf } from '../support/processes.ts';
import { runDirectory, testConfig } from '../support/server.ts';
import { assertCataloged, memoryTelemetry, type MemoryTelemetry } from '../support/telemetry.ts';

assert.equal(process.getuid?.(), 0, 'integration tests run as root in the image: node scripts/test.ts integration');

const MODEL_KEY = 'model-key-synthetic-0123456789';

/** A page whose button sets its status; the status reads Released once the test releases it, and the session cookie. */
const PAGE = `<!doctype html><title>task</title>
<button onclick="document.getElementById('status').textContent = 'Done'">Go</button>
<p role="status" id="status">Idle</p>
<p role="note" id="released">Held</p>
<p role="contentinfo" id="account"></p>
<script>
document.getElementById('account').textContent = document.cookie.includes('snap=yes') ? 'Signed in' : 'Signed out';
setInterval(async () => {
  if ((await (await fetch('/released')).text()) === 'yes') document.getElementById('released').textContent = 'Released';
}, 100);
</script>`;

const PRESS_GO = `import { expect, test } from 'e2e';
import { readFileSync, writeFileSync } from 'node:fs';

test('press go', async ({ app, agent, screen }) => {
  const input = JSON.parse(readFileSync(process.env.BROWSERCTL_TASK_INPUT_FILE, 'utf8'));
  await app.open(input.url);
  await agent.act('press the "Go" button');
  await expect(screen.getByRole('status')).toHaveText('Done');
  writeFileSync(process.env.BROWSERCTL_TASK_OUTPUT_FILE, JSON.stringify({ pressed: true, echo: input.echo }));
});
`;

/** Waits on the page until the test releases it, or for a minute. */
const HOLD = `import { expect, test } from 'e2e';
import { readFileSync } from 'node:fs';

test('hold', async ({ app, screen }) => {
  const input = JSON.parse(readFileSync(process.env.BROWSERCTL_TASK_INPUT_FILE, 'utf8'));
  await app.open(input.url);
  await expect(screen.getByRole('note')).toHaveText('Released', { timeout: 60_000 });
});
`;

/** Tries to read each path it is given and reports the error code, or "read". */
const PROBE = `import { test } from 'e2e';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';

test('probe', async () => {
  const input = JSON.parse(readFileSync(process.env.BROWSERCTL_TASK_INPUT_FILE, 'utf8'));
  const results = {};
  for (const path of input.paths) {
    try {
      statSync(path).isDirectory() ? readdirSync(path) : readFileSync(path);
      results[path] = 'read';
    } catch (error) {
      results[path] = error.code;
    }
  }
  const env = { E2E_TELEMETRY_DISABLED: process.env.E2E_TELEMETRY_DISABLED, DO_NOT_TRACK: process.env.DO_NOT_TRACK };
  writeFileSync(process.env.BROWSERCTL_TASK_OUTPUT_FILE, JSON.stringify({ results, env }));
});
`;

const CHECK_SIGNED_IN = `import { expect, test } from 'e2e';

test('signed in', async ({ app, screen }) => {
  await app.open('__SITE__');
  await expect(screen.getByRole('contentinfo')).toHaveText('Signed in');
});
`;

describe('task runs', () => {
  let run: Awaited<ReturnType<typeof runDirectory>>;
  let server: BrowserctlServer;
  let model: FakeModel;
  let site: ReturnType<typeof createServer>;
  let siteUrl: string;
  let released = false;
  let token: string;
  let telemetry: MemoryTelemetry;
  const clients: TestClient[] = [];

  before(async () => {
    telemetry = memoryTelemetry();
    run = await runDirectory();
    model = await fakeModel();
    const keyFile = join(run.path, 'model-key');
    await writeFile(keyFile, MODEL_KEY, { mode: 0o600 });
    await chmod(keyFile, 0o600);
    server = new BrowserctlServer(testConfig(run.path, { model: { baseUrl: model.url, name: 'fake-model', keyFile } }));
    await server.start();
    server.sessions.displayOpener = headlessSignIn(server.config.path);
    token = await server.tokens.create('agent-a');
    site = createServer((request, response) => {
      if (request.url === '/released') return void response.writeHead(200, { 'content-type': 'text/plain' }).end(released ? 'yes' : 'no');
      const headers: Record<string, string> = { 'content-type': 'text/html' };
      if (request.url === '/set') headers['set-cookie'] = 'snap=yes; Max-Age=86400; Path=/';
      response.writeHead(200, headers).end(PAGE);
    });
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  });

  after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await server.stop();
    await model.close();
    await new Promise<void>((resolve) => site.close(() => resolve()));
    await telemetry.restore();
    await run.remove();
  });

  async function open(): Promise<{ client: TestClient; id: string }> {
    const client = await mcpClient(server.port, token);
    clients.push(client);
    const opened = await client.call('session_open', { ephemeral: true });
    assert.equal(opened.isError, false, opened.text);
    return { client, id: opened.json().id };
  }

  it('saves revisions attributed to the client and serves the guides as resources', async () => {
    const client = await mcpClient(server.port, token);
    clients.push(client);
    assert.equal((await client.call('task_save', { name: 'press-go', content: PRESS_GO })).json().revision, '1');
    assert.equal((await client.call('task_save', { name: 'press-go', content: PRESS_GO })).json().revision, '2');
    const first = (await client.call('task_get', { name: 'press-go', revision: '1' })).json();
    assert.equal(first.client, 'agent-a');
    assert.equal(first.content, PRESS_GO);
    assert.deepEqual((await client.call('task_list')).json(), [{ name: 'press-go', latest_revision: '2', revisions: 2 }]);
    assert.equal((await client.call('task_get', { name: 'press-go', revision: '9' })).isError, true);
    assert.equal((await client.call('task_run', { name: 'press-go' })).text, 'no session is bound; call session_open first');

    const { resources } = await client.client.listResources();
    assert.deepEqual(resources.map((resource) => resource.uri).sort(), [
      'browserctl://guides/e2e-agent',
      'browserctl://guides/e2e-writing-tests',
      'browserctl://guides/tasks',
    ]);
    for (const resource of resources) {
      const read = await client.client.readResource({ uri: resource.uri });
      assert.match(String((read.contents[0] as { text: string }).text), /^# /, `${resource.uri} is a markdown guide`);
    }
  });

  it('returns the output through the forwarder and replays the cache without a model call', async () => {
    const { client, id } = await open();
    const first = (await client.call('task_run', { name: 'press-go', input: { url: `${siteUrl}/`, echo: 'one' } })).json();
    assert.equal(first.status, 'passed', first.failure);
    assert.deepEqual(first.output, { pressed: true, echo: 'one' });
    assert.equal(first.revision, '2');
    const calls = model.authorizations.length;
    assert.ok(calls > 0, 'the first run called the model');
    assert.ok(model.authorizations.every((header) => header === `Bearer ${MODEL_KEY}`), 'the forwarder sends the model key');
    assert.equal(server.sessions.get(id)?.state, 'ready', 'the run leaves the browser open');

    const second = (await client.call('task_run', { name: 'press-go', input: { url: `${siteUrl}/`, echo: 'two' } })).json();
    assert.equal(second.status, 'passed', second.failure);
    assert.deepEqual(second.output, { pressed: true, echo: 'two' });
    assert.equal(model.authorizations.length, calls, 'the second run replayed its cache without a model call');

    const forged = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(forged.status, 401, 'a client token is not a run token');
  });

  it('refuses browser tools while a run drives the session', async () => {
    await server.tasks.save('hold', HOLD, 'agent-a');
    const { client, id } = await open();
    const session = server.sessions.get(id)!;
    released = false;
    const running = client.call('task_run', { name: 'hold', input: { url: `${siteUrl}/` } });
    await eventually(() => server.runner.running(session), 30_000);
    const refused = await client.call('browser_snapshot');
    assert.equal(refused.isError, true);
    assert.match(refused.text, /a task run drives this session/);
    released = true;
    const result = (await running).json();
    assert.equal(result.status, 'passed', result.failure);
    assert.equal((await client.call('browser_snapshot')).isError, false, 'browser tools work again after the run');
  });

  it('kills a run past the timeout and reports it as timed out', async () => {
    const session = await server.sessions.open('agent-a', { kind: 'ephemeral' });
    try {
      released = false;
      const runner = new TaskRunner({
        tasks: server.tasks,
        sessions: server.sessions,
        forwarder: server.forwarder,
        audit: server.audit,
        path: server.config.path,
        timeoutSeconds: 10,
        internalBase: () => `http://127.0.0.1:${server.port}`,
      });
      const result = await runner.run(session, 'agent-a', 'hold', undefined, { url: `${siteUrl}/` });
      assert.equal(result.status, 'timed_out');
      assert.equal(result.errorClass, 'timeout');
      await eventually(() => processesOf(session.users.sessionUid).length === 0);
      assert.equal(session.state, 'ready', 'a timed-out run leaves the session open');
      const recorded = await telemetry.collect();
      assertCataloged(recorded);
      assert.ok(recorded.spans.some((span) => span.name === 'browserctl.task.run' && span.attributes['browserctl.task.run_status'] === 'timed_out'));
      assert.ok(recorded.logs.some((record) => record.body === 'browserctl.task.run.failed' && record.attributes['error.type'] === 'timeout'));
    } finally {
      await server.sessions.close(session, 'closed');
    }
  });

  it('runs as the session user, who cannot read the state, the model key, the profile copy, or other sessions', async () => {
    await server.tasks.save('probe', PROBE, 'agent-a');
    const session = await server.sessions.open('agent-a', { kind: 'ephemeral' });
    const other = await server.sessions.open('agent-b', { kind: 'ephemeral' });
    try {
      const paths = [
        server.config.stateDirectory,
        join(server.config.stateDirectory, 'tokens.json'),
        join(server.config.stateDirectory, 'tasks', 'press-go', 'task.json'),
        server.config.model!.keyFile,
        session.workspace.profile,
        other.workspace.files,
        other.workspace.sessionHome,
        other.workspace.profile,
      ];
      const result = await server.runner.run(session, 'agent-a', 'probe', undefined, { paths: [...paths, session.workspace.files] });
      assert.equal(result.status, 'passed', result.failure ?? '');
      const output = result.output as { results: Record<string, string>; env: Record<string, string> };
      for (const path of paths) assert.equal(output.results[path], 'EACCES', `the run cannot read ${path}`);
      assert.equal(output.results[session.workspace.files], 'read', 'the run reads its own file area');
      assert.deepEqual(output.env, { E2E_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1' });
      assert.doesNotMatch(result.log, /usage telemetry/, 'the run prints no e2e telemetry notice');
    } finally {
      await Promise.all([server.sessions.close(session, 'closed'), server.sessions.close(other, 'closed')]);
    }
  });

  it('checks services in fresh sessions from the current revision and records their sign-in state', async () => {
    const check = CHECK_SIGNED_IN.replace('__SITE__', `${siteUrl}/`);
    await server.tasks.save('mail-check', check, 'operator');
    await server.profiles.create('mail', 'operator');
    await server.profiles.addService('mail', 'mail', 'mail-check');

    const signedOut = await server.checks.check('mail', 'mail');
    assert.equal(signedOut?.result, 'signed_out');
    assert.equal((await server.profiles.get('mail')).services[0]!.lastCheck?.run, signedOut!.run);

    const seed = await server.sessions.open('operator', { kind: 'profile', profile: 'mail' }, 'sign_in');
    await visit(seed, `${siteUrl}/set`);
    await server.sessions.saveRevision(seed, 'operator', 30_000);
    const signedIn = await server.checks.check('mail', 'mail');
    assert.equal(signedIn?.result, 'signed_in');
    assert.deepEqual((await server.profiles.get('mail')).services[0]!.lastCheck, signedIn);
    assert.equal(server.sessions.list().filter((session) => session.client === CHECK_CLIENT).length, 0, 'check sessions close');

    const recorded = await telemetry.collect();
    assertCataloged(recorded);
    assert.ok(recorded.logs.some((record) => record.body === 'browserctl.service.signed_out' && record.attributes['browserctl.service'] === 'mail'));
    const results = recorded.metrics.filter((metric) => metric.name === 'browserctl.service.checks').map((metric) => metric.attributes['browserctl.check_result']);
    assert.deepEqual(results.sort(), ['signed_in', 'signed_out']);
  });
});
