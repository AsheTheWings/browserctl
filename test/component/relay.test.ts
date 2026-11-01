import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { ManagedTarget, Relay } from '../../src/browser/relay.ts';
import { HttpRouter } from '../../src/server/http.ts';
import { fakeBrowser, type FakeBrowser } from '../support/fake-cdp.ts';

interface Client {
  socket: WebSocket;
  messages: Array<Record<string, unknown>>;
  call(message: Record<string, unknown>): Promise<Record<string, unknown>>;
  next(predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
  closed: Promise<number>;
}

async function connect(url: string): Promise<Client> {
  const socket = new WebSocket(url);
  const messages: Array<Record<string, unknown>> = [];
  const waiters: Array<{ predicate: (message: Record<string, unknown>) => boolean; resolve: (message: Record<string, unknown>) => void }> = [];
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString()) as Record<string, unknown>;
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  const next = (predicate: (message: Record<string, unknown>) => boolean) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const found = messages.find(predicate);
      if (found) resolve(found);
      else waiters.push({ predicate, resolve });
    });
  return {
    socket,
    messages,
    closed,
    next,
    call: (message) => {
      socket.send(JSON.stringify(message));
      return next((reply) => reply.id === message.id);
    },
  };
}

describe('CDP relay', () => {
  const router = new HttpRouter();
  const relay = new Relay();
  let base: string;
  let browser: FakeBrowser;
  let registration: ReturnType<Relay['register']>;
  let traffic = 0;

  before(async () => {
    relay.mount(router);
    base = `http://127.0.0.1:${await router.listen('127.0.0.1', 0)}`;
    browser = fakeBrowser();
    registration = relay.register(new ManagedTarget(browser.cdp), () => (traffic += 1));
  });

  after(() => router.close());

  it('issues 256-bit capability paths and answers /json/version under them', async () => {
    assert.match(registration.capability, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(registration.capability, 'base64url').length, 32);
    for (const suffix of ['/json/version', '/json/version/']) {
      const response = await fetch(`${registration.endpoint(base)}${suffix}`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as Record<string, string>;
      assert.equal(body.Browser, 'FakeChrome/1');
      assert.equal(body.webSocketDebuggerUrl, `${registration.endpoint(base).replace('http:', 'ws:')}/devtools/browser`);
    }
  });

  it('answers 404 to every other path', async () => {
    const wrong = `${base}/cdp/${'A'.repeat(43)}/json/version`;
    for (const url of [wrong, `${registration.endpoint(base)}/json/list`, `${base}/cdp`, `${base}/cdp/short/json/version`]) {
      assert.equal((await fetch(url)).status, 404, url);
    }
    await assert.rejects(connect(`${wrong.replace('http:', 'ws:').replace('/json/version', '')}/devtools/browser`), /404/);
    await assert.rejects(connect(`${registration.endpoint(base).replace('http:', 'ws:')}/devtools/page/1`), /404/);
  });

  it('gives each client its own browser session and routes replies and events to it alone', async () => {
    const url = `${registration.endpoint(base).replace('http:', 'ws:')}/devtools/browser`;
    const first = await connect(url);
    const second = await connect(url);
    const before = traffic;
    const firstReply = await first.call({ id: 1, method: 'Test.where' });
    const secondReply = await second.call({ id: 1, method: 'Test.where' });
    assert.ok(traffic > before);
    const firstRoot = (firstReply.result as { on: string }).on;
    const secondRoot = (secondReply.result as { on: string }).on;
    assert.match(firstRoot, /^browser-/);
    assert.notEqual(firstRoot, secondRoot);
    assert.equal(firstReply.sessionId, undefined, 'the root session is hidden from its client');

    const attached = await first.call({ id: 2, method: 'Target.attachToTarget', params: { targetId: 't' } });
    const child = (attached.result as { sessionId: string }).sessionId;
    await first.next((message) => message.method === 'Target.attachedToTarget');
    const onChild = await first.call({ id: 3, method: 'Test.where', sessionId: child });
    assert.equal((onChild.result as { on: string }).on, child);
    assert.equal(onChild.sessionId, child);

    const refused = await second.call({ id: 4, method: 'Test.where', sessionId: child });
    assert.deepEqual(refused.error, { code: -32001, message: 'Session with given id not found.' });
    assert.equal(browser.received.filter((message) => message.sessionId === child && message.method === 'Test.where').length, 1, 'the refused call never reached the browser');

    browser.emit(child, 'Page.frameNavigated');
    browser.emit(firstRoot, 'Target.targetCreated');
    browser.emit(secondRoot, 'Target.targetDestroyed');
    await first.next((message) => message.method === 'Page.frameNavigated');
    await first.next((message) => message.method === 'Target.targetCreated');
    await second.next((message) => message.method === 'Target.targetDestroyed');
    assert.ok(!second.messages.some((message) => message.method === 'Page.frameNavigated' || message.method === 'Target.targetCreated'));
    assert.ok(!first.messages.some((message) => message.method === 'Target.targetDestroyed'));

    await second.call({ id: 5, method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true } });
    const auto = await second.next((message) => message.method === 'Target.attachedToTarget');
    const autoChild = (auto.params as { sessionId: string }).sessionId;
    assert.equal((await second.call({ id: 6, method: 'Test.where', sessionId: autoChild })).sessionId, autoChild);

    const own = await second.call({ id: 7, method: 'Target.attachToBrowserTarget' });
    const ownRoot = (own.result as { sessionId: string }).sessionId;
    assert.equal((await second.call({ id: 8, method: 'Test.where', sessionId: ownRoot })).sessionId, ownRoot);
    assert.equal((await first.call({ id: 9, method: 'Test.where', sessionId: ownRoot })).error !== undefined, true);

    second.socket.close();
    await second.closed;
    await waitFor(() => browser.detached.includes(secondRoot));
    first.socket.close();
    await first.closed;
  });

  it('closes connections and answers 404 once the capability is revoked', async () => {
    const client = await connect(`${registration.endpoint(base).replace('http:', 'ws:')}/devtools/browser`);
    registration.revoke();
    assert.equal(await client.closed, 1001);
    assert.equal((await fetch(`${registration.endpoint(base)}/json/version`)).status, 404);
    await assert.rejects(connect(`${registration.endpoint(base).replace('http:', 'ws:')}/devtools/browser`), /404/);
  });

  it('ends a derived capability on its own revoke or its parent\'s', async () => {
    const parent = relay.register(new ManagedTarget(browser.cdp), () => undefined);
    const first = parent.derive(() => undefined);
    assert.notEqual(first.capability, parent.capability);
    assert.equal((await fetch(`${first.endpoint(base)}/json/version`)).status, 200);
    first.revoke();
    assert.equal((await fetch(`${first.endpoint(base)}/json/version`)).status, 404);
    assert.equal((await fetch(`${parent.endpoint(base)}/json/version`)).status, 200, 'the parent outlives a derived capability');
    const second = parent.derive(() => undefined);
    const client = await connect(`${second.endpoint(base).replace('http:', 'ws:')}/devtools/browser`);
    parent.revoke();
    assert.equal(await client.closed, 1001);
    assert.equal((await fetch(`${second.endpoint(base)}/json/version`)).status, 404);
    assert.throws(() => parent.derive(() => undefined), /revoked/);
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setImmediate(resolve));
  }
}
