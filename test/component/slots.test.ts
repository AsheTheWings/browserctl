import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Slots } from '../../src/sessions/slots.ts';

describe('managed-session limit', () => {
  it('queues requests in order and refuses one that waits past its deadline', async () => {
    const slots = new Slots(1);
    const first = await slots.acquire(1000);
    const order: string[] = [];
    const second = slots.acquire(10_000).then((release) => {
      order.push('second');
      return release;
    });
    const third = slots.acquire(10_000).then((release) => {
      order.push('third');
      return release;
    });
    await assert.rejects(slots.acquire(1), /every managed browser is in use/);
    first();
    first();
    (await second)();
    (await third)();
    assert.deepEqual(order, ['second', 'third']);
    assert.equal(slots.used, 0);
  });

  it('refuses every waiting request at once', async () => {
    const slots = new Slots(1);
    const held = await slots.acquire(1000);
    const waiting = [slots.acquire(10_000), slots.acquire(10_000)];
    slots.refuseWaiting(new Error('stopping'));
    for (const request of waiting) await assert.rejects(request, /stopping/);
    held();
    assert.equal(slots.used, 0);
  });
});
