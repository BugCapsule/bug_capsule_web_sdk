import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { BugCapsule } from '../../packages/web/src/bugcapsule.js';
import { networkIntegration } from '../../packages/web/src/integrations/network.js';
import type { Envelope, EventPayload } from '../../packages/web/src/monitoring/types.js';
import { parseRemoteConfig, type BugCapsuleTransport } from '../../packages/web/src/remote-config.js';
import { MemoryStorage } from '../../packages/web/src/storage/idb.js';
import type { BugCapsuleConfig, UploadResult } from '../../packages/web/src/types.js';

class Transport implements BugCapsuleTransport {
  envelopes: Envelope[] = [];
  capsules: Record<string, any>[] = [];
  config: Record<string, unknown> = { enabled: true, sampleRate: 1 };
  async fetchConfig() {
    return { ok: true as const, config: parseRemoteConfig(this.config, Date.now()) };
  }
  async upload(bytes: Uint8Array): Promise<UploadResult> {
    this.capsules.push(JSON.parse(gunzipSync(bytes).toString('utf8')));
    return { status: 'uploaded', serverId: 's' };
  }
  async sendEnvelope(json: string): Promise<UploadResult> {
    this.envelopes.push(JSON.parse(json));
    return { status: 'uploaded' };
  }
  events(): EventPayload[] {
    return this.envelopes.flatMap((e) => e.items.filter((i) => i.type === 'event').map((i) => i.payload as EventPayload));
  }
}

const realFetch = globalThis.fetch;
afterEach(async () => {
  await BugCapsule.resetForTest();
  BugCapsule.setTestOverrides(undefined);
  globalThis.fetch = realFetch;
});

