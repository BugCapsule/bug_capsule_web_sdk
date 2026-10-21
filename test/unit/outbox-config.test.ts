import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MemoryStorage } from '../../packages/web/src/storage/idb.js';
import { UploadOutbox, saveCapture, MAX_SAVED_CAPTURES } from '../../packages/web/src/storage/outbox.js';
import { RemoteConfigController, configScope, parseRemoteConfig, type ConfigFetchResult } from '../../packages/web/src/remote-config.js';
import type { UploadResult } from '../../packages/web/src/types.js';

const gz = (n = 10) => new Uint8Array([0x1f, 0x8b, ...new Array(n).fill(7)]);

describe('UploadOutbox', () => {
  it('defaults: 10 capsules, 10 MiB, 7 days; oldest evicted first', async () => {
    let t = 1_000;
    const outbox = new UploadOutbox(new MemoryStorage(), {}, 'l', () => t++);
    assert.deepEqual(outbox.limits, { maxCount: 10, maxBytes: 10 * 1024 * 1024, maxAgeMs: 7 * 86_400_000 });
    for (let i = 0; i < 12; i++) assert.equal(await outbox.enqueue(`c${i}`, gz()), true);
    assert.deepEqual((await outbox.entries()).map((e) => e.capsuleId), ['c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10', 'c11']);
  });

  it('evicts by size and age; never queues a capsule larger than the outbox', async () => {
    let t = 0;
    const outbox = new UploadOutbox(new MemoryStorage(), { maxBytes: 100, maxAgeMs: 1000 }, 'l', () => t);
    assert.equal(await outbox.enqueue('big', gz(200)), false);
    await outbox.enqueue('a', gz(40));
    t = 10;
    await outbox.enqueue('b', gz(40));
    t = 20;
    await outbox.enqueue('c', gz(40)); // 3 × 42 > 100: a evicted
    assert.deepEqual((await outbox.entries()).map((e) => e.capsuleId), ['b', 'c']);
    t = 2000;
    await outbox.open(); // expired
    assert.deepEqual(await outbox.entries(), []);
  });

  it('uploads oldest first; drops permanent rejections; stops and backs off on retryable failures', async () => {
    let t = 0;
    const storage = new MemoryStorage();
    const outbox = new UploadOutbox(storage, {}, 'l', () => t, () => 0.5);
    for (const id of ['a', 'b', 'c']) {
      await outbox.enqueue(id, gz());
      t++;
    }
    const seen: number[] = [];
    const results: UploadResult[] = [{ status: 'rejected', message: 'invalid' }, { status: 'retryLater' }, { status: 'uploaded' }];
    await outbox.flush({ upload: async (b) => (seen.push(b.length), results.shift()!), allowed: () => true });
    assert.equal(seen.length, 2, 'the pass stops at the retryable failure');
    assert.deepEqual((await outbox.entries()).map((e) => e.capsuleId), ['b', 'c']);
    assert.equal(await outbox.retryAt(), t + 30_000);
    // Within the backoff nothing is attempted.
    let calls = 0;
    await outbox.flush({ upload: async () => (calls++, { status: 'uploaded' }), allowed: () => true });
    assert.equal(calls, 0);
    t += 30_001;
    await outbox.flush({ upload: async () => (calls++, { status: 'uploaded' }), allowed: () => true });
    assert.equal(calls, 2);
    assert.deepEqual(await outbox.entries(), []);
  });

  it('exponential backoff 30 s → 1 h; Retry-After wins when longer and survives reopening', async () => {
    let t = 0;
    const storage = new MemoryStorage();
    const outbox = new UploadOutbox(storage, {}, 'l', () => t, () => 0.5);
    await outbox.enqueue('a', gz());
    const delays: number[] = [];
    for (let i = 0; i < 9; i++) {
      await outbox.flush({ upload: async () => ({ status: 'retryLater' }), allowed: () => true });
      const at = (await outbox.retryAt())!;
      delays.push(at - t);
      t = at;
    }
    assert.deepEqual(delays, [30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000]);
    await outbox.flush({ upload: async () => ({ status: 'retryLater', retryAfterMs: 7_200_000 }), allowed: () => true });
    assert.equal((await outbox.retryAt())! - t, 7_200_000);
    const reopened = new UploadOutbox(storage, {}, 'l', () => t);
    await reopened.open();
    assert.equal((await reopened.retryAt())! - t, 7_200_000, 'a server deadline survives a reload');
  });

  it('a reload retries network failures at once (like an app restart)', async () => {
    const storage = new MemoryStorage();
    const outbox = new UploadOutbox(storage, {}, 'l', () => 0, () => 0.5);
    await outbox.enqueue('a', gz());
    await outbox.flush({ upload: async () => ({ status: 'retryLater' }), allowed: () => true });
    assert.notEqual(await outbox.retryAt(), null);
    const reopened = new UploadOutbox(storage, {}, 'l', () => 0);
    await reopened.open();
    assert.equal(await reopened.retryAt(), null);
  });

  it('drops corrupt records, honours allowed(), purges everything on the kill switch', async () => {
    const storage = new MemoryStorage();
    const outbox = new UploadOutbox(storage, {}, 'l', () => 0);
    await outbox.enqueue('good', gz());
    await storage.update('outbox', () => ({ put: [{ id: '0_bad', capsuleId: 'bad', enqueuedAt: 0, size: 3, bytes: new Uint8Array([1, 2, 3]) }], result: null }));
    let uploads = 0;
    await outbox.flush({ upload: async () => (uploads++, { status: 'uploaded' }), allowed: () => false });
    assert.equal(uploads, 0, 'nothing is sent while uploads are not allowed');
    assert.equal((await outbox.entries()).length, 2);
    await outbox.flush({ upload: async () => (uploads++, { status: 'uploaded' }), allowed: () => true });
    assert.equal(uploads, 1, 'the corrupt record is dropped, not sent');
    assert.deepEqual(await outbox.entries(), []);
    await outbox.enqueue('good2', gz());
    await outbox.enqueue('x', gz());
    assert.equal(await outbox.purge(), 2);
    assert.deepEqual(await outbox.entries(), []);
  });

  it('a second flusher holding the lease makes a flush a no-op', async () => {
    const storage = new MemoryStorage();
    const a = new UploadOutbox(storage, {}, 'shared', () => 0);
    await a.enqueue('a', gz());
    assert.equal(await storage.tryLease('shared', 'other-tab', 60_000, 0), true);
    const r = await a.flush({ upload: async () => ({ status: 'uploaded' }), allowed: () => true, onlyId: 'a' });
    assert.equal(r?.status, 'retryLater');
    assert.equal((await a.entries()).length, 1);
    await storage.releaseLease('shared', 'other-tab');
    const r2 = await a.flush({ upload: async () => ({ status: 'uploaded' }), allowed: () => true, onlyId: 'a' });
    assert.equal(r2?.status, 'uploaded');
  });

  it('keeps the newest 20 saved captures', async () => {
    const storage = new MemoryStorage();
    for (let i = 0; i < 25; i++) await saveCapture(storage, `s${i}`, gz(), i);
    const list = await storage.list('captures');
    assert.equal(list.length, MAX_SAVED_CAPTURES);
    assert.equal(list[0]!.capsuleId, 's5');
  });
});

