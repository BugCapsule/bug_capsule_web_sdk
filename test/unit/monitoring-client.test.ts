import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { Redactor } from '../../packages/web/src/core/redaction.js';
import { BugCapsule } from '../../packages/web/src/bugcapsule.js';
import { Monitor, type MonitorDeps } from '../../packages/web/src/monitoring/client.js';
import type { Envelope, EventPayload, FeedbackPayload, SessionPayload, TransactionPayload } from '../../packages/web/src/monitoring/types.js';
import { BackendTransport, parseRemoteConfig, type BugCapsuleTransport, type RemoteCaptureConfig } from '../../packages/web/src/remote-config.js';
import { MemoryStorage } from '../../packages/web/src/storage/idb.js';
import { ENVELOPE_STORE, UploadOutbox } from '../../packages/web/src/storage/outbox.js';
import type { BugCapsuleConfig, UploadResult } from '../../packages/web/src/types.js';

class FakeTransport implements BugCapsuleTransport {
  envelopes: Envelope[] = [];
  keepalive: Envelope[] = [];
  results: UploadResult[] = [];
  config: Record<string, unknown> = { enabled: true, sampleRate: 1 };
  uploads: Uint8Array[] = [];
  async fetchConfig() {
    return { ok: true as const, config: parseRemoteConfig(this.config, Date.now()) };
  }
  async upload(bytes: Uint8Array): Promise<UploadResult> {
    this.uploads.push(bytes);
    return { status: 'uploaded' };
  }
  async sendEnvelope(json: string, options: { keepalive?: boolean } = {}): Promise<UploadResult> {
    (options.keepalive ? this.keepalive : this.envelopes).push(JSON.parse(json));
    return this.results.shift() ?? { status: 'uploaded' };
  }
  items<T>(type: string): T[] {
    return this.envelopes.flatMap((e) => e.items.filter((i) => i.type === type).map((i) => i.payload as T));
  }
}

const monitors: Monitor[] = [];
afterEach(() => {
  for (const m of monitors.splice(0)) m.dispose();
});

function setup(config: Partial<BugCapsuleConfig> = {}, options: Omit<Partial<MonitorDeps>, 'remote'> & { remote?: Partial<RemoteCaptureConfig> | null } = {}) {
  const { remote: initialRemote, ...extra } = options;
  const transport = new FakeTransport();
  const storage = new MemoryStorage();
  let remote: RemoteCaptureConfig | null = initialRemote === null ? null : { ...parseRemoteConfig({}, Date.now()), ...(initialRemote ?? {}) };
  const monitor = new Monitor({
    config: { appVersion: '1.4.0', appBuild: '52', consoleBreadcrumbs: false, release: 'shop-web@1.4.0+52', ...config },
    mode: 'production',
    redactor: () => new Redactor(),
    storage,
    transport,
    remote: () => remote,
    uploadsAllowed: () => true,
    ensureFresh: async () => {},
    refreshRemote: () => {},
    random: extra.random ?? (() => 0.5),
    log: () => {},
    sdk: { name: '@bugcapsule/web', version: '0.3.0' },
    lockName: `test:envelopes:${randomUUID()}`, // each MemoryStorage is a separate database
    ...extra,
  } as MonitorDeps);
  monitors.push(monitor);
  return {
    monitor,
    transport,
    storage,
    setRemote: (r: Partial<RemoteCaptureConfig>) => {
      remote = { ...parseRemoteConfig({}, Date.now()), ...r };
      monitor.applyRemote(remote);
    },
  };
}

