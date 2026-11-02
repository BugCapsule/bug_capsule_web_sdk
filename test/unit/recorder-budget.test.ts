import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { BugCapsule } from '../../packages/web/src/bugcapsule.js';
import { DEFAULT_RECORDER_MAX_BYTES, FlightRecorder, approxBytes, type Checkpoint } from '../../packages/web/src/core/index.js';
import { networkIntegration } from '../../packages/web/src/integrations/network.js';
import { parseRemoteConfig, type BugCapsuleTransport } from '../../packages/web/src/remote-config.js';
import { MemoryStorage } from '../../packages/web/src/storage/idb.js';
import type { UploadResult } from '../../packages/web/src/types.js';

/** BC-ENT-036: the recorder's retained-byte budget. */

const launch: Checkpoint = { kind: 'launch', t: 0, wallClockMs: 0, afterSeq: 0, data: {} };
const http = (n: number, bodyBytes: number) => ({ key: `k${n}`, method: 'GET', url: `https://api.test/${n}`, status: 200, responseBody: 'x'.repeat(bodyBytes), bodyEncoding: 'json' });

describe('FlightRecorder byte budget', () => {
  it('approxBytes counts strings, bytes and structure without serializing', () => {
    assert.equal(approxBytes('abcd'), 6);
    assert.equal(approxBytes(new Uint8Array(100)), 100);
    assert.ok(approxBytes({ body: 'x'.repeat(1000) }) >= 1000);
    const deep: Record<string, unknown> = {};
    let cur = deep;
    for (let i = 0; i < 1000; i++) cur = cur.next = {} as Record<string, unknown>;
    assert.ok(approxBytes(deep) < 1000, 'depth-capped');
  });

  it('defaults to 8 MiB and changes nothing under the budget', () => {
    const r = new FlightRecorder(launch);
    assert.equal(r.maxBytes, DEFAULT_RECORDER_MAX_BYTES);
    assert.equal(DEFAULT_RECORDER_MAX_BYTES, 8 * 1024 * 1024);
    for (let i = 0; i < 10; i++) r.add(i, 'http', http(i, 1000));
    assert.equal(r.truncated, false);
    assert.ok(r.window().events.every((e) => typeof e.data.responseBody === 'string'));
  });

  it('drops bodies oldest first before evicting any event', () => {
    const r = new FlightRecorder(launch, 20_000, 300_000, 4, 50_000);
    for (let i = 0; i < 8; i++) r.add(i, 'http', http(i, 10_000));
    r.add(8, 'log', { level: 'info', message: 'keep me' });
    const w = r.window();
    assert.equal(w.events.length, 9, 'no event evicted');
    assert.equal(w.droppedEvents, 0);
    assert.ok(r.retainedBytes <= 50_000);
    assert.ok(r.truncated);
    assert.equal(r.bytesEvicted, 0);
    const bodies = w.events.filter((e) => e.type === 'http').map((e) => e.data.responseBody !== null);
    // The oldest lost their bodies; the newest kept theirs.
    assert.deepEqual(bodies, [false, false, false, false, true, true, true, true]);
    const stripped = w.events[0]!.data;
    assert.equal(stripped.bodyEncoding, 'truncated');
    assert.equal(stripped.key, 'k0', 'the request key is kept so replay still matches');
    assert.equal(r.bodiesDropped, 4);
  });

  it('then evicts the oldest events, counted as dropped, and the window starts at a checkpoint after them', () => {
    const r = new FlightRecorder(launch, 20_000, 300_000, 4, 20_000);
    for (let i = 0; i < 10; i++) r.add(i, 'log', { message: 'm'.repeat(3000) });
    r.addCheckpoint({ kind: 'periodic', t: 10, wallClockMs: 10, afterSeq: r.lastSeq, data: {} });
    for (let i = 10; i < 14; i++) r.add(i, 'log', { message: 'm'.repeat(3000) });
    assert.ok(r.retainedBytes <= 20_000);
    assert.ok(r.bytesEvicted > 0);
    assert.equal(r.droppedEvents, r.bytesEvicted);
    const w = r.window();
    assert.equal(w.checkpoint.kind, 'periodic');
    assert.equal(w.hasGap, false);
    assert.deepEqual(w.events.map((e) => e.seq), [11, 12, 13, 14]);
  });

  it('stays within budget under a 1k-req/s synthetic load', () => {
    const budget = 2 * 1024 * 1024;
    const r = new FlightRecorder(launch, 20_000, 300_000, 4, budget);
    let max = 0;
    for (let i = 0; i < 10_000; i++) {
      r.add(i, 'http', http(i, (i % 7) * 4096));
      if (i % 500 === 0) r.addCheckpoint({ kind: 'periodic', t: i, wallClockMs: i, afterSeq: r.lastSeq, data: {} });
      max = Math.max(max, r.retainedBytes);
    }
    assert.ok(max <= budget, `peak ${max} > ${budget}`);
    const sum = r.window().events.reduce((s, e) => s + approxBytes(e.data), 0);
    assert.ok(sum <= budget);
  });

  it('rewrite recomputes the retained size', () => {
    const r = new FlightRecorder(launch, 20_000, 300_000, 4, 1_000_000);
    for (let i = 0; i < 5; i++) r.add(i, 'http', http(i, 10_000));
    const before = r.retainedBytes;
    r.rewrite({ event: (e) => ({ ...e, data: { ...e.data, responseBody: null } }) });
    assert.ok(r.retainedBytes < before / 10);
  });
});

class Transport implements BugCapsuleTransport {
  capsules: any[] = [];
  async fetchConfig() {
    return { ok: true as const, config: parseRemoteConfig({ enabled: true, sampleRate: 1, captureNetworkBodies: true }, Date.now()) };
  }
  async upload(bytes: Uint8Array): Promise<UploadResult> {
    this.capsules.push(JSON.parse(gunzipSync(bytes).toString('utf8')));
    return { status: 'uploaded', serverId: 's' };
  }
}

describe('capsule eligibility under the byte budget', () => {
  const realFetch = globalThis.fetch;
  afterEach(async () => {
    await BugCapsule.resetForTest();
    BugCapsule.setTestOverrides(undefined);
    globalThis.fetch = realFetch;
  });

  async function capture(maxRecorderBytes: number) {
    globalThis.fetch = (async () => new Response(JSON.stringify({ blob: 'y'.repeat(20_000) }), { headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const t = new Transport();
    BugCapsule.setTestOverrides({ storage: new MemoryStorage(), transport: t, random: () => 0.01, bridge: null });
    await BugCapsule.init({ appVersion: '1', gitSha: 'abc', mode: 'qa', monitoring: false, maxRecorderBytes, integrations: [networkIntegration()] });
    for (let i = 0; i < 5; i++) await (await fetch(`https://api.shop.test/${i}`)).arrayBuffer();
    await new Promise((r) => setTimeout(r, 20));
    const result = await BugCapsule.capture();
    return { result, t };
  }

  it('reports capture.truncated when the budget dropped data', async () => {
    const { result } = await capture(50_000);
    const missing = result!.eligibility.missing.find((m) => m.dependency === 'capture.truncated');
    assert.ok(missing, JSON.stringify(result!.eligibility));
    assert.match(missing.reason, /HTTP bodies/);
    assert.notEqual(missing.blocking, true);
  });

  it('does not when everything fits', async () => {
    const { result } = await capture(8 * 1024 * 1024);
    assert.equal(result!.eligibility.missing.find((m) => m.dependency === 'capture.truncated'), undefined);
  });
});
