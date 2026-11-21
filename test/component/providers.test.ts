import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import type { ProviderConfig } from '../../src/config/schema.ts';
import { Providers } from '../../src/providers/external.ts';
import { LeaseClient } from '../../src/providers/lease-client.ts';
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

  it('recognizes profile management only when opted in and advertised', async () => {
    const profileTokenFile = join(run.path, 'profile-management-token');
    await writeFile(profileTokenFile, Buffer.alloc(32, 11).toString('base64url'), { mode: 0o600 });
    const manager = new Providers([{ ...config, profileTokenFile }], { onLeaseLost: () => undefined });
    const start = provider.requests.length;
    try {
      provider.inventory = { sources: ['profile'], profiles: ['work'], profileManagement: 1 };
      await providers.poll();
      assert.deepEqual(providers.inventory('fake'), { sources: ['profile'], profiles: ['work'] });
      await manager.poll();
      assert.deepEqual(manager.inventory('fake'), provider.inventory);

      provider.inventory = { sources: ['ephemeral'], profiles: [], profileManagement: 1 };
      await manager.poll();
      assert.deepEqual(manager.inventory('fake'), { sources: ['ephemeral'], profiles: [] });
      assert.ok(provider.requests.slice(start).every((request) => request.authorization === `Bearer ${provider.token}`));
    } finally {
      provider.inventory = undefined;
      await providers.poll();
    }
  });

  it('uses only the management credential for profile requests and validates the reply', async () => {
    const profileTokenFile = join(run.path, 'operations-token');
    const token = Buffer.alloc(32, 12).toString('base64url');
    await writeFile(profileTokenFile, token, { mode: 0o600 });
    const revision = { id: 'revision-1', createdAt: '2026-01-01T00:00:00.000Z', client: 'dashboard:test', pinned: false };
    const entry = { name: 'work', current: revision.id, revisions: [revision] };
    const requests: Array<{ path: string; method?: string; body: unknown }> = [];
    let reply: unknown = { profiles: [entry] };
    const lease = new LeaseClient({ ...config, profileTokenFile }, async (url, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token}`);
      assert.equal(init?.redirect, 'error');
      requests.push({ path: new URL(String(url)).pathname, method: init?.method, body: init?.body && JSON.parse(String(init.body)) });
      return Response.json(reply);
    });
    assert.deepEqual(await lease.listProfiles(), [entry]);
    reply = { ...entry, revisions: [{ ...revision, pinned: true }] };
    await lease.setProfileRevision('work', revision.id, true);
    assert.deepEqual(requests, [
      { path: '/profiles', method: 'GET', body: undefined },
      { path: '/profiles/work/pin', method: 'PUT', body: { revision: 'revision-1', pinned: true } },
    ]);
    reply = { profiles: [{ ...entry, current: 'not-in-history' }] };
    await assert.rejects(lease.listProfiles(), { errorClass: 'provider_error' });
    await assert.rejects(lease.deleteProfile('../another'), { errorClass: 'invalid_request' });
    assert.equal(requests.length, 3, 'an invalid name is never sent to the provider');
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

  it('opens an advertised profile only through its authenticated lease and never offers it for watching', async () => {
    const source = { type: 'profile', name: 'work' } as const;
    const requested = session('s-profile', 4);
    if (requested.source.kind !== 'provider') throw new Error('test needs a provider source');
    requested.source.browserSource = source;
    const before = provider.requests.filter((request) => request.path === '/leases').length;
    await providers.poll();
    await assert.rejects(providers.opener(requested), { errorClass: 'invalid_request' });
    assert.equal(provider.requests.filter((request) => request.path === '/leases').length, before);
    provider.inventory = { sources: ['profile'], profiles: ['work'] };
    try {
      await providers.poll();
      assert.deepEqual(providers.inventory('fake'), provider.inventory);
      requested.source.browserSource = { type: 'profile', name: 'missing' };
      await assert.rejects(providers.opener(requested), { errorClass: 'not_found' });
      requested.source.browserSource = source;
      const { browser, target } = await providers.opener(requested);
      try {
        const granted = provider.requests.filter((request) => request.path === '/leases').at(-1)!;
        assert.deepEqual(granted.body.source, source);
        const [lease] = [...provider.leases.keys()];
        const version = `/leases/${lease}/cdp/json/version`;
        assert.deepEqual(await target.version(), { Browser: 'FakeChrome/1' });
        assert.ok(provider.requests.some((request) => request.path === version && request.authorization === `Bearer ${provider.token}`));
        assert.equal((await fetch(`${provider.url}${version}`)).status, 401);
        await providers.poll();
        assert.equal(providers.watchTarget('fake', 4), undefined);
        const front = new WebSocketServer({ port: 0, host: '127.0.0.1' });
        await new Promise((resolve) => front.once('listening', resolve));
        front.on('connection', (socket) => target.serve(socket, () => undefined));
        const downstream = new WebSocket(`ws://127.0.0.1:${(front.address() as { port: number }).port}`);
        try {
          await new Promise<void>((resolve, reject) => { downstream.once('open', resolve); downstream.once('error', reject); });
          const reply = new Promise<string>((resolve, reject) => {
            downstream.once('message', (data) => resolve(data.toString()));
            downstream.once('close', () => reject(new Error('lease relay closed')));
          });
          downstream.send('private');
          assert.equal(await reply, 'private');
        } finally {
          downstream.terminate();
          front.close();
        }
      } finally {
        await browser.stop();
      }
      assert.equal(provider.leases.size, 0);
    } finally {
      delete provider.inventory;
      await providers.poll();
    }
  });
});
