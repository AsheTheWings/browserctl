import assert from 'node:assert/strict';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { it } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { Providers } from '../../src/providers/external.ts';
import type { Session } from '../../src/sessions/manager.ts';
import { runDirectory } from '../support/server.ts';

it('discovers only existing, relays one authenticated attachment, rejects Browser.close and detaches', { timeout: 10_000 }, async () => {
  const run = await runDirectory();
  const tokenFile = join(run.path, 'attach-token');
  const token = 'A'.repeat(43);
  const headers = { authorization: `Bearer ${token}` };
  const upstream = new WebSocketServer({ noServer: true });
  const downstream = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  let requester: string | string[] | undefined;
  let broker: WebSocket | undefined;
  let handshakes = 0;
  let lastCommand: string | undefined;
  const endpoint = createServer((request, response) => {
    assert.equal(request.url, '/v1/capabilities');
    assert.equal(request.headers.authorization, headers.authorization);
    response.end(JSON.stringify({ protocol: 'browserctl.existing-browser.v1', sources: ['existing'] }));
  });
  const sockets: WebSocket[] = [];
  const signal = AbortSignal.timeout(8_000);
  try {
    endpoint.listen(0, '127.0.0.1');
    await Promise.all([once(endpoint, 'listening', { signal }), once(downstream, 'listening', { signal })]);
    await writeFile(tokenFile, token, { mode: 0o600 });
    endpoint.on('upgrade', (request, socket, head) => {
      assert.equal(request.url, '/v1/attach/existing');
      assert.equal(request.headers.authorization, headers.authorization);
      requester = request.headers['x-browserctl-client'];
      handshakes++;
      if (requester === 'denied') {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      if (requester === 'cancel') { endpoint.emit('pending', socket); return; }
      upstream.handleUpgrade(request, socket, head, (ws) => {
        broker = ws;
        ws.on('message', (data) => {
          const cmd = JSON.parse(data.toString());
          lastCommand = cmd.method;
          ws.send(JSON.stringify({ id: cmd.id, result: {} }));
        });
      });
    });
    const origin = `http://127.0.0.1:${(endpoint.address() as { port: number }).port}`;
    let lost = 0;
    const providers = new Providers([{ name: 'workstation', attachUrl: origin, tokenFile }], { onLeaseLost: () => { lost++; } });
    await providers.poll();
    assert.deepEqual(providers.inventory('workstation'), { sources: ['existing'], profiles: [] });
    assert.equal(providers.managedRuntimeState('workstation'), null);
    assert.equal(providers.watchTarget('workstation', 1), undefined);
    const source = { kind: 'provider', provider: 'workstation', browserSource: { type: 'existing' } } as const;
    const session = { source, purpose: 'agent', client: 'attached-agent' } as Session;
    for (const invalid of [{ ...source, browserSource: undefined }, { ...source, browserSource: { type: 'ephemeral' } }, { ...source, slot: 1 }]) {
      await assert.rejects(providers.opener({ ...session, source: invalid } as Session), /only accepts an explicit existing source/);
    }
    assert.equal(handshakes, 0);
    await assert.rejects(providers.opener({ ...session, client: 'denied' }), { errorClass: 'unauthorized' });
    const cancel = new AbortController();
    const pending = once(endpoint, 'pending', { signal });
    const attempt = providers.opener({ ...session, client: 'cancel' }, cancel.signal);
    const [pendingSocket] = await pending;
    pendingSocket.resume();
    const abandoned = once(pendingSocket, 'end', { signal });
    cancel.abort();
    await assert.rejects(attempt, /attachment request was canceled/);
    await abandoned;
    pendingSocket.destroy();

    const { browser, target } = await providers.opener(session);
    assert.equal(requester, session.client);
    downstream.on('connection', (socket) => target!.serve(socket, () => undefined));
    const connect = () => {
      const ws = new WebSocket(`ws://127.0.0.1:${(downstream.address() as { port: number }).port}`);
      sockets.push(ws);
      return ws;
    };
    const worker = connect();
    await once(worker, 'open', { signal });
    const exchange = async (id: number, method: string) => {
      const response = once(worker, 'message', { signal });
      worker.send(JSON.stringify({ id, method }));
      return JSON.parse(String((await response)[0]));
    };
    assert.deepEqual(await exchange(1, 'Browser.getVersion'), { id: 1, result: {} });
    assert.match((await exchange(2, 'Browser.close')).error.message, /cannot be closed/);
    assert.equal(lastCommand, 'Browser.getVersion');
    const outsider = connect();
    const [code] = await once(outsider, 'close', { signal });
    assert.equal(code, 1008);
    const detached = once(broker!, 'close', { signal });
    await browser.stop();
    await detached;
    assert.equal(lost, 1);
    assert.equal(handshakes, 3);
  } finally {
    broker?.terminate();
    for (const socket of sockets) socket.terminate();
    upstream.close();
    downstream.close();
    endpoint.close();
    await run.remove();
  }
});
