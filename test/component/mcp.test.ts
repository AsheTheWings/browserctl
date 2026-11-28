import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { ALLOWED_TOOLS, capabilityTools, playwrightTools } from '../../src/mcp/allowlist.ts';
import { BrowserctlServer } from '../../src/server/server.ts';
import { mcpClient } from '../support/mcp.ts';
import { eventually } from '../support/processes.ts';
import { runDirectory, testConfig } from '../support/server.ts';
import { assertCataloged, memoryTelemetry, type MemoryTelemetry } from '../support/telemetry.ts';

const initialize = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
});

function post(port: number, headers: Record<string, string>, body = initialize): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body,
  });
}

describe('agent MCP endpoint', () => {
  let run: Awaited<ReturnType<typeof runDirectory>>;
  let server: BrowserctlServer;
  let token: string;
  let telemetry: MemoryTelemetry;

  before(async () => {
    telemetry = memoryTelemetry();
    run = await runDirectory();
    server = new BrowserctlServer(testConfig(run.path));
    await server.start();
    token = await server.tokens.create('agent-a');
  });

  after(async () => {
    await server.stop();
    await run.remove();
    await telemetry.restore();
  });

  it('refuses a missing or wrong token and accepts a valid one', async () => {
    const refused: Array<Record<string, string>> = [{}, { authorization: 'Bearer bctl_wrong' }, { authorization: `Basic ${token}` }];
    for (const headers of refused) {
      const response = await post(server.port, headers);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('www-authenticate'), 'Bearer');
    }
    const accepted = await post(server.port, { authorization: `Bearer ${token}` });
    assert.equal(accepted.status, 200);
    assert.ok(accepted.headers.get('mcp-session-id'));
  });

  it('refuses a revoked token and drops its connections', async () => {
    const doomed = await server.tokens.create('agent-doomed');
    const client = await mcpClient(server.port, doomed);
    const id = client.transport.sessionId!;
    await server.tokens.revoke('agent-doomed');
    assert.equal((await post(server.port, { authorization: `Bearer ${doomed}` })).status, 401);
    const other = await server.tokens.create('agent-other');
    const reused = await post(server.port, { authorization: `Bearer ${other}`, 'mcp-session-id': id }, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    assert.equal(reused.status, 404);
    await client.client.close();
  });

  it('answers another client\'s connection id as unknown', async () => {
    const first = await mcpClient(server.port, token);
    const other = await server.tokens.create('agent-b');
    const response = await post(server.port, { authorization: `Bearer ${other}`, 'mcp-session-id': first.transport.sessionId! }, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    assert.equal(response.status, 404);
    await first.close();
  });

  it('lists the session tools and allowlisted Playwright tools with self-contained descriptions, without the unsafe ones', async () => {
    const client = await mcpClient(server.port, token);
    try {
      assert.equal(client.client.getInstructions(), undefined);
      const { tools } = await client.client.listTools();
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      const names = tools.map((tool) => tool.name);
      for (const name of ['providers_list', 'profiles_list', 'profiles_note_set', 'sessions_list', 'sessions_close', 'session_open', 'session_close', 'session_status', 'session_file_put', 'session_file_get', 'session_secret_prepare', 'session_secrets_list', 'session_secrets_clear', 'session_loopback_allow', 'session_loopback_list', 'session_loopback_clear', 'task_list', 'task_get', 'task_save', 'task_run', 'browser_navigate', 'browser_snapshot', 'browser_tabs', 'browser_pdf_save']) {
        assert.ok(names.includes(name), name);
      }
      assert.match(byName.get('session_open')!.description ?? '', /Take over/);
      assert.match(byName.get('session_open')!.description ?? '', /dashboard_url/);
      assert.match(byName.get('session_open')!.description ?? '', /loopback_ports/);
      assert.match(byName.get('session_status')!.description ?? '', /takeover/);
      assert.match(byName.get('session_loopback_allow')!.description ?? '', /443/);
      assert.match(byName.get('browser_take_screenshot')!.description ?? '', /session_file_get/);
      const shotFilename = (byName.get('browser_take_screenshot')!.inputSchema.properties as Record<string, { description?: string }>).filename;
      assert.ok(shotFilename);
      assert.match(shotFilename.description ?? '', /session file area/);
      assert.doesNotMatch(shotFilename.description ?? '', /workspace root/);
      assert.match(byName.get('browser_snapshot')!.description ?? '', /16 KiB/);
      assert.match(byName.get('browser_type')!.description ?? '', /\{\{secret:NAME\}\}/);
      const sourceSchema = (byName.get('session_open')!.inputSchema.properties as Record<string, Record<string, unknown>>).source;
      assert.ok(sourceSchema);
      assert.equal(sourceSchema.type, 'object');
      assert.ok(sourceSchema.properties && 'type' in (sourceSchema.properties as object));
      assert.ok(!names.includes('browser_run_code_unsafe'));
      assert.ok(!names.includes('browser_close'));
      assert.ok(names.every((name) => ALLOWED_TOOLS.has(name) || name === 'providers_list' || name.startsWith('profiles_') || name.startsWith('session_') || name.startsWith('sessions_') || name.startsWith('task_')));
      assert.deepEqual((await playwrightTools()).map((tool) => tool.name).sort(), [...ALLOWED_TOOLS].sort(), 'every allowlisted tool exists');
      // A tool a later Playwright MCP adds to these capabilities fails here until the allowlist decides on it.
      const offered = (await capabilityTools()).map((tool) => tool.name).filter((name) => !ALLOWED_TOOLS.has(name));
      assert.deepEqual(offered.sort(), ['browser_close', 'browser_run_code_unsafe']);

      const unsafe = await client.call('browser_run_code_unsafe', { code: 'async () => 1' });
      assert.deepEqual([unsafe.isError, unsafe.text], [true, 'unknown tool browser_run_code_unsafe']);
      assert.equal((await client.call('browser_close')).text, 'unknown tool browser_close');
    } finally {
      await client.close();
    }
  });

  it('refuses browser and file tools while no session is bound', async () => {
    const client = await mcpClient(server.port, token);
    try {
      for (const name of ['browser_navigate', 'session_close', 'session_file_get', 'session_secret_prepare', 'session_secrets_list', 'session_secrets_clear']) {
        const result = await client.call(name, { url: 'about:blank', name: 'x' });
        assert.deepEqual([result.isError, result.text], [true, 'no session is bound; call session_open first'], name);
      }
      assert.deepEqual((await client.call('session_status')).json(), { bound: false });
      assert.deepEqual((await client.call('profiles_list')).json(), []);
      const bad = await client.call('session_open', { profile: 'mail', ephemeral: true });
      assert.deepEqual([bad.isError, bad.text], [true, 'give either profile or ephemeral, not both']);
      const managedOnly = await client.call('session_open', { provider: 'managed' });
      assert.deepEqual([managedOnly.isError, managedOnly.text], [true, 'provider managed requires ephemeral: true, profile, or source']);
      const missing = await client.call('session_open', { profile: 'nope' });
      assert.deepEqual([missing.isError, missing.text], [true, 'no profile nope']);
    } finally {
      await client.close();
    }
    const recorded = await telemetry.collect();
    assert.ok(recorded.spans.some((span) => span.name === 'browserctl.mcp.tool_call' && span.attributes['browserctl.tool'] === 'unknown'));
    assertCataloged(recorded);
  });

  it('advertises the session source and task revision constraints', async () => {
    const client = await mcpClient(server.port, token);
    try {
      const { tools } = await client.client.listTools();
      const validator = new AjvJsonSchemaValidator();
      const open = tools.find((tool) => tool.name === 'session_open');
      assert.ok(open);
      const validateOpen = validator.getValidator(open.inputSchema);
      for (const input of [
        { profile: 'mail' }, { profile: 'mail', provider: 'managed' }, { profile: 'mail', provider: 'example', slot: 1 },
        { ephemeral: true }, { ephemeral: true, provider: 'managed' }, { ephemeral: true, provider: 'managed', loopback_ports: [443, 7430] },
        { ephemeral: true, wait_seconds: 10 }, { provider: 'example' }, { provider: 'example', slot: 1 },
      ]) {
        assert.equal(validateOpen(input).valid, true, JSON.stringify(input));
      }
      for (const input of [
        {}, { profile: 'mail', ephemeral: true }, { ephemeral: false }, { ephemeral: true, wait_seconds: -1 },
        { ephemeral: true, wait_seconds: 61 }, { slot: 1 }, { profile: 'mail', slot: 1 },
        { ephemeral: true, provider: 'managed', slot: 1 }, { ephemeral: true, loopback_ports: [0] },
        { ephemeral: true, loopback_ports: [65536] }, { ephemeral: true, loopback_ports: Array.from({ length: 33 }, (_, i) => i + 1) },
      ]) {
        assert.equal(validateOpen(input).valid, false, JSON.stringify(input));
      }
      const ephemeral = { type: 'ephemeral' };
      const profile = { type: 'profile', name: 'mail' };
      const existing = { type: 'existing' };
      for (const input of [{ source: ephemeral }, { source: profile }, { source: profile, provider: 'example', slot: 1 },
        { source: existing, provider: 'workstation' }]) {
        assert.equal(validateOpen(input).valid, true, JSON.stringify(input));
      }
      for (const input of [{ source: ephemeral, slot: 1 }, { source: profile, provider: 'managed', slot: 1 },
        { source: { type: 'profile' } }, { source: profile, profile: 'mail' }, { source: profile, ephemeral: true },
        { source: existing }, { source: existing, provider: 'managed' }, { source: existing, provider: 'workstation', slot: 1 },
        { source: existing, provider: 'workstation', loopback_ports: [443] },
        { source: { ...existing, name: 'a' }, provider: 'workstation' }]) {
        assert.equal(validateOpen(input).valid, false, JSON.stringify(input));
      }
      for (const input of [{ source: existing }, { source: existing, provider: 'managed' }, { source: existing, provider: 'workstation', slot: 1 }]) {
        assert.match((await client.call('session_open', input)).text, /requires an explicit attach provider without a slot/);
      }
      assert.match(
        (await client.call('session_open', { source: existing, provider: 'workstation', loopback_ports: [443] })).text,
        /loopback_ports is not supported/,
      );
      for (const name of ['task_get', 'task_run']) {
        const tool = tools.find((candidate) => candidate.name === name);
        assert.ok(tool);
        const validateTask = validator.getValidator(tool.inputSchema);
        assert.equal(validateTask({ name: 'example' }).valid, true);
        assert.equal(validateTask({ name: 'example', revision: '1' }).valid, true);
        assert.equal(validateTask({ name: 'example', revision: 1 }).valid, false);
        assert.equal(validateTask({ name: 'example', revision: '1234567890123' }).valid, false);
      }
      const invalidRevision = await client.call('task_get', { name: 'example', revision: 1 });
      assert.deepEqual([invalidRevision.isError, invalidRevision.text], [true, 'a revision ID must be a string of 1 to 12 digits']);

      const prepare = tools.find((candidate) => candidate.name === 'session_secret_prepare');
      assert.ok(prepare);
      const validatePrepare = validator.getValidator(prepare.inputSchema);
      for (const input of [{ name: 'APP_PASS' }, { name: 'APP_PASS', format: 'value', trim_newline: false }, { format: 'env' }, { format: 'env', name: 'APP_PASS' }]) {
        assert.equal(validatePrepare(input).valid, true, JSON.stringify(input));
      }
      for (const input of [{}, { format: 'value' }, { name: '1bad' }, { format: 'json', name: 'A' }, { name: 'A', extra: 1 }]) {
        assert.equal(validatePrepare(input).valid, false, JSON.stringify(input));
      }

      assert.equal((await fetch(`http://127.0.0.1:${server.port}/session-secrets/not-a-capability`, { method: 'PUT', body: 'x' })).status, 404);
      const wrongMethod = await fetch(`http://127.0.0.1:${server.port}/session-secrets/${'A'.repeat(43)}`, { method: 'POST', body: 'x' });
      assert.equal(wrongMethod.status, 405);
      assert.equal(wrongMethod.headers.get('allow'), 'PUT');
      assert.equal((await fetch(`http://127.0.0.1:${server.port}/session-secrets/${'A'.repeat(43)}`, { method: 'PUT', body: 'x' })).status, 404);
    } finally {
      await client.close();
    }
  });

  it('keeps connections with a live SSE stream across idle sweeps and drops detached idle ones with telemetry', async () => {
    const client = await mcpClient(server.port, token);
    const liveSid = client.transport.sessionId!;
    const detachedInit = await post(server.port, { authorization: `Bearer ${token}` });
    assert.equal(detachedInit.status, 200);
    const detachedSid = detachedInit.headers.get('mcp-session-id')!;
    assert.ok(detachedSid);

    const streamInit = await post(server.port, { authorization: `Bearer ${token}` });
    assert.equal(streamInit.status, 200);
    const streamSid = streamInit.headers.get('mcp-session-id')!;
    const streamAbort = new AbortController();
    try {
      // Wait for mcpClient's standalone GET /mcp SSE stream to attach (a second GET returns 409 without leaking activeStreams).
      await eventually(async () => {
        const duplicate = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
          headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream', 'mcp-session-id': liveSid },
        });
        await duplicate.body?.cancel();
        return duplicate.status === 409;
      }, 5_000);

      const sse = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream', 'mcp-session-id': streamSid },
        signal: streamAbort.signal,
      });
      assert.equal(sse.status, 200);

      await server.mcp.sweep(Date.now() + server.config.idleSeconds * 1000);

      // Both connections with open SSE streams stay alive and answer requests.
      assert.deepEqual((await client.call('session_status')).json(), { bound: false });
      const stillAlive = await post(server.port, { authorization: `Bearer ${token}`, 'mcp-session-id': streamSid }, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
      assert.equal(stillAlive.status, 200);

      // The detached connection with no SSE stream was swept and rejects further requests with 404.
      const rejected = await post(server.port, { authorization: `Bearer ${token}`, 'mcp-session-id': detachedSid }, JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }));
      assert.equal(rejected.status, 404);

      // Once the standalone SSE stream disconnects without closing the session, the idle sweep drops it too.
      streamAbort.abort();
      await eventually(async () => {
        await server.mcp.sweep(Date.now() + server.config.idleSeconds * 1000);
        const res = await post(server.port, { authorization: `Bearer ${token}`, 'mcp-session-id': streamSid }, JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }));
        return res.status === 404;
      }, 5_000);

      const recorded = await telemetry.collect();
      assert.ok(recorded.logs.some((log) => log.body === 'browserctl.mcp.connection_closed' && log.attributes['browserctl.mcp.close_reason'] === 'idle'));
      assert.ok(recorded.logs.some((log) => log.body === 'browserctl.mcp.session_rejected' && log.attributes['error.type'] === 'not_found'));
      assertCataloged(recorded);
    } finally {
      streamAbort.abort();
      await client.close();
    }
  });

  it('lists the managed provider and rejects ambiguous or invalid explicit browser sources', async () => {
    const client = await mcpClient(server.port, token);
    try {
      assert.deepEqual((await client.call('providers_list')).json(), [
        {
          name: 'managed',
          description: 'Browserctl-managed browsers and saved profiles.',
          reachable: true,
          sources: ['ephemeral', 'profile'],
          capacity: { total: server.config.sessionLimit, used: 0, available: server.config.sessionLimit, queued: 0 },
        },
      ]);
      for (const args of [{ source: null }, { source: { type: 'profile' } }, { source: { type: 'ephemeral' }, slot: 0 },
        { source: { type: 'ephemeral' }, ephemeral: true }, { source: { type: 'ephemeral', name: 'work' } }]) {
        assert.ok((await client.call('session_open', args)).isError, JSON.stringify(args));
      }
      assert.equal((await client.call('session_open', { source: { type: 'profile', name: 'missing' } })).text, 'no profile missing');
    } finally {
      await client.close();
    }
  });

  it('lets only a granted client claim or update its own note and lists both notes without slots', async () => {
    const name = 'mcp-notes';
    await server.profiles.create(name, 'operator');
    const writer = await mcpClient(server.port, token);
    const reader = await mcpClient(server.port, await server.tokens.create('notes-reader'));
    const args = { profile: name, text: '  Intended use  ' };
    try {
      assert.ok((await writer.call('profiles_note_set', args)).isError);
      await server.tokens.setProfileNotes('agent-a', true);
      assert.ok((await reader.call('profiles_note_set', args)).isError);
      for (const extras of [{ client: 'operator' }, { slot: 'operator' }]) {
        assert.ok((await writer.call('profiles_note_set', { ...args, ...extras })).isError);
      }
      const operator = await server.profiles.setNote(name, 'operator', 'Operator context', 'dashboard:development');
      assert.equal((await writer.call('profiles_note_set', { ...args, text: 'initial' })).isError, false);
      await server.tokens.setProfileNotes('notes-reader', true);
      assert.ok((await reader.call('profiles_note_set', args)).isError);
      const result = (await writer.call('profiles_note_set', args)).json();
      assert.equal(result.client, 'agent-a');
      assert.equal(result.text, 'Intended use');
      assert.deepEqual(Object.keys(result).sort(), ['client', 'text', 'updated_at']);
      const listed = (await reader.call('profiles_list')).json();
      assert.deepEqual(listed.find((profile: { name: string }) => profile.name === name), {
        name, provider: 'managed', current_revision: '1', services: [], notes: [
          { client: operator.client, text: operator.text, updated_at: operator.updatedAt }, result,
        ],
      });
      await server.tokens.setProfileNotes('agent-a', false);
      assert.ok((await writer.call('profiles_note_set', args)).isError);
      assert.equal((await server.profiles.get(name)).notes?.agent?.text, result.text);
      assert.ok(!(JSON.stringify(await telemetry.collect()).includes('Intended use')));
    } finally {
      await server.tokens.setProfileNotes('agent-a', false);
      await server.tokens.setProfileNotes('notes-reader', false);
      await writer.close();
      await reader.close();
      await server.profiles.delete(name);
    }
  });

  it('gates sessions_list and sessions_close behind manageSessions and guards sign_in sessions', async () => {
    const manager = await mcpClient(server.port, token);
    const outsider = await mcpClient(server.port, await server.tokens.create('session-outsider'));
    try {
      // Denied by default
      assert.deepEqual(
        [(await manager.call('sessions_list')).isError, (await manager.call('sessions_list')).text],
        [true, 'this client cannot manage sessions'],
      );
      assert.deepEqual(
        [(await manager.call('sessions_close', { session_id: 's-123456789012' })).isError, (await manager.call('sessions_close', { session_id: 's-123456789012' })).text],
        [true, 'this client cannot manage sessions'],
      );

      // Granted only to agent-a, not outsider
      await server.tokens.setManageSessions('agent-a', true);
      assert.equal((await outsider.call('sessions_list')).isError, true);
      assert.deepEqual((await manager.call('sessions_list')).json(), []);

      // Input validation and not_found
      assert.match((await manager.call('sessions_list', { extra: 1 })).text, /takes no arguments/);
      assert.match((await manager.call('sessions_close', { session_id: 'bad' })).text, /valid session ID/);
      assert.match((await manager.call('sessions_close', { session_id: 's-123456789012' })).text, /no session s-123456789012/);

      // Exercise listing, cross-client close, and sign_in force guardrail via a fake SessionManager port
      const fakeRun = await runDirectory();
      const { HttpRouter } = await import('../../src/server/http.ts');
      const { McpEndpoint } = await import('../../src/mcp/endpoint.ts');
      const { Providers } = await import('../../src/providers/external.ts');
      const fakeSessions = new Map<string, any>([
        ['s-signin000001', {
          id: 's-signin000001', client: 'dashboard:development', purpose: 'sign_in',
          source: { kind: 'profile', profile: 'signin-guard' },
          createdAt: Date.now() - 5000, lastActivity: Date.now() - 2000, state: 'ready',
        }],
        ['s-agent0000002', {
          id: 's-agent0000002', client: 'other-agent', purpose: 'agent',
          source: { kind: 'ephemeral', runtime: 'instabox' },
          createdAt: Date.now() - 3000, lastActivity: Date.now() - 1000, state: 'ready',
        }],
      ]);
      const fakeManager = {
        onClose: () => undefined,
        list: () => [...fakeSessions.values()],
        get: (id: string) => fakeSessions.get(id),
        close: async (session: { id: string }) => { fakeSessions.delete(session.id); },
        managedCapacity: () => ({ total: 4, used: 1, available: 3, queued: 0 }),
      } as any;
      const router = new HttpRouter();
      const endpoint = new McpEndpoint({
        tokens: server.tokens,
        sessions: fakeManager,
        profiles: server.profiles,
        providers: new Providers([], { onLeaseLost: () => undefined }),
        tasks: server.tasks,
        runner: server.runner,
        audit: server.audit,
        path: server.config.path,
        publicBaseUrl: 'http://127.0.0.1:1',
        version: '0.0.0',
        idleSeconds: 60,
      });
      endpoint.mount(router);
      const port = await router.listen('127.0.0.1', 0);
      const mgmtClient = await mcpClient(port, token);
      try {
        const listed = (await mgmtClient.call('sessions_list')).json();
        assert.equal(listed.length, 2);
        const signInRow = listed.find((row: { id: string }) => row.id === 's-signin000001');
        assert.equal(signInRow.client, 'dashboard:development');
        assert.equal(signInRow.purpose, 'sign_in');
        assert.equal(signInRow.provider, 'managed');
        assert.equal(signInRow.profile, 'signin-guard');
        assert.equal(signInRow.own_connection, false);
        assert.equal('capability' in signInRow, false);

        // Closing another client's agent session works without force
        const closedAgent = await mgmtClient.call('sessions_close', { session_id: 's-agent0000002' });
        assert.equal(closedAgent.isError, false, closedAgent.text);
        assert.deepEqual(closedAgent.json(), { closed: 's-agent0000002', client: 'other-agent', purpose: 'agent' });

        // Closing sign_in without force fails with conflict
        const blocked = await mgmtClient.call('sessions_close', { session_id: 's-signin000001' });
        assert.equal(blocked.isError, true);
        assert.match(blocked.text, /force: true/);

        // Closing sign_in with force: true succeeds
        const closedSignIn = await mgmtClient.call('sessions_close', { session_id: 's-signin000001', force: true });
        assert.equal(closedSignIn.isError, false, closedSignIn.text);
        assert.deepEqual(closedSignIn.json(), { closed: 's-signin000001', client: 'dashboard:development', purpose: 'sign_in' });
        assert.deepEqual((await mgmtClient.call('sessions_list')).json(), []);
      } finally {
        await mgmtClient.close();
        await endpoint.stop();
        await router.close();
        await fakeRun.remove();
      }
    } finally {
      await server.tokens.setManageSessions('agent-a', false);
      await manager.close();
      await outsider.close();
    }
  });

  it('returns structured capacity details and alternatives when session_open hits capacity', async () => {
    const capRun = await runDirectory();
    const { fakeProvider } = await import('../support/fake-provider.ts');
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { BrowserctlError } = await import('../../src/errors.ts');
    const { HttpRouter } = await import('../../src/server/http.ts');
    const { McpEndpoint } = await import('../../src/mcp/endpoint.ts');
    const { Providers } = await import('../../src/providers/external.ts');
    const fake = await fakeProvider();
    const tokenFile = join(capRun.path, 'fake-token');
    await writeFile(tokenFile, `${fake.token}\n`, { mode: 0o600 });
    const providers = new Providers([{ name: 'pool', leaseUrl: fake.url, cdpHost: '127.0.0.1', tokenFile }], { onLeaseLost: () => undefined });
    await providers.poll();
    const receivedTimeouts: number[] = [];
    const fakeManager = {
      onClose: () => undefined,
      managedCapacity: () => ({ total: 2, used: 2, available: 0, queued: 0 }),
      open: async (_client: string, _source: unknown, _purpose: string, _signal?: AbortSignal, options?: { queueTimeoutMs?: number }) => {
        receivedTimeouts.push(options?.queueTimeoutMs ?? -1);
        throw new BrowserctlError('capacity', 'every managed browser is in use; try again later');
      },
    } as any;
    const router = new HttpRouter();
    const endpoint = new McpEndpoint({
      tokens: server.tokens,
      sessions: fakeManager,
      profiles: server.profiles,
      providers,
      tasks: server.tasks,
      runner: server.runner,
      audit: server.audit,
      path: server.config.path,
      publicBaseUrl: 'http://127.0.0.1:1',
      version: '0.0.0',
      idleSeconds: 60,
    });
    endpoint.mount(router);
    const port = await router.listen('127.0.0.1', 0);
    const client = await mcpClient(port, token);
    try {
      const result = await client.call('session_open', { ephemeral: true });
      assert.equal(result.isError, true);
      assert.deepEqual(receivedTimeouts, [0]);
      const body = result.json();
      assert.equal(body.error, 'capacity');
      assert.equal(body.provider, 'managed');
      assert.equal(body.message, 'every managed browser is in use; try again later');
      assert.deepEqual(body.capacity, { total: 2, used: 2, available: 0, queued: 0 });
      assert.deepEqual(body.alternatives, [{ provider: 'pool', sources: [] }]);

      // Explicit wait_seconds forwards queueTimeoutMs
      await client.call('session_open', { ephemeral: true, wait_seconds: 15 });
      assert.deepEqual(receivedTimeouts, [0, 15_000]);
    } finally {
      await client.close();
      await endpoint.stop();
      await router.close();
      await fake.close();
      await capRun.remove();
    }
  });

  it('returns an image content block for named browser_take_screenshot calls without leaking outside the file area', async () => {
    const shotRun = await runDirectory();
    const { mkdir, symlink, writeFile } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const { HttpRouter } = await import('../../src/server/http.ts');
    const { McpEndpoint } = await import('../../src/mcp/endpoint.ts');
    const { Providers } = await import('../../src/providers/external.ts');
    const filesDir = join(shotRun.path, 'files');
    const outsideFile = join(shotRun.path, 'outside.png');
    await mkdir(filesDir, { recursive: true });
    await writeFile(outsideFile, Buffer.from('secret-outside-image'));
    await symlink(outsideFile, join(filesDir, 'link.png'));
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const webpBytes = Buffer.from('RIFF\0\0\0\0WEBP');
    const inlinePng = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    let closedSession: (() => void) | undefined;
    const session: any = {
      id: 's-shots0000001',
      client: 'agent-a',
      purpose: 'agent',
      source: { kind: 'ephemeral' },
      state: 'ready',
      createdAt: Date.now(),
      lastActivity: Date.now(),
      users: { sessionUid: process.getuid!(), gid: process.getgid!() },
      workspace: { files: filesDir, downloads: filesDir, uploads: join(filesDir, 'uploads'), sessionHome: shotRun.path },
      closers: [] as Array<() => Promise<void>>,
    };
    const fakeManager = {
      onClose: (listener: (closed: any) => void) => { closedSession = () => listener(session); },
      open: async () => session,
      endpoint: () => 'http://127.0.0.1:1/cdp',
      touch: () => undefined,
      close: async () => {
        session.state = 'closed';
        closedSession?.();
      },
      managedCapacity: () => ({ total: 1, used: 1, available: 0, queued: 0 }),
    } as any;
    const fakeWorker = {
      exited: new Promise<void>(() => undefined),
      stop: async () => undefined,
      async call(tool: string, args: Record<string, unknown>) {
        assert.equal(tool, 'browser_take_screenshot');
        if (args.filename === 'error.png') {
          await writeFile(join(filesDir, 'error.png'), jpegBytes);
          return { content: [{ type: 'text', text: 'failed' }], isError: true };
        }
        if (typeof args.filename === 'string' && args.filename.length > 0) {
          if (args.filename === 'shots/dark.jpg') {
            await mkdir(dirname(join(filesDir, args.filename)), { recursive: true });
            await writeFile(join(filesDir, args.filename), jpegBytes);
          } else if (args.filename === 'override.png') {
            await writeFile(join(filesDir, args.filename), webpBytes);
          }
          return { content: [{ type: 'text', text: `### Result\n- [Screenshot of viewport](./${args.filename})` }] };
        }
        return {
          content: [
            { type: 'text', text: '### Result\n- [Screenshot of viewport](./page.png)' },
            { type: 'image', data: inlinePng.toString('base64'), mimeType: 'image/png' },
          ],
        };
      },
    } as any;
    const router = new HttpRouter();
    const endpoint = new McpEndpoint({
      tokens: server.tokens,
      sessions: fakeManager,
      profiles: server.profiles,
      providers: new Providers([], { onLeaseLost: () => undefined }),
      tasks: server.tasks,
      runner: server.runner,
      audit: server.audit,
      path: server.config.path,
      publicBaseUrl: 'http://127.0.0.1:1',
      version: '0.0.0',
      idleSeconds: 60,
      startWorker: async () => fakeWorker,
    });
    endpoint.mount(router);
    const port = await router.listen('127.0.0.1', 0);
    const client = await mcpClient(port, token);
    try {
      const opened = await client.call('session_open', { ephemeral: true });
      assert.equal(opened.isError, false);
      assert.equal(opened.json().takeover, false);
      assert.equal(opened.json().dashboard_url, 'http://127.0.0.1:1/dashboard/');
      const status = (await client.call('session_status')).json();
      assert.equal(status.takeover, false);
      assert.equal(status.dashboard_url, 'http://127.0.0.1:1/dashboard/');

      const named = await client.call('browser_take_screenshot', { filename: 'shots/dark.jpg', scale: 'css' });
      assert.equal(named.isError, false);
      assert.deepEqual(named.content.filter((item) => item.type === 'image'), [
        { type: 'image', data: jpegBytes.toString('base64'), mimeType: 'image/jpeg' },
      ]);

      const explicitType = await client.call('browser_take_screenshot', { filename: 'override.png', type: 'webp', scale: 'css' });
      assert.deepEqual(explicitType.content.filter((item) => item.type === 'image'), [
        { type: 'image', data: webpBytes.toString('base64'), mimeType: 'image/webp' },
      ]);

      const unnamed = await client.call('browser_take_screenshot', { scale: 'css' });
      assert.deepEqual(unnamed.content.filter((item) => item.type === 'image'), [
        { type: 'image', data: inlinePng.toString('base64'), mimeType: 'image/png' },
      ]);

      for (const badName of ['../outside.png', 'link.png', 'missing.png']) {
        const res = await client.call('browser_take_screenshot', { filename: badName, scale: 'css' });
        assert.equal(res.isError, false);
        assert.deepEqual(res.content.filter((item) => item.type === 'image'), [], badName);
      }

      const failed = await client.call('browser_take_screenshot', { filename: 'error.png', scale: 'css' });
      assert.equal(failed.isError, true);
      assert.deepEqual(failed.content.filter((item) => item.type === 'image'), []);
    } finally {
      await client.close();
      await endpoint.stop();
      await router.close();
      await shotRun.remove();
    }
  });

  it('inlines bounded action snapshots, redacts loaded secrets in them, and refuses paths outside the file area', async () => {
    const snapRun = await runDirectory();
    const { mkdir, symlink, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { HttpRouter } = await import('../../src/server/http.ts');
    const { McpEndpoint } = await import('../../src/mcp/endpoint.ts');
    const { MAX_INLINE_SNAPSHOT_BYTES } = await import('../../src/mcp/snapshot.ts');
    const { Providers } = await import('../../src/providers/external.ts');
    const filesDir = join(snapRun.path, 'files');
    const outsideFile = join(snapRun.path, 'outside.yml');
    await mkdir(filesDir, { recursive: true });
    await writeFile(outsideFile, '- heading "secret-outside-yaml"\n');
    await symlink(outsideFile, join(filesDir, 'link.yml'));
    await writeFile(join(filesDir, 'small.yml'), '- textbox "Password": top-secret-val\n- button "Save" [ref=e7]\n');
    await writeFile(join(filesDir, 'big.yml'), 'x'.repeat(MAX_INLINE_SNAPSHOT_BYTES + 10));

    let closedSession: (() => void) | undefined;
    const session: any = {
      id: 's-snaps0000001',
      client: 'agent-a',
      purpose: 'agent',
      source: { kind: 'ephemeral' },
      state: 'ready',
      createdAt: Date.now(),
      lastActivity: Date.now(),
      users: { sessionUid: process.getuid!(), gid: process.getgid!() },
      workspace: { files: filesDir, downloads: filesDir, uploads: join(filesDir, 'uploads'), sessionHome: snapRun.path },
      closers: [] as Array<() => Promise<void>>,
    };
    const fakeManager = {
      onClose: (listener: (closed: any) => void) => { closedSession = () => listener(session); },
      open: async () => session,
      get: (id: string) => (id === session.id ? session : undefined),
      endpoint: () => 'http://127.0.0.1:1/cdp',
      touch: () => undefined,
      close: async () => {
        session.state = 'closed';
        closedSession?.();
      },
      managedCapacity: () => ({ total: 1, used: 1, available: 0, queued: 0 }),
    } as any;
    const fakeWorker = {
      exited: new Promise<void>(() => undefined),
      stop: async () => undefined,
      async call(tool: string, args: Record<string, unknown>) {
        if (tool === 'browser_snapshot') {
          return { content: [{ type: 'text', text: '### Snapshot\n- [Snapshot](./small.yml)' }] };
        }
        const target = String(args.url ?? './small.yml');
        return { content: [{ type: 'text', text: `### Page\n- Page URL: http://127.0.0.1/\n### Snapshot\n- [Snapshot](${target})` }] };
      },
    } as any;
    const router = new HttpRouter();
    const endpoint = new McpEndpoint({
      tokens: server.tokens,
      sessions: fakeManager,
      profiles: server.profiles,
      providers: new Providers([], { onLeaseLost: () => undefined }),
      tasks: server.tasks,
      runner: server.runner,
      audit: server.audit,
      path: server.config.path,
      publicBaseUrl: 'http://127.0.0.1:1',
      version: '0.0.0',
      idleSeconds: 60,
      startWorker: async () => fakeWorker,
    });
    endpoint.mount(router);
    const port = await router.listen('127.0.0.1', 0);
    const client = await mcpClient(port, token);
    try {
      const opened = await client.call('session_open', { ephemeral: true });
      assert.equal(opened.isError, false);
      assert.equal(opened.json().takeover, false);
      assert.equal(opened.json().dashboard_url, 'http://127.0.0.1:1/dashboard/');
      const status = (await client.call('session_status')).json();
      assert.equal(status.takeover, false);
      assert.equal(status.dashboard_url, 'http://127.0.0.1:1/dashboard/');
      const prep = (await client.call('session_secret_prepare', { format: 'env', name: 'APP_PASS' })).json();
      const put = await fetch(`http://127.0.0.1:${port}${prep.path}`, { method: 'PUT', body: "APP_PASS='top-secret-val'\n" });
      assert.equal(put.status, 200);

      const small = await client.call('browser_navigate', { url: './small.yml' });
      assert.match(small.text, /```yaml\n- textbox "Password": <secret>APP_PASS<\/secret>\n- button "Save" \[ref=e7\]\n```/);
      assert.ok(!small.text.includes('top-secret-val'));

      const big = await client.call('browser_navigate', { url: './big.yml' });
      assert.match(big.text, /- \[Snapshot\]\(\.\/big\.yml\) \(\d+ bytes; call browser_snapshot with root or depth to inspect\)/);

      for (const bad of ['../outside.yml', './link.yml', './missing.yml']) {
        const res = await client.call('browser_navigate', { url: bad });
        assert.match(res.text, new RegExp(`- \\[Snapshot\\]\\(${bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`));
        assert.ok(!res.text.includes('secret-outside-yaml'));
      }

      const explicitFile = await client.call('browser_snapshot', { filename: 'small.yml' });
      assert.equal(explicitFile.text, '### Snapshot\n- [Snapshot](./small.yml)');
    } finally {
      await client.close();
      await endpoint.stop();
      await router.close();
      await snapRun.remove();
    }
  });

  it('supports loopback_ports on session_open with authorization and reports previous_close_reason after expiry or disconnect', async () => {
    const loopRun = await runDirectory();
    const { join } = await import('node:path');
    const { BrowserctlError } = await import('../../src/errors.ts');
    const { HttpRouter } = await import('../../src/server/http.ts');
    const { McpEndpoint } = await import('../../src/mcp/endpoint.ts');
    const { Providers } = await import('../../src/providers/external.ts');
    const allowedPorts = new Set<number>();
    let closeListener: ((session: any, reason: any) => void) | undefined;
    let closedCount = 0;
    let openedCount = 0;
    let currentSession: any;
    const fakeManager = {
      onClose: (listener: (session: any, reason: any) => void) => { closeListener = listener; },
      open: async (_client: string, source: unknown) => {
        openedCount += 1;
        allowedPorts.clear();
        currentSession = {
          id: `s-loop0000000${openedCount}`,
          client: 'agent-a',
          purpose: 'agent',
          source,
          state: 'ready',
          createdAt: Date.now(),
          lastActivity: Date.now(),
          users: { sessionUid: process.getuid!(), gid: process.getgid!() },
          workspace: { files: loopRun.path, downloads: loopRun.path, uploads: join(loopRun.path, 'uploads'), sessionHome: loopRun.path },
          loopbackProxy: {
            hosts: ['127.0.0.1'],
            allow(port: number) {
              if (port === 8317) throw new BrowserctlError('invalid_request', 'port 8317 is denied');
              allowedPorts.add(port);
              return [...allowedPorts];
            },
            list: () => [...allowedPorts],
            revoke: () => [],
          },
          closers: [] as Array<() => Promise<void>>,
        };
        return currentSession;
      },
      endpoint: () => 'http://127.0.0.1:1/cdp',
      touch: () => undefined,
      close: async (session: any, reason: any) => {
        closedCount += 1;
        session.state = 'closed';
        closeListener?.(session, reason);
      },
      managedCapacity: () => ({ total: 2, used: 0, available: 2, queued: 0 }),
    } as any;
    const fakeWorker = { exited: new Promise<void>(() => undefined), stop: async () => undefined, call: async () => ({ content: [{ type: 'text', text: 'ok' }] }) } as any;
    const router = new HttpRouter();
    const endpoint = new McpEndpoint({
      tokens: server.tokens,
      sessions: fakeManager,
      profiles: server.profiles,
      providers: new Providers([], { onLeaseLost: () => undefined }),
      tasks: server.tasks,
      runner: server.runner,
      audit: server.audit,
      path: server.config.path,
      publicBaseUrl: 'http://127.0.0.1:1',
      version: '0.0.0',
      idleSeconds: 60,
      startWorker: async () => fakeWorker,
    });
    endpoint.mount(router);
    const port = await router.listen('127.0.0.1', 0);
    const client = await mcpClient(port, token);
    try {
      // Denied before opening when client lacks loopback permission
      const denied = await client.call('session_open', { provider: 'managed', ephemeral: true, loopback_ports: [443] });
      assert.deepEqual([denied.isError, denied.text], [true, 'this client cannot allow loopback ports']);
      assert.equal(openedCount, 0);

      await server.tokens.setLoopback('agent-a', true);

      // Denied port closes the newly opened session cleanly
      const badPort = await client.call('session_open', { provider: 'managed', ephemeral: true, loopback_ports: [443, 8317] });
      assert.equal(badPort.isError, true);
      assert.match(badPort.text, /8317 is denied/);
      assert.equal(closedCount, 1);
      assert.deepEqual((await client.call('session_status')).json(), { bound: false });

      // Valid open with provider: managed + ephemeral + loopback_ports deduplicates and exposes loopback_allowed
      const opened = await client.call('session_open', { provider: 'managed', ephemeral: true, loopback_ports: [443, 7430, 443] });
      assert.equal(opened.isError, false, opened.text);
      assert.deepEqual(opened.json().loopback_allowed, [443, 7430]);

      // Idle timeout sets previous_close_reason and actionable error
      closeListener?.(currentSession, 'idle');
      assert.deepEqual((await client.call('session_status')).json(), { bound: false, previous_close_reason: 'idle' });
      const afterIdle = await client.call('browser_navigate', { url: 'http://127.0.0.1:7430/' });
      assert.equal(afterIdle.isError, true);
      assert.match(afterIdle.text, /idle timeout/);

      // Re-opening clears previous_close_reason; lease_lost reports disconnect
      const reopened = await client.call('session_open', { ephemeral: true });
      assert.equal(reopened.isError, false);
      closeListener?.(currentSession, 'lease_lost');
      assert.deepEqual((await client.call('session_status')).json(), { bound: false, previous_close_reason: 'lease_lost' });
      const afterDrop = await client.call('browser_navigate', { url: 'about:blank' });
      assert.match(afterDrop.text, /disconnected/);

      // Explicit session_close clears previous_close_reason
      await client.call('session_open', { ephemeral: true });
      await client.call('session_close');
      assert.deepEqual((await client.call('session_status')).json(), { bound: false });
    } finally {
      await server.tokens.setLoopback('agent-a', false);
      await client.close();
      await endpoint.stop();
      await router.close();
      await loopRun.remove();
    }
  });
});