describe('error events', () => {
  it('captureException: Sentry-like event with release, environment, contexts, trace and the scope', async () => {
    const { monitor, transport } = setup({ environment: 'staging' });
    monitor.scope.setTag('screen', 'checkout').setExtra('cartSize', 3).setContext('order', { id: 'o_1' });
    monitor.setUser({ id: 'u_123', segment: 'pro' });
    monitor.addBreadcrumb({ category: 'ui.click', message: 'button#pay' });
    const id = monitor.captureException(new TypeError('Cart total is negative (-3)'), { tags: { flow: 'pay' } });
    assert.equal(await monitor.flush(1000), true);
    const [event] = transport.items<EventPayload>('event');
    assert.ok(event);
    assert.equal(event.eventId, id);
    assert.equal(monitor.lastEventId(), id);
    assert.deepEqual([event.level, event.runtime, event.release, event.environment], ['error', 'web', 'shop-web@1.4.0+52', 'staging']);
    const ex = event.exception!.values.at(-1)!;
    assert.deepEqual([ex.type, ex.value, ex.mechanism], ['TypeError', 'Cart total is negative (-3)', { type: 'manual', handled: true }]);
    assert.ok(ex.stacktrace!.frames.length > 0 && ex.stacktrace!.frames.every((f) => f.inApp === false), 'no page origin in Node: nothing in-app');
    assert.deepEqual(event.tags, { screen: 'checkout', flow: 'pay' });
    assert.deepEqual(event.extra, { cartSize: 3 });
    assert.deepEqual(event.user, { id: 'u_123', segment: 'pro' });
    assert.deepEqual(event.contexts!.order, { id: 'o_1' });
    assert.deepEqual(event.contexts!.app, { appVersion: '1.4.0', appBuild: '52' });
    assert.match(String(event.contexts!.trace!.traceId), /^[0-9a-f]{32}$/);
    assert.equal(event.breadcrumbs![0]!.message, 'button#pay');
    const env = transport.envelopes[0]!;
    assert.deepEqual(env.sdk, { name: '@bugcapsule/web', version: '0.3.0' });
    assert.match(env.sentAt, /Z$/);
  });

  it('captureMessage, levels from the scope, fingerprints, withScope', async () => {
    const { monitor, transport } = setup({ attachStacktrace: true });
    monitor.captureMessage('checkout slow', 'warning', new Error('x').stack);
    monitor.scope.setLevel('fatal');
    monitor.withScope((s) => {
      s.setFingerprint(['{{ default }}', 'payments']).setTag('inner', 'yes');
      monitor.captureException(new Error('declined'));
    });
    monitor.scope.setLevel(null);
    monitor.captureException(new Error('after'));
    await monitor.flush(1000);
    const [msg, inner, after] = transport.items<EventPayload & { threads?: unknown[] }>('event');
    assert.deepEqual(msg!.message, { formatted: 'checkout slow' });
    assert.equal(msg!.level, 'warning');
    assert.equal(msg!.exception, undefined, 'messages are grouped by message');
    assert.ok(Array.isArray(msg!.threads));
    assert.deepEqual([inner!.level, inner!.fingerprint, inner!.tags], ['fatal', ['{{ default }}', 'payments'], { inner: 'yes' }]);
    assert.deepEqual([after!.level, after!.fingerprint, after!.tags], ['error', undefined, undefined], 'the temporary scope is gone');
  });

  it('beforeSend can change or drop events; beforeBreadcrumb can drop breadcrumbs', async () => {
    const { monitor, transport } = setup({
      beforeSend: (e, hint) => ((hint.originalException as Error).message === 'drop' ? null : { ...e, tags: { ...e.tags, seen: 'yes' } }),
      beforeBreadcrumb: (b) => (b.category === 'noise' ? null : b),
    });
    monitor.addBreadcrumb({ category: 'noise' });
    monitor.addBreadcrumb({ category: 'keep' });
    assert.equal(monitor.captureError(new Error('drop')), null);
    monitor.captureException(new Error('keep'));
    await monitor.flush(1000);
    const events = transport.items<EventPayload>('event');
    assert.equal(events.length, 1);
    assert.equal(events[0]!.tags!.seen, 'yes');
    assert.deepEqual(events[0]!.breadcrumbs!.map((b) => b.category), ['keep']);
  });

  it('errorSampleRate (local × remote minimum); fatal and capsule-linked events are always sent', async () => {
    const { monitor, transport } = setup({ errorSampleRate: 0.8 }, { remote: { errorSampleRate: 0.3 }, random: () => 0.5 });
    assert.equal(monitor.captureError(new Error('sampled out')), null);
    assert.ok(monitor.captureError(new Error('fatal'), { level: 'fatal' }));
    assert.ok(monitor.captureError(new Error('linked'), {}, { capsuleId: 'c0ffee00-0000-4000-8000-000000000000' }));
    await monitor.flush(1000);
    const events = transport.items<EventPayload>('event');
    assert.deepEqual(events.map((e) => e.exception!.values[0]!.value), ['fatal', 'linked']);
    assert.equal(events[1]!.capsuleId, 'c0ffee00-0000-4000-8000-000000000000');
  });

  it('consecutive identical errors are sent once; breadcrumbs are bounded by maxBreadcrumbs (remote can lower it)', async () => {
    const { monitor, transport } = setup({ maxBreadcrumbs: 50 }, { remote: { maxBreadcrumbs: 5 } });
    for (let i = 0; i < 10; i++) monitor.addBreadcrumb({ message: `b${i}` });
    const err = new Error('loop');
    monitor.captureException(err);
    monitor.captureException(err);
    await monitor.flush(1000);
    const events = transport.items<EventPayload>('event');
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]!.breadcrumbs!.map((b) => b.message), ['b5', 'b6', 'b7', 'b8', 'b9']);
  });

  it('items are redacted before they are persisted', async () => {
    const { monitor, storage } = setup({}, { uploadsAllowed: () => false });
    monitor.scope.setExtra('authToken', 'tok-123');
    monitor.captureException(new Error('failed with Bearer abcdefghijkl1234'));
    assert.equal(await monitor.pendingEnvelopes(), 1);
    const [record] = await storage.list('envelopes');
    const text = new TextDecoder().decode(record!.bytes);
    assert.ok(!text.includes('tok-123') && !text.includes('abcdefghijkl1234'), text);
    assert.ok(text.includes('[REDACTED]'));
  });

  it('sendDefaultPii: false (default) never sends an IP; true asks the server to fill it', async () => {
    const off = setup();
    off.monitor.setUser({ id: 'u', ipAddress: '{{auto}}' });
    off.monitor.captureException(new Error('a'));
    await off.monitor.flush(1000);
    assert.deepEqual(off.transport.items<EventPayload>('event')[0]!.user, { id: 'u' });
    const on = setup({ sendDefaultPii: true });
    on.monitor.captureException(new Error('b'));
    await on.monitor.flush(1000);
    assert.deepEqual(on.transport.items<EventPayload>('event')[0]!.user, { ipAddress: '{{auto}}' });
  });

  it('flight-recorder events become breadcrumbs', async () => {
    const { monitor, transport } = setup();
    monitor.onRecord('action', { id: 'cart.checkout' });
    monitor.onRecord('log', { level: 'warn', message: 'low stock' });
    monitor.onRecord('state', { key: 'cart' });
    monitor.onRecord('lifecycle', { state: 'hidden' });
    monitor.onRecord('text', { id: 'login.email', value: 'qa@example.com' });
    monitor.captureException(new Error('x'));
    await monitor.flush(1000);
    const crumbs = transport.items<EventPayload>('event')[0]!.breadcrumbs!;
    assert.deepEqual(
      crumbs.map((b) => [b.type, b.category, b.level, b.message ?? null]),
      [
        ['user', 'ui.action', 'info', 'cart.checkout'],
        ['debug', 'log', 'warning', 'low stock'],
        ['state', 'state', 'info', null],
        ['navigation', 'app.lifecycle', 'info', null],
      ],
    );
  });
});

