import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import type { ProviderConfig } from '../../src/config/schema.ts';
import { Providers } from '../../src/providers/external.ts';
import type { Session } from '../../src/sessions/manager.ts';
import { fakeProvider, type FakeProvider } from '../support/fake-provider.ts';
import { eventually } from '../support/processes.ts';
import { runDirectory } from '../support/server.ts';
import { assertCataloged, memoryTelemetry, type MemoryTelemetry } from '../support/telemetry.ts';

/** Wait until a still-held lease has sent three more heartbeats: long enough for any stopped one to have shown. */
async function threeBeatsOf(provider: FakeProvider, lease: string): Promise<void> {
  const beats = () => provider.requests.filter((request) => request.path === `/leases/${lease}/heartbeat`).length;
  const start = beats();
  await eventually(() => beats() >= start + 3);
}

function session(id: string, slot?: number): Session {
  return { id, client: 'agent-a', source: { kind: 'provider', provider: 'fake', ...(slot !== undefined && { slot }) } } as unknown as Session;
}

describe('external provider lease client', () => {
  let run: Awaited<ReturnType<typeof runDirectory>>;
  let provider: FakeProvider;
  let config: ProviderConfig;
  let telemetry: MemoryTelemetry;
  const lost: string[] = [];
  let providers: Providers;

  before(async () => {
    telemetry = memoryTelemetry();
    run = await runDirectory();
    provider = await fakeProvider();
    const tokenFile = join(run.path, 'provider-token');
    await writeFile(tokenFile, `${provider.token}\n`, { mode: 0o600 });
    config = { name: 'fake', leaseUrl: provider.url, cdpHost: '127.0.0.1', tokenFile };
    providers = new Providers([config], { heartbeatMs: 20, onLeaseLost: (lostSession) => lost.push(lostSession.id) });
  });

  after(async () => {
    await provider.close();
    await run.remove();
    await telemetry.restore();
  });

  it('leases, starts, heartbeats, and releases a browser for a session', async () => {
    const { browser, target } = await providers.opener(session('s-one', 2));
    assert.deepEqual(provider.requests.slice(0, 2).map((request) => [request.method, request.path]), [['POST', '/leases'], ['POST', '/leases/lease-1/ensure']]);
    assert.deepEqual(provider.requests[0]!.body, { owner: 'browserctl agent-a s-one', slot: 2 });
    assert.ok(provider.requests.every((request) => request.authorization === `Bearer ${provider.token}`));
    assert.equal((await target.version()).Browser, 'FakeChrome/1');
    await eventually(() => provider.requests.filter((request) => request.path === '/leases/lease-1/heartbeat').length >= 2);

    await providers.poll();
    assert.deepEqual(providers.states()[0]!.slots.map((slot) => [slot.slot, slot.own]), [[2, true]]);

    const clock = await providers.opener(session('s-clock'));
    await browser.stop();
    assert.deepEqual([...provider.leases.keys()], ['lease-2']);
    const count = provider.requests.filter((request) => request.path.startsWith('/leases/lease-1')).length;
    await threeBeatsOf(provider, 'lease-2');
    assert.equal(provider.requests.filter((request) => request.path.startsWith('/leases/lease-1')).length, count, 'no heartbeat after release');
    await clock.browser.stop();
    assert.equal(provider.leases.size, 0);
  });

  it('reports a full provider as a capacity error', async () => {
    provider.full = true;
    try {
      await assert.rejects(providers.opener(session('s-full')), { errorClass: 'capacity', message: 'every browser of provider fake is leased' });
    } finally {
      provider.full = false;
    }
  });

  it('reports a refused token and an unreachable provider as provider errors', async () => {
    const wrong = join(run.path, 'wrong-token');
    await writeFile(wrong, 'b'.repeat(64), { mode: 0o600 });
    const refused = new Providers([{ ...config, tokenFile: wrong }], { onLeaseLost: () => undefined });
    await assert.rejects(refused.opener(session('s-401')), { errorClass: 'provider_unauthorized' });
    const gone = new Providers([{ ...config, leaseUrl: 'http://127.0.0.1:1' }], { onLeaseLost: () => undefined });
    await assert.rejects(gone.opener(session('s-gone')), { errorClass: 'provider_unreachable' });
    await gone.poll();
    assert.deepEqual([gone.states()[0]!.reachable, gone.states()[0]!.error], [false, 'provider_unreachable']);
  });

  it('ends the session when the provider loses its lease', async () => {
    const { browser } = await providers.opener(session('s-lost'));
    const [id] = [...provider.leases.keys()];
    const clock = await providers.opener(session('s-clock'));
    const clockLease = [...provider.leases.keys()].find((lease) => lease !== id)!;
    provider.leases.delete(id!);
    await eventually(() => lost.includes('s-lost'));
    const mine = () => provider.requests.filter((request) => request.path.startsWith(`/leases/${id}`));
    const count = mine().length;
    await threeBeatsOf(provider, clockLease);
    await browser.stop();
    assert.equal(mine().length, count, 'no heartbeat or release after the lease is lost');
    await clock.browser.stop();
  });

  it('ends the session once heartbeats have failed past the provider\'s lease expiry', async () => {
    const expiring = new Providers([config], { heartbeatMs: 20, leaseExpiryMs: 200, onLeaseLost: (lostSession) => lost.push(lostSession.id) });
    const { browser } = await expiring.opener(session('s-expired'));
    const token = provider.token;
    provider.token = 'c'.repeat(64);
    const started = Date.now();
    try {
      await eventually(() => lost.includes('s-expired'));
      assert.ok(Date.now() - started >= 200, 'not before the expiry');
    } finally {
      provider.token = token;
    }
    await browser.stop();
    // The fake provider never expires leases itself.
    provider.leases.clear();
  });

  it('lists other owners\' browsers for read-only watching', async () => {
    provider.others = [{ slot: 3, owner: 'codex' }];
    try {
      await providers.poll();
      assert.deepEqual(providers.states()[0]!.slots.map((slot) => [slot.slot, slot.owner, slot.own]), [[3, 'codex', false]]);
      assert.ok(providers.watchTarget('fake', 3));
      assert.equal(providers.watchTarget('fake', 4), undefined);
    } finally {
      provider.others = [];
    }
  });

  it('forwards relay clients to the provider browser\'s debugging WebSocket', async () => {
    const { browser, target } = await providers.opener(session('s-relay'));
    const front = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((resolve) => front.once('listening', resolve));
    let traffic = 0;
    front.on('connection', (socket) => target.serve(socket, () => (traffic += 1)));
    const client = new WebSocket(`ws://127.0.0.1:${(front.address() as { port: number }).port}`);
    await new Promise((resolve) => client.once('open', resolve));
    const reply = new Promise<{ text: string; isBinary: boolean }>((resolve) => client.once('message', (raw, isBinary) => resolve({ text: raw.toString(), isBinary })));
    client.send('{"id":1,"method":"Browser.getVersion"}');
    assert.deepEqual(await reply, { text: '{"id":1,"method":"Browser.getVersion"}', isBinary: false }, 'text frames stay text, even when sent before the upstream opened');
    assert.equal(traffic, 1);
    client.close();
    front.close();
    await browser.stop();

    const recorded = await telemetry.collect();
    assert.ok(recorded.spans.some((span) => span.name === 'browserctl.lease.request'));
    assert.ok(recorded.logs.some((record) => record.body === 'browserctl.lease.failed'));
    assertCataloged(recorded);
  });
});
