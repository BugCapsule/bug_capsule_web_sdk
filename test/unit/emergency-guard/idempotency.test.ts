import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IdempotencyConflictError, MemoryIdempotencyStore, withIdempotency } from '../../../packages/emergency-guard/src/index.js';
import { delay } from './helpers.js';

describe('withIdempotency', () => {
  it('concurrent identical requests charge once and all get the first result', async () => {
    const store = new MemoryIdempotencyStore<{ chargeId: string }>();
    let charges = 0;
    const charge = async () => {
      charges += 1;
      await delay(30);
      return { chargeId: `ch_${charges}` };
    };
    const results = await Promise.all(Array.from({ length: 20 }, () => withIdempotency(store, 'order-123', charge, { pollMs: 2 })));
    assert.equal(charges, 1);
    assert.ok(results.every((r) => r.result.chargeId === 'ch_1'));
    assert.equal(results.filter((r) => !r.replayed).length, 1);
    // A later retry replays too.
    assert.deepEqual(await withIdempotency(store, 'order-123', charge), { result: { chargeId: 'ch_1' }, replayed: true });
    assert.equal(charges, 1);
    // Another key runs.
    await withIdempotency(store, 'order-124', charge);
    assert.equal(charges, 2);
  });

  it('a failed attempt is not stored, so a retry runs (e.g. after a block is lifted)', async () => {
    const store = new MemoryIdempotencyStore<string>();
    await assert.rejects(
      withIdempotency(store, 'k', async () => {
        throw new Error('blocked');
      }),
      /blocked/,
    );
    assert.equal(await store.get('k'), null);
    assert.deepEqual(await withIdempotency(store, 'k', async () => 'ok'), { result: 'ok', replayed: false });
  });

  it('a waiting duplicate takes over when the first attempt fails', async () => {
    const store = new MemoryIdempotencyStore<string>();
    let runs = 0;
    const first = withIdempotency(store, 'k', async () => {
      runs += 1;
      await delay(20);
      throw new Error('declined');
    });
    const second = withIdempotency(
      store,
      'k',
      async () => {
        runs += 1;
        return 'second';
      },
      { pollMs: 2 },
    );
    await assert.rejects(first, /declined/);
    assert.deepEqual(await second, { result: 'second', replayed: false });
    assert.equal(runs, 2);
  });

  it('gives up with IdempotencyConflictError (409) when the first request is still running', async () => {
    const store = new MemoryIdempotencyStore<string>();
    const slow = withIdempotency(store, 'k', async () => {
      await delay(100);
      return 'done';
    });
    await assert.rejects(
      withIdempotency(store, 'k', async () => 'dup', { waitMs: 10, pollMs: 2 }),
      (e: unknown) => e instanceof IdempotencyConflictError && e.status === 409 && e.code === 'idempotency_in_progress',
    );
    await slow;
  });

  it('memory store: expired leases can be taken over; completed records expire after the TTL', async () => {
    let now = 1000;
    const store = new MemoryIdempotencyStore<string>({ ttlMs: 500, now: () => now });
    assert.deepEqual(await store.claim('a', 100), { claimed: true });
    assert.equal((await store.claim('a', 100)).claimed, false);
    now += 100;
    assert.deepEqual(await store.claim('a', 100), { claimed: true });
    await store.complete('a', 'r');
    assert.deepEqual(await store.claim('a', 100), { claimed: false, record: { state: 'completed', result: 'r', completedAt: 1100 } });
    now += 500;
    assert.equal(await store.get('a'), null);
  });

  it('memory store: evicts the oldest completed records beyond maxEntries', async () => {
    const store = new MemoryIdempotencyStore<number>({ maxEntries: 3 });
    for (let i = 0; i < 5; i++) await store.complete(`k${i}`, i);
    assert.equal(store.size, 3);
    assert.equal(await store.get('k0'), null);
    assert.deepEqual((await store.get('k4'))?.state, 'completed');
  });

  it('rejects empty or oversized keys', async () => {
    const store = new MemoryIdempotencyStore();
    await assert.rejects(withIdempotency(store, '', async () => 1), TypeError);
    await assert.rejects(withIdempotency(store, 'x'.repeat(256), async () => 1), TypeError);
  });
});