describe('sessions', () => {
  it('init on start, an update on the first error, crashed on an unhandled error, exited on end', async () => {
    const { monitor, transport } = setup();
    await monitor.start();
    monitor.captureException(new Error('handled'));
    monitor.captureException(new Error('handled again'));
    monitor.captureException(new Error('boom'), { mechanism: { type: 'onerror', handled: false } });
    monitor.captureException(new Error('after the crash'));
    monitor.endSession();
    await monitor.flush(1000);
    const sessions = transport.items<SessionPayload>('session');
    assert.deepEqual(
      sessions.map((s) => [s.seq, s.init, s.status, s.errors]),
      [
        [0, true, 'ok', 0],
        [1, false, 'ok', 1],
        [2, false, 'crashed', 3],
      ],
    );
    assert.ok(sessions.every((s) => s.sid === sessions[0]!.sid && s.release === 'shop-web@1.4.0+52' && s.environment === 'production'));
    // The event and its session update travel in one envelope.
    assert.ok(transport.envelopes.some((e) => e.items.map((i) => i.type).join() === 'event,session'));
  });

  it('crashOnUnhandled: false keeps the session errored; sessionTracking off sends none; did is a persisted install id', async () => {
    const { monitor, transport, storage } = setup({ crashOnUnhandled: false });
    await monitor.start();
    monitor.captureException(new Error('boom'), { mechanism: { type: 'onerror', handled: false } });
    monitor.endSession();
    await monitor.flush(1000);
    const sessions = transport.items<SessionPayload>('session');
    assert.deepEqual(sessions.map((s) => s.status), ['ok', 'ok', 'exited']);
    assert.equal(sessions.at(-1)!.errors, 1);
    assert.equal(sessions[0]!.did, await storage.getKv('monitoring.installId'));

    const off = setup({}, { remote: { sessionTracking: false } });
    await off.monitor.start();
    await off.monitor.flush(1000);
    assert.equal(off.transport.items('session').length, 0);
  });
});