async function init(transport: Transport, config: Partial<BugCapsuleConfig> = {}) {
  BugCapsule.setTestOverrides({ storage: new MemoryStorage(), transport, random: () => 0.01, bridge: null });
  await BugCapsule.init({ appVersion: '1.0.0', appBuild: '7', mode: 'qa', gitSha: 'abc', consoleBreadcrumbs: false, release: 'shop@1.0.0+7', ...config });
}

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('runtime: capsules and events', () => {
  it('a captured failure sends the event with capsuleId and writes manifest.monitoring', async () => {
    const t = new Transport();
    await init(t);
    BugCapsule.reportError(new TypeError('price is null'));
    await until(() => t.capsules.length === 1);
    await BugCapsule.flush(2000);
    const [event] = t.events();
    const m = t.capsules[0]!.manifest;
    assert.ok(event);
    assert.equal(event.capsuleId, m.capsuleId);
    assert.deepEqual(m.monitoring, { eventId: event.eventId, traceId: event.contexts!.trace!.traceId, release: 'shop@1.0.0+7', environment: 'qa' });
    assert.deepEqual(event.exception!.values.at(-1)!.mechanism, { type: 'manual', handled: true });
    assert.equal(m.failure.signature, 'exception:TypeError:price is null', 'the capsule failure is unchanged');
  });

  it('an assertion failure is an event grouped by assertion id, linked to its capsule', async () => {
    const t = new Transport();
    await init(t);
    BugCapsule.check('cart_total_non_negative', false, 'total was -3');
    await until(() => t.capsules.length === 1);
    await BugCapsule.flush(2000);
    const [event] = t.events();
    assert.deepEqual(event!.exception!.values, [{ type: 'cart_total_non_negative', value: 'total was -3', mechanism: { type: 'assertion', handled: true } }]);
    assert.equal(event!.capsuleId, t.capsules[0]!.manifest.capsuleId);
    assert.equal(t.capsules[0]!.manifest.monitoring.eventId, event!.eventId);
  });

  it('a repeated failure sends another event but no second capsule; ignoreError skips both', async () => {
    const t = new Transport();
    await init(t, { ignoreError: (e) => (e as Error).message === 'ignored' });
    BugCapsule.reportError(new Error('again'));
    BugCapsule.reportError(new Error('ignored'));
    await until(() => t.capsules.length === 1);
    BugCapsule.reportError(new Error('again'));
    await BugCapsule.flush(2000);
    const events = t.events();
    assert.deepEqual(events.map((e) => [e.exception!.values.at(-1)!.value, Boolean(e.capsuleId)]), [
      ['again', true],
      ['again', false],
    ]);
    assert.equal(t.capsules.length, 1);
  });

  it('monitoring: false sends nothing; capsules still work', async () => {
    const t = new Transport();
    await init(t, { monitoring: false });
    BugCapsule.reportError(new Error('x'));
    assert.equal(BugCapsule.captureException(new Error('y')), '');
    await until(() => t.capsules.length === 1);
    await BugCapsule.flush(500);
    assert.equal(t.envelopes.length, 0);
    assert.equal(t.capsules[0]!.manifest.monitoring, undefined);
  });

  it('remote monitoringEnabled: false stops envelopes but not capsules', async () => {
    const t = new Transport();
    t.config = { enabled: true, sampleRate: 1, monitoringEnabled: false };
    await init(t);
    await BugCapsule.refreshRemoteConfig();
    BugCapsule.reportError(new Error('x'));
    await until(() => t.capsules.length === 1);
    await BugCapsule.flush(500);
    assert.equal(t.events().length, 0);
  });

  it('fetch spans and trace headers never change the recorded request or its key', async () => {
    const seen: Headers[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const t = new Transport();
    await init(t, { integrations: [networkIntegration()], tracesSampleRate: 1, tracePropagationTargets: ['api.shop.test'] });
    await (await fetch('https://api.shop.test/cart', { headers: { 'x-app': '1', baggage: 'vendor=a' } })).json();
    await fetch('https://cdn.other.test/logo.png');
    BugCapsule.reportError(new Error('after fetch'));
    await until(() => t.capsules.length === 1);
    await BugCapsule.flush(2000);
    assert.match(seen[0]!.get('traceparent') ?? '', /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    assert.match(seen[0]!.get('baggage') ?? '', /^vendor=a,bugcapsule-trace_id=[0-9a-f]{32},bugcapsule-release=/);
    assert.equal(seen[0]!.get('x-app'), '1');
    assert.equal(seen[1]!.get('traceparent'), null, 'not a propagation target');
    const http = t.capsules[0]!.events.filter((e: { type: string }) => e.type === 'http');
    assert.equal(http.length, 2);
    assert.equal(http[0].data.requestHeaders.traceparent, undefined, 'the capsule records the request as the app made it');
    assert.equal(http[0].data.key, 'GET api.shop.test/cart');
    const crumbs = t.events()[0]!.breadcrumbs!.filter((b) => b.type === 'http');
    assert.deepEqual(crumbs.map((b) => [b.category, b.data!.url, b.data!.status_code]), [
      ['fetch', 'https://api.shop.test/cart', 200],
      ['fetch', 'https://cdn.other.test/logo.png', 200],
    ]);
  });

  it('without a configured network integration, monitoring observes fetch on its own (never recorded)', async () => {
    const seen: Headers[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return new Response('{}');
    }) as typeof fetch;
    const t = new Transport();
    await init(t, { tracePropagationTargets: ['/api/'] });
    await fetch('https://shop.test/api/x');
    BugCapsule.reportError(new Error('x'));
    await until(() => t.capsules.length === 1);
    await BugCapsule.flush(2000);
    assert.match(seen[0]!.get('traceparent') ?? '', /-00$/, 'propagated unsampled when tracing is off');
    assert.equal(t.capsules[0]!.events.filter((e: { type: string }) => e.type === 'http').length, 0);
    assert.ok(!t.capsules[0]!.manifest.integrations.includes('monitoring.network'));
    assert.equal(t.events()[0]!.breadcrumbs!.filter((b) => b.type === 'http').length, 1);
  });

  it('captureFeedback in qa mode writes a capsule and links it', async () => {
    const t = new Transport();
    await init(t);
    const id = BugCapsule.captureFeedback({ message: 'Checkout did nothing' });
    await until(() => t.capsules.length === 1);
    await BugCapsule.flush(2000);
    const feedback = t.envelopes.flatMap((e) => e.items).find((i) => i.type === 'feedback')!.payload as { feedbackId: string; capsuleId: string };
    assert.equal(feedback.feedbackId, id);
    assert.equal(feedback.capsuleId, t.capsules[0]!.manifest.capsuleId);
    assert.equal(t.capsules[0]!.manifest.labels.note, 'user feedback');
  });

  it('close() ends the session and flushes', async () => {
    const t = new Transport();
    await init(t);
    assert.equal(await BugCapsule.close(2000), true);
    const sessions = t.envelopes.flatMap((e) => e.items).filter((i) => i.type === 'session').map((i) => i.payload as { status: string; init: boolean });
    assert.deepEqual(sessions.map((s) => [s.init, s.status]), [
      [true, 'ok'],
      [false, 'exited'],
    ]);
    assert.equal(BugCapsule.isInitialized, false);
  });
});
