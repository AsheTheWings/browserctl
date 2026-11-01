import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ALLOWED_TOOLS, playwrightTools } from '../../src/mcp/allowlist.ts';
import { BrowserctlServer } from '../../src/server/server.ts';
import { mcpClient } from '../support/mcp.ts';
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

  it('lists the session tools and allowlisted Playwright tools, without the unsafe ones', async () => {
    const client = await mcpClient(server.port, token);
    try {
      const names = (await client.client.listTools()).tools.map((tool) => tool.name);
      for (const name of ['profiles_list', 'session_open', 'session_close', 'session_status', 'session_file_put', 'session_file_get', 'browser_navigate', 'browser_snapshot', 'browser_tabs', 'browser_pdf_save']) {
        assert.ok(names.includes(name), name);
      }
      assert.ok(!names.includes('browser_run_code_unsafe'));
      assert.ok(!names.includes('browser_close'));
      assert.ok(names.every((name) => ALLOWED_TOOLS.has(name) || name.startsWith('profiles_') || name.startsWith('session_')));
      assert.deepEqual((await playwrightTools()).map((tool) => tool.name).sort(), [...ALLOWED_TOOLS].sort(), 'every allowlisted tool exists');

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
      for (const name of ['browser_navigate', 'session_close', 'session_file_get']) {
        const result = await client.call(name, { url: 'about:blank', name: 'x' });
        assert.deepEqual([result.isError, result.text], [true, 'no session is bound; call session_open first'], name);
      }
      assert.deepEqual((await client.call('session_status')).json(), { bound: false });
      assert.deepEqual((await client.call('profiles_list')).json(), []);
      const bad = await client.call('session_open', { profile: 'mail', ephemeral: true });
      assert.deepEqual([bad.isError, bad.text], [true, 'give exactly one of profile, ephemeral, or provider']);
      const missing = await client.call('session_open', { profile: 'nope' });
      assert.deepEqual([missing.isError, missing.text], [true, 'no profile nope']);
    } finally {
      await client.close();
    }
    const recorded = await telemetry.collect();
    assert.ok(recorded.spans.some((span) => span.name === 'browserctl.mcp.tool_call' && span.attributes['browserctl.tool'] === 'unknown'));
    assertCataloged(recorded);
  });

  it('drops idle connections that bind no session', async () => {
    const client = await mcpClient(server.port, token);
    const before = server.mcp.size;
    await server.mcp.sweep(Date.now() + server.config.idleSeconds * 1000);
    assert.equal(server.mcp.size, 0);
    assert.ok(before > 0);
    await client.client.close();
  });
});