describe('page lifecycle', () => {
  it('pagehide ends the session with a keepalive send and a queued copy; pageshow from the bfcache starts a new one', async () => {
    const target = new EventTarget();
    const g = globalThis as unknown as Record<string, unknown>;
    g.addEventListener = target.addEventListener.bind(target);
    g.removeEventListener = target.removeEventListener.bind(target);
    try {
      const { monitor, transport } = setup();
      await monitor.start();
      target.dispatchEvent(new Event('pagehide'));
      assert.deepEqual(transport.keepalive.flatMap((e) => e.items.map((i) => [i.type, (i.payload as SessionPayload).status])), [['session', 'exited']]);
      const shown = Object.assign(new Event('pageshow'), { persisted: true });
      target.dispatchEvent(shown);
      await monitor.flush(1000);
      const sessions = transport.items<SessionPayload>('session');
      assert.deepEqual(sessions.map((s) => [s.init, s.status]), [
        [true, 'ok'],
        [false, 'exited'],
        [true, 'ok'],
      ]);
      assert.notEqual(sessions[2]!.sid, sessions[0]!.sid);
      monitor.dispose();
    } finally {
      delete g.addEventListener;
      delete g.removeEventListener;
    }
  });
});

describe('envelope outbox and remote config', () => {
  it('waits for a fresh config; monitoringEnabled: false purges and stops; true resumes', async () => {
    let allowed = false;
    const { monitor, transport, setRemote } = setup({}, { uploadsAllowed: () => allowed });
    monitor.captureException(new Error('queued'));
    await monitor.flush(500);
    assert.equal(transport.envelopes.length, 0);
    assert.equal(await monitor.pendingEnvelopes(), 1);
    setRemote({ monitoringEnabled: false });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(await monitor.pendingEnvelopes(), 0);
    assert.equal(monitor.captureError(new Error('off')), null);
    setRemote({ monitoringEnabled: true });
    allowed = true;
    monitor.captureException(new Error('on again'));
    await monitor.flush(1000);
    assert.deepEqual(transport.items<EventPayload>('event').map((e) => e.exception!.values[0]!.value), ['on again']);
  });

  it('the kill switch (enabled: false) stops monitoring for the page session', async () => {
    const { monitor, setRemote } = setup();
    setRemote({ enabled: false });
    assert.equal(monitor.active, false);
    setRemote({ enabled: true });
    assert.equal(monitor.active, false);
  });

  it('retryable failures back off; rejected envelopes are dropped, never retried', async () => {
    const { monitor, transport } = setup();
    transport.results = [{ status: 'retryLater', retryAfterMs: 60_000 }];
    monitor.captureException(new Error('a'));
    assert.equal(await monitor.flush(1000), false);
    assert.equal(await monitor.pendingEnvelopes(), 1);
    assert.ok((await monitor.outbox.retryAt())! > Date.now() + 50_000, 'Retry-After honoured');

    const second = setup();
    second.transport.results = [{ status: 'rejected', message: 'HTTP 400' }];
    second.monitor.captureException(new Error('b'));
    await second.monitor.flush(1000);
    assert.equal(await second.monitor.pendingEnvelopes(), 0);
  });

  it('own store and defaults: 30 envelopes / 5 MiB, separate from the capsule outbox', async () => {
    const storage = new MemoryStorage();
    let t = 0;
    const outbox = new UploadOutbox(storage, {}, 'l', () => t++, Math.random, ENVELOPE_STORE);
    assert.deepEqual(outbox.limits, { maxCount: 30, maxBytes: 5 * 1024 * 1024, maxAgeMs: 7 * 86_400_000 });
    for (let i = 0; i < 32; i++) await outbox.enqueue(`e${i}`, new TextEncoder().encode('{"items":[]}'));
    assert.equal((await outbox.entries()).length, 30);
    assert.equal((await outbox.entries())[0]!.capsuleId, 'e2');
    assert.equal((await storage.list('outbox')).length, 0);
    // A record that is not envelope JSON is deleted unsent.
    await storage.update('envelopes', () => ({ put: [{ id: '0', capsuleId: 'bad', enqueuedAt: 0, size: 2, bytes: new Uint8Array([0x1f, 0x8b]) }], result: undefined }));
    const sent: string[] = [];
    await outbox.flush({ upload: async (b) => (sent.push(new TextDecoder().decode(b)), { status: 'uploaded' }), allowed: () => true });
    assert.equal(sent.length, 30);
    assert.equal((await outbox.entries()).length, 0);
  });

  it('BackendTransport: POST /v1/envelope, gzip over 1 KiB, keepalive uncompressed, status mapping', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const statuses = [200, 200, 429, 400, 403, 503];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const status = statuses.shift()!;
      return new Response(status === 403 ? JSON.stringify({ code: 'capture_disabled' }) : JSON.stringify({ accepted: 1, rejected: [] }), {
        status,
        headers: status === 429 ? { 'retry-after': '120' } : {},
      });
    }) as unknown as typeof fetch;
    const t = new BackendTransport({ url: 'https://bc.example.com/', ingestKey: 'bci_k' }, fakeFetch);
    const small = JSON.stringify({ items: [] });
    const big = JSON.stringify({ items: [], pad: 'x'.repeat(5000) });
    assert.deepEqual(await t.sendEnvelope(small), { status: 'uploaded' });
    assert.equal(calls[0]!.url, 'https://bc.example.com/v1/envelope');
    const h0 = calls[0]!.init.headers as Record<string, string>;
    assert.deepEqual([h0.Authorization, h0['Content-Type'], h0['Content-Encoding']], ['Bearer bci_k', 'application/json', undefined]);
    assert.deepEqual(await t.sendEnvelope(big), { status: 'uploaded' });
    const h1 = calls[1]!.init.headers as Record<string, string>;
    assert.equal(h1['Content-Encoding'], 'gzip');
    assert.equal(gunzipSync(calls[1]!.init.body as Uint8Array).toString(), big);
    assert.deepEqual(await t.sendEnvelope(big, { keepalive: true }), { status: 'retryLater', message: 'HTTP 429', retryAfterMs: 120_000 });
    assert.equal(calls[2]!.init.keepalive, true);
    assert.equal((calls[2]!.init.headers as Record<string, string>)['Content-Encoding'], undefined);
    assert.deepEqual(await t.sendEnvelope(small), { status: 'rejected', message: 'HTTP 400' });
    assert.deepEqual(await t.sendEnvelope(small), { status: 'rejected', message: 'capture_disabled' });
    assert.equal((await t.sendEnvelope(small)).status, 'retryLater');
  });
});