describe('RemoteConfigController', () => {
  const ok = (over: Record<string, unknown> = {}, at = 0): ConfigFetchResult => ({ ok: true, config: parseRemoteConfig({ enabled: true, sampleRate: 1, ...over }, at) });

  it('parses and clamps the backend config; rejects wrong types', () => {
    const c = parseRemoteConfig({ sampleRate: 7, configTtlSeconds: 999_999, maxCapsuleBytes: 0, redactKeys: ['a', 1] }, 5);
    assert.deepEqual(c, {
      enabled: true,
      sampleRate: 1,
      maxCapsuleBytes: 1,
      captureNetworkBodies: true,
      redactKeys: ['a', '1'],
      configTtlSeconds: 86_400,
      fetchedAtMs: 5,
      // monitoring-v1 §10 defaults
      monitoringEnabled: true,
      errorSampleRate: 1,
      tracesSampleRate: null,
      sessionTracking: true,
      maxBreadcrumbs: 100,
      tracePropagationTargets: null,
    });
    assert.throws(() => parseRemoteConfig({ enabled: 'yes' }));
  });

  it('caches per backend URL and ingest key; a config for another scope is ignored', async () => {
    const storage = new MemoryStorage();
    const scope = configScope({ url: 'https://prod', ingestKey: 'bci_a' });
    assert.notEqual(scope, configScope({ url: 'https://staging', ingestKey: 'bci_a' }));
    const c1 = new RemoteConfigController({ fetch: async () => ok({ enabled: false }, 100), storage, scope, onChange: () => {}, now: () => 100 });
    await c1.refresh();
    c1.dispose();
    const same = new RemoteConfigController({ fetch: async () => ok(), storage, scope, onChange: () => {} });
    await same.loadCached();
    assert.equal(same.current?.enabled, false, 'a cached kill switch applies however old it is');
    assert.equal(same.captureAllowed, false);
    const other = new RemoteConfigController({ fetch: async () => ok(), storage, scope: 'other', onChange: () => {} });
    await other.loadCached();
    assert.equal(other.current, null);
  });

  it('uploads need an enabled config fetched within maxStale; TTL decides freshness', async () => {
    let now = 0;
    const c = new RemoteConfigController({ fetch: async () => ok({ configTtlSeconds: 300 }, now), storage: new MemoryStorage(), scope: 's', onChange: () => {}, now: () => now, maxStaleMs: 1000 * 60 * 60 });
    assert.equal(c.uploadsAllowed, false, 'nothing is uploaded before a fetch succeeds');
    await c.refresh();
    assert.equal(c.uploadsAllowed, true);
    assert.equal(c.isFresh, true);
    now = 301_000;
    assert.equal(c.isFresh, false);
    now = 3_600_001;
    assert.equal(c.uploadsAllowed, false, 'stale beyond maxStale');
    c.dispose();
  });

  it('401/403 stops capture for the session and notifies a disabled config', async () => {
    const changes: boolean[] = [];
    const c = new RemoteConfigController({
      fetch: async () => ({ ok: false, message: 'HTTP 401', status: 401 }),
      storage: new MemoryStorage(),
      scope: 's',
      onChange: (_p, n) => changes.push(n.enabled),
      random: () => 0.5,
    });
    await c.refresh();
    assert.deepEqual(changes, [false]);
    assert.equal(c.captureAllowed, false);
    assert.equal(c.uploadsAllowed, false);
    c.dispose();
  });
});