describe('tracing', () => {
  it('transactions with child spans are sent when sampled; never when not', async () => {
    const { monitor, transport } = setup({ tracesSampleRate: 1 });
    const tx = monitor.startTransaction({ name: '/checkout', op: 'navigation' });
    assert.equal(monitor.activeSpan(), tx);
    const span = tx.startChild({ op: 'db', description: 'load cart' });
    span.setData('rows', 3).finish();
    monitor.captureException(new Error('inside'));
    tx.finish();
    assert.equal(monitor.activeSpan(), null);
    const unsampled = setup({ tracesSampleRate: 0 });
    unsampled.monitor.startTransaction({ name: '/x', op: 'navigation' }).finish();
    await Promise.all([monitor.flush(1000), unsampled.monitor.flush(1000)]);
    assert.equal(unsampled.transport.items('transaction').length, 0);
    const [t] = transport.items<TransactionPayload>('transaction');
    assert.deepEqual([t!.name, t!.op, t!.status, t!.release, t!.runtime], ['/checkout', 'navigation', 'ok', 'shop-web@1.4.0+52', 'web']);
    assert.match(t!.traceId, /^[0-9a-f]{32}$/);
    assert.deepEqual(t!.spans.map((s) => [s.op, s.description, s.parentSpanId, s.data]), [['db', 'load cart', t!.spanId, { rows: 3 }]]);
    const [event] = transport.items<EventPayload>('event');
    assert.deepEqual(event!.contexts!.trace, { traceId: t!.traceId, spanId: t!.spanId }, 'errors link to the active span');
  });

  it('the backend tracesSampleRate overrides the app rate unless tracesSampler is set', async () => {
    const remoteWins = setup({ tracesSampleRate: 1 }, { remote: { tracesSampleRate: 0 } });
    remoteWins.monitor.startTransaction({ name: '/a', op: 'navigation' }).finish();
    const sampler = setup({ tracesSampleRate: 0, tracesSampler: (c) => c.name === '/b' }, { remote: { tracesSampleRate: 0 } });
    sampler.monitor.startTransaction({ name: '/b', op: 'navigation' }).finish();
    sampler.monitor.startTransaction({ name: '/c', op: 'navigation' }).finish();
    await Promise.all([remoteWins.monitor.flush(1000), sampler.monitor.flush(1000)]);
    assert.equal(remoteWins.transport.items('transaction').length, 0);
    assert.deepEqual(sampler.transport.items<TransactionPayload>('transaction').map((t) => t.name), ['/b']);
  });

  it('startSpan: active while the callback runs, finished after its promise; errors set internal_error', async () => {
    const { monitor, transport } = setup({ tracesSampleRate: 1 });
    const result = await monitor.startSpan({ name: 'checkout', op: 'task' }, async (root) => {
      assert.equal(monitor.activeSpan(), root);
      monitor.startSpan({ op: 'serialize', description: 'cart' }, (child) => {
        assert.equal(child.parentSpanId, root.spanId);
      });
      await assert.rejects(
        monitor.startSpan({ op: 'http.client', description: 'pay' }, async () => {
          throw new Error('declined');
        }),
      );
      return 42;
    });
    assert.equal(result, 42);
    await new Promise((r) => setTimeout(r, 10));
    await monitor.flush(1000);
    const [t] = transport.items<TransactionPayload>('transaction');
    assert.equal(t!.name, 'checkout');
    assert.deepEqual(t!.spans.map((s) => [s.op, s.status]), [['serialize', 'ok'], ['http.client', 'internal_error']]);
  });

  it('HTTP observation: span, breadcrumb, traceparent/baggage for targets only', async () => {
    const { monitor, transport } = setup({ tracesSampleRate: 1, tracePropagationTargets: ['api.shop.test'] });
    const tx = monitor.startTransaction({ name: '/cart', op: 'navigation' });
    const obs = monitor.httpStart({ kind: 'fetch', method: 'GET', url: 'https://api.shop.test/cart?token=abc' })!;
    assert.match(obs.headers!.traceparent!, new RegExp(`^00-${tx.traceId}-[0-9a-f]{16}-01$`));
    assert.equal(obs.headers!.baggage, `bugcapsule-trace_id=${tx.traceId},bugcapsule-release=shop-web%401.4.0%2B52,bugcapsule-environment=production,bugcapsule-sample_rate=1,bugcapsule-sampled=true`);
    obs.finish({ status: 503 });
    const other = monitor.httpStart({ kind: 'xhr', method: 'POST', url: 'https://cdn.other.test/x' })!;
    assert.equal(other.headers, null);
    other.finish({ error: Object.assign(new Error('aborted'), { name: 'AbortError' }) });
    tx.finish();
    monitor.captureException(new Error('x'));
    await monitor.flush(1000);
    const [t] = transport.items<TransactionPayload>('transaction');
    assert.deepEqual(t!.spans.map((s) => [s.op, s.description, s.status, s.data?.['http.response.status_code'] ?? null]), [
      ['http.client', 'GET https://api.shop.test/cart', 'unavailable', 503],
      ['http.client', 'POST https://cdn.other.test/x', 'cancelled', null],
    ]);
    assert.equal(t!.spans[0]!.data!.url, 'https://api.shop.test/cart?token=[REDACTED]');
    assert.equal(obs.headers!.traceparent!.split('-')[2], t!.spans[0]!.spanId, 'traceparent carries the http.client span id');
    const crumbs = transport.items<EventPayload>('event')[0]!.breadcrumbs!.filter((b) => b.type === 'http');
    assert.deepEqual(crumbs.map((b) => [b.category, b.level, b.data!.status_code ?? null]), [
      ['fetch', 'error', 503],
      ['xhr', 'error', null],
    ]);
  });

  it('continueTrace: the next root transaction joins the incoming trace and its decision', async () => {
    const { monitor, transport } = setup({ tracesSampleRate: 0 });
    monitor.continueTrace('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01', 'bugcapsule-trace_id=4bf92f3577b34da6a3ce929d0e0e4736,bugcapsule-sampled=true,other=1');
    assert.equal(monitor.getTraceparent().split('-')[1], '4bf92f3577b34da6a3ce929d0e0e4736');
    const tx = monitor.startTransaction({ name: '/', op: 'pageload' });
    assert.equal(tx.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
    assert.equal(tx.parentSpanId, '00f067aa0ba902b7');
    assert.equal(monitor.getBaggage(), 'bugcapsule-trace_id=4bf92f3577b34da6a3ce929d0e0e4736,bugcapsule-sampled=true', 'incoming baggage is forwarded');
    tx.finish();
    const next = monitor.startTransaction({ name: '/b', op: 'navigation' });
    assert.notEqual(next.traceId, '4bf92f3577b34da6a3ce929d0e0e4736', 'later roots start new traces');
    next.finish();
    await monitor.flush(1000);
    assert.deepEqual(transport.items<TransactionPayload>('transaction').map((t) => t.name), ['/']);
    assert.equal(monitor.captureMessage('m') !== '', true);
  });

  it('navigation: breadcrumbs with from/to; a new navigation transaction per path, renamed by route patterns', async () => {
    const { monitor, transport } = setup({ tracesSampleRate: 1 });
    await monitor.start();
    monitor.navigation('/product/123?ref=mail', 'history', 'push');
    monitor.navigation('/product/123?ref=mail', 'react_router', 'push', '/product/:productId');
    monitor.navigation('/product/123?ref=mail#reviews', 'history', 'replace');
    monitor.navigation('/cart', 'history', 'push');
    monitor.navigation('/done', 'history', 'push');
    monitor.captureException(new Error('x'));
    await monitor.flush(1000);
    const txs = transport.items<TransactionPayload>('transaction');
    // Same-millisecond outbox entries are ordered by their random IDs.
    assert.deepEqual(txs.map((t) => [t.op, t.name, t.status]).sort(), [
      ['pageload', '/', 'cancelled'],
      ['navigation', '/product/:productId', 'cancelled'],
      ['navigation', '/cart', 'cancelled'],
    ].sort());
    assert.equal(new Set(txs.map((t) => t.traceId)).size, 3, 'one trace per navigation');
    const nav = transport.items<EventPayload>('event')[0]!.breadcrumbs!.filter((b) => b.category === 'navigation');
    assert.deepEqual(nav.map((b) => [b.data!.from, b.data!.to]), [
      [null, '/product/123?ref=mail'],
      ['/product/123?ref=mail', '/product/123?ref=mail#reviews'],
      ['/product/123?ref=mail#reviews', '/cart'],
      ['/cart', '/done'],
    ]);
  });
});

describe('feedback', () => {
  it('captureFeedback: feedback item linked to an event, with user and trace', async () => {
    const { monitor, transport } = setup();
    monitor.setUser({ id: 'u_123' });
    const eventId = monitor.captureException(new Error('x'));
    const id = monitor.captureFeedback({ message: '  Checkout button did nothing ', name: 'Ana', email: 'ana@example.com', eventId, url: 'https://shop.test/checkout?token=t' });
    await monitor.flush(1000);
    const [f] = transport.items<FeedbackPayload>('feedback');
    assert.deepEqual(
      { ...f, timestamp: 'T', contexts: Object.keys(f!.contexts!) },
      {
        feedbackId: id,
        timestamp: 'T',
        message: 'Checkout button did nothing',
        name: 'Ana',
        email: 'ana@example.com',
        eventId,
        url: 'https://shop.test/checkout?token=[REDACTED]',
        release: 'shop-web@1.4.0+52',
        environment: 'production',
        runtime: 'web',
        user: { id: 'u_123' },
        contexts: ['trace'],
        capsuleId: null,
      },
    );
  });

  it('captureCapsule writes a capsule and links it; an empty message is refused', async () => {
    const written: [string, string, unknown][] = [];
    const { monitor, transport } = setup({}, { writeCapsule: (id, note, link) => (written.push([id, note, link]), true) });
    monitor.captureFeedback({ message: 'it broke', captureCapsule: true });
    assert.equal(monitor.captureFeedback({ message: '   ' }), '');
    await monitor.flush(1000);
    const items = transport.items<FeedbackPayload>('feedback');
    assert.equal(items.length, 1);
    assert.equal(items[0]!.capsuleId, written[0]![0]);
    assert.equal(written[0]![1], 'user feedback');
  });
});

describe('BugCapsule facade without init', () => {
  it('monitoring calls are safe no-ops', async () => {
    assert.equal(BugCapsule.captureException(new Error('x')), '');
    assert.equal(BugCapsule.lastEventId(), null);
    BugCapsule.setUser({ id: 'u' });
    BugCapsule.setTag('a', 'b');
    assert.equal(BugCapsule.withScope(() => 7), 7);
    assert.equal(BugCapsule.startSpan({ op: 'task', name: 't' }, (s) => s.sampled), false);
    assert.equal(BugCapsule.startTransaction({ name: 'x', op: 'task' }).sampled, false);
    assert.equal(await BugCapsule.flush(10), true);
  });
});
