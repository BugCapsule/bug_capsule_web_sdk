import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Redactor } from '../../packages/web/src/core/redaction.js';
import { debugIdsByScript, debugImagesFor } from '../../packages/web/src/monitoring/debug-ids.js';
import { exceptionValues, fitItem, normalizeEvent, redactItem, toJsonSafe } from '../../packages/web/src/monitoring/event.js';
import { isSpanId, isTraceId, spanId, traceId } from '../../packages/web/src/monitoring/ids.js';
import { SessionTracker } from '../../packages/web/src/monitoring/session.js';
import { isInApp, parseStack } from '../../packages/web/src/monitoring/stack.js';
import {
  baggageFor,
  compileTargets,
  mergeBaggage,
  parameterizePath,
  parseBaggage,
  parseTraceparent,
  sampleTrace,
  shouldPropagate,
  statusFromHttp,
  Transaction,
  type SpanHost,
} from '../../packages/web/src/monitoring/tracing.js';
import type { EnvelopeItem, EventPayload } from '../../packages/web/src/monitoring/types.js';
import { ClsAccumulator, InpAccumulator } from '../../packages/web/src/monitoring/vitals.js';
import { browserContext, osContext } from '../../packages/web/src/monitoring/context.js';

const CHROME = `TypeError: Cannot read properties of null (reading 'amount')
    at HTMLButtonElement.checkout (https://shop.example.com/assets/index-3f2a.js:10:20)
    at async Promise.all (index 0)
    at https://shop.example.com/assets/index-3f2a.js:12:3
    at new Cart (https://shop.example.com/assets/vendor.js?v=2:1:200)
    at eval (eval at run (https://shop.example.com/assets/index-3f2a.js:5:7), <anonymous>:1:1)
    at Array.map (<anonymous>)
    at onLoad (https://cdn.example.net/node_modules/lib/x.js:3:4)`;

const FIREFOX = `checkout@https://shop.example.com/assets/index-3f2a.js:10:20
async*@https://shop.example.com/assets/index-3f2a.js:12:3
Cart/<@https://shop.example.com/assets/vendor.js:1:200
run@https://shop.example.com/assets/index-3f2a.js line 5 > eval:1:1
@https://shop.example.com/assets/index-3f2a.js:1:1`;

const SAFARI = `checkout@https://shop.example.com/assets/index-3f2a.js:10:20
map@[native code]
global code@https://shop.example.com/assets/index-3f2a.js:12:3`;

describe('stack parsing', () => {
  it('Chromium: frames oldest first with absPath, filename, lineno, colno', () => {
    const frames = parseStack(CHROME);
    assert.deepEqual(frames.at(-1), {
      function: 'HTMLButtonElement.checkout',
      absPath: 'https://shop.example.com/assets/index-3f2a.js',
      filename: '/assets/index-3f2a.js',
      lineno: 10,
      colno: 20,
    });
    assert.deepEqual(frames[0], { function: 'onLoad', absPath: 'https://cdn.example.net/node_modules/lib/x.js', filename: '/node_modules/lib/x.js', lineno: 3, colno: 4 });
    assert.equal(frames.length, 7);
    // `eval at run (url:5:7)`: the calling script's location.
    assert.deepEqual(frames[2], { function: 'eval', absPath: 'https://shop.example.com/assets/index-3f2a.js', filename: '/assets/index-3f2a.js', lineno: 5, colno: 7 });
    assert.equal(frames[1]!.absPath, '<anonymous>');
    assert.equal(frames[3]!.function, 'new Cart');
    assert.equal(frames[4]!.function, undefined);
  });

  it('Firefox and Safari', () => {
    const ff = parseStack(FIREFOX);
    assert.equal(ff.length, 5);
    assert.deepEqual(ff.at(-1), { function: 'checkout', absPath: 'https://shop.example.com/assets/index-3f2a.js', filename: '/assets/index-3f2a.js', lineno: 10, colno: 20 });
    assert.equal(ff.at(-2)!.function, undefined, 'async* prefix and empty names');
    assert.deepEqual(ff[1], { function: 'run', absPath: 'https://shop.example.com/assets/index-3f2a.js', filename: '/assets/index-3f2a.js', lineno: 5 });
    const sf = parseStack(SAFARI);
    assert.deepEqual(sf.map((f) => f.function), [undefined, 'map', 'checkout']);
    assert.equal(sf[1]!.absPath, '[native code]');
  });

  it('message lines are not frames; at most 250 frames, closest to the crash kept', () => {
    assert.deepEqual(parseStack('Error: user foo@bar.com not found\n    at f (https://a.test/x.js:1:1)').length, 1);
    const long = ['Error: deep', ...Array.from({ length: 300 }, (_, i) => `    at f${i} (https://a.test/x.js:${i + 1}:1)`)].join('\n');
    const frames = parseStack(long);
    assert.equal(frames.length, 250);
    assert.equal(frames.at(-1)!.function, 'f0');
    assert.deepEqual(parseStack(null), []);
  });

  it('inApp: same origin, not node_modules; includes win over excludes', () => {
    const origin = 'https://shop.example.com';
    assert.equal(isInApp('https://shop.example.com/assets/index.js', { origin }), true);
    assert.equal(isInApp('https://shop.example.com/node_modules/.vite/deps/react.js', { origin }), false);
    assert.equal(isInApp('https://cdn.example.net/app.js', { origin }), false);
    assert.equal(isInApp('https://cdn.example.net/app.js', { origin, inAppIncludes: ['cdn.example.net'] }), true);
    assert.equal(isInApp('https://shop.example.com/assets/vendor.js', { origin, inAppExcludes: [/vendor/] }), false);
    assert.equal(isInApp('https://shop.example.com/assets/vendor.js', { origin, inAppExcludes: [/vendor/], inAppIncludes: ['vendor'] }), true);
    assert.equal(isInApp('<anonymous>', { origin }), false);
  });

  it('exception chain: innermost cause first, mechanism on the thrown error', () => {
    const inner = new RangeError('bad total');
    const outer = new Error('checkout failed', { cause: inner });
    const values = exceptionValues(outer, { type: 'onerror', handled: false }, { origin: null });
    assert.deepEqual(values.map((v) => v.type), ['RangeError', 'Error']);
    assert.equal(values[1]!.mechanism?.type, 'onerror');
    assert.equal(values[0]!.mechanism, undefined);
    assert.ok(values[1]!.stacktrace!.frames.length > 0);
    const odd = exceptionValues({ code: 7 }, { type: 'unhandledrejection', handled: false }, { origin: null });
    assert.deepEqual(odd[0]!.value, 'Object captured as exception with keys: code');
    const str = exceptionValues('boom', { type: 'manual', handled: true }, { origin: null });
    assert.deepEqual([str[0]!.type, str[0]!.value], ['String', 'boom']);
    const cyclic = new Error('a') as Error & { cause?: unknown };
    cyclic.cause = cyclic;
    assert.equal(exceptionValues(cyclic, { type: 'manual', handled: true }, { origin: null }).length, 1);
  });
});

describe('debug ids', () => {
  it('maps script URLs to the ids the inject snippet registered; images for referenced scripts only', () => {
    const registry = {
      _bugcapsuleDebugIds: {
        'Error\n    at https://shop.example.com/assets/index-3f2a.js:1:99\n': '11111111-2222-4333-8444-555555555555',
        'Error\n    at https://shop.example.com/assets/vendor.js:9:1\n': '66666666-7777-4888-8999-000000000000',
      },
    };
    const ids = debugIdsByScript(registry);
    assert.equal(ids.get('https://shop.example.com/assets/index-3f2a.js'), '11111111-2222-4333-8444-555555555555');
    const images = debugImagesFor(parseStack(CHROME), ids);
    assert.deepEqual(images, [{ type: 'sourcemap', debugId: '11111111-2222-4333-8444-555555555555', codeFile: 'https://shop.example.com/assets/index-3f2a.js' }]);
    assert.deepEqual(debugImagesFor(parseStack(CHROME), new Map()), []);
  });
});

describe('event normalization and redaction', () => {
  const base = (): EventPayload => ({ eventId: '8f0e0000-0000-4000-8000-000000000001', timestamp: '2026-10-21T14:03:10.982Z', level: 'error', runtime: 'web', environment: 'production' });

  it('cuts strings and bounds collections at the documented maxima', () => {
    const e = normalizeEvent({
      ...base(),
      exception: { values: Array.from({ length: 12 }, (_, i) => ({ type: `T${i}`.padEnd(300, 'x'), value: 'v'.repeat(9000) })) },
      fingerprint: Array.from({ length: 12 }, () => 'f'.repeat(300)),
      tags: { ok: 'y'.repeat(300), 'bad key!': 'x', ...Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`t${i}`, i])) },
      extra: { big: 'z'.repeat(70 * 1024), small: 1 },
      environment: 'e'.repeat(100),
    });
    assert.equal(e.exception!.values.length, 10);
    assert.equal(e.exception!.values[0]!.type, 'T2'.padEnd(200, 'x'));
    assert.equal(e.exception!.values[0]!.value!.length, 8192);
    assert.equal(e.fingerprint!.length, 10);
    assert.equal(e.fingerprint![0]!.length, 200);
    assert.equal(Object.keys(e.tags!).length, 50);
    assert.equal(e.tags!.ok!.length, 200);
    assert.equal(e.tags!['bad key!'], undefined);
    assert.deepEqual(e.extra, { big: '[Truncated]', small: 1 });
    assert.equal(e.environment.length, 64);
  });

  it('JSON-safe extras: cycles, functions, bigints, errors', () => {
    const o: Record<string, unknown> = { n: 1n, f: function named() {}, e: new TypeError('x'), d: new Date(0), inf: Infinity };
    o.self = o;
    assert.deepEqual(toJsonSafe(o), { n: '1n', f: '[Function: named]', e: 'TypeError: x', d: '1970-01-01T00:00:00.000Z', inf: 'Infinity', self: '[Circular]' });
  });

  it('redacts every string with the capsule rules but never ids or timestamps', () => {
    const r = new Redactor({ extraKeys: ['customerRef'] });
    const item: EnvelopeItem = {
      type: 'event',
      payload: {
        ...base(),
        // A UUID whose digit groups pass the Luhn check would otherwise look like a card number.
        eventId: '4111-1111-1111-1111',
        exception: { values: [{ type: 'Error', value: 'auth failed for Bearer abcdefghijklmnop token=s3cr3t', stacktrace: { frames: [{ absPath: 'https://u:p@shop.example.com/app.js?sig=abc&v=1', lineno: 1 }] } }] },
        request: { url: 'https://shop.example.com/reset?code=123456&x=1', method: 'GET', headers: { Cookie: 'a=b', 'User-Agent': 'UA' } },
        extra: { customerRef: 'C-1', password: 'hunter2', note: 'card 4242 4242 4242 4242' },
        contexts: { trace: { traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: '00f067aa0ba902b7' } },
        breadcrumbs: [{ timestamp: '2026-10-21T14:03:10.000Z', type: 'http', data: { url: 'https://api.test/x?api_key=zzz', method: 'GET' } }],
        user: { id: 'u_1', email: 'ana@example.com' },
      },
    };
    const out = redactItem(r, item).payload as EventPayload;
    assert.equal(out.eventId, '4111-1111-1111-1111');
    assert.equal(out.exception!.values[0]!.value, 'auth failed for Bearer [REDACTED] token=[REDACTED]');
    assert.equal(out.exception!.values[0]!.stacktrace!.frames[0]!.absPath, 'https://REDACTED@shop.example.com/app.js?sig=[REDACTED]&v=1');
    assert.equal(out.request!.url, 'https://shop.example.com/reset?code=[REDACTED]&x=1');
    assert.deepEqual(out.request!.headers, { cookie: '[REDACTED]', 'user-agent': 'UA' });
    assert.deepEqual(out.extra, { customerRef: '[REDACTED]', password: '[REDACTED]', note: 'card [REDACTED]' });
    assert.deepEqual(out.contexts!.trace, { traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: '00f067aa0ba902b7' });
    assert.equal(out.breadcrumbs![0]!.data!.url, 'https://api.test/x?api_key=[REDACTED]');
    assert.equal(out.user!.email, 'ana@example.com', 'personal data that is not a credential is kept (setUser is explicit)');
  });

  it('items over 1 MiB shed breadcrumbs and extras first', () => {
    const item: EnvelopeItem = { type: 'event', payload: { ...base(), message: { formatted: 'm' }, breadcrumbs: [{ message: 'x'.repeat(600_000) }], extra: { a: 'y'.repeat(600_000) } } };
    const fitted = fitItem(item, 1024 * 1024)!;
    assert.deepEqual((fitted.payload as EventPayload).breadcrumbs, []);
    assert.equal((fitted.payload as EventPayload).extra!.a!.toString().length, 600_000);
    assert.equal(fitItem({ type: 'event', payload: { ...base(), message: { formatted: 'x'.repeat(2_000_000) } } }), null);
  });
});

describe('sessions', () => {
  it('init, first error, crash is final, exited with errors = errored', () => {
    let t = Date.parse('2026-10-21T13:58:00.000Z');
    const s = new SessionTracker({ now: () => t, did: () => 'install-1', release: 'shop@1.0.0', environment: 'production' });
    const init = s.start();
    assert.deepEqual({ ...init, sid: 'x' }, { sid: 'x', did: 'install-1', seq: 0, init: true, started: '2026-10-21T13:58:00.000Z', timestamp: '2026-10-21T13:58:00.000Z', status: 'ok', errors: 0, duration: 0, release: 'shop@1.0.0', environment: 'production', runtime: 'web' });
    t += 1500;
    const first = s.error(false)!;
    assert.deepEqual([first.seq, first.init, first.errors, first.status, first.duration], [1, false, 1, 'ok', 1.5]);
    assert.equal(s.error(false), null, 'later handled errors are only counted');
    t += 1000;
    const end = s.end()!;
    assert.deepEqual([end.seq, end.status, end.errors, end.sid], [2, 'exited', 2, init.sid]);
    s.start();
    const crashed = s.error(true)!;
    assert.equal(crashed.status, 'crashed');
    assert.equal(s.error(true), null);
    assert.equal(s.end(), null, 'a crashed session is final');
  });
});

describe('tracing primitives', () => {
  const host = (): SpanHost & { finished: Transaction[]; t: number } => {
    const h = { t: 1000, finished: [] as Transaction[], now: () => h.t, onTransactionFinish: (tx: Transaction) => h.finished.push(tx) };
    return h;
  };

  it('ids are lowercase hex, never all zero', () => {
    for (let i = 0; i < 20; i++) {
      assert.ok(isTraceId(traceId()));
      assert.ok(isSpanId(spanId()));
    }
    assert.equal(isTraceId('0'.repeat(32)), false);
  });

  it('traceparent and baggage: format, parsing, merging', () => {
    assert.deepEqual(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'), { traceId: '4bf92f3577b34da6a3ce929d0e0e4736', parentSpanId: '00f067aa0ba902b7', sampled: true });
    assert.equal(parseTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01'), null);
    assert.equal(parseTraceparent('garbage'), null);
    const b = baggageFor({ traceId: 'abc', release: 'shop@1.4.0+52', environment: 'production', sampleRate: 0.25, sampled: true });
    assert.equal(b, 'bugcapsule-trace_id=abc,bugcapsule-release=shop%401.4.0%2B52,bugcapsule-environment=production,bugcapsule-sample_rate=0.25,bugcapsule-sampled=true');
    assert.deepEqual(parseBaggage(`other=1,${b};prop`), { 'bugcapsule-trace_id': 'abc', 'bugcapsule-release': 'shop@1.4.0+52', 'bugcapsule-environment': 'production', 'bugcapsule-sample_rate': '0.25', 'bugcapsule-sampled': 'true' });
    assert.equal(mergeBaggage('vendor=x', 'bugcapsule-trace_id=1'), 'vendor=x,bugcapsule-trace_id=1');
    assert.equal(mergeBaggage('bugcapsule-trace_id=0', 'bugcapsule-trace_id=1'), 'bugcapsule-trace_id=0');
    assert.equal(mergeBaggage(null, 'bugcapsule-trace_id=1'), 'bugcapsule-trace_id=1');
  });

  it('propagation targets: same origin by default, substrings and /regex/', () => {
    const origin = 'https://shop.example.com';
    assert.equal(shouldPropagate('/api/cart', null, origin), true);
    assert.equal(shouldPropagate('https://shop.example.com/api', null, origin), true);
    assert.equal(shouldPropagate('https://api.example.com/cart', null, origin), false);
    const targets = compileTargets(['api.example.com', '/^https:\\/\\/pay\\./']);
    assert.equal(shouldPropagate('https://api.example.com/cart', targets, origin), true);
    assert.equal(shouldPropagate('https://pay.example.com/x', targets, origin), true);
    assert.equal(shouldPropagate('https://shop.example.com/x', targets, origin), false);
    assert.equal(shouldPropagate('https://x.test', [], origin), false);
  });

  it('sampling: sampler, then parent decision, then rate', () => {
    assert.deepEqual(sampleTrace({ name: 'a', op: 'x' }, { rate: 0.3, random: () => 0.2 }), { sampled: true, rate: 0.3 });
    assert.deepEqual(sampleTrace({ name: 'a', op: 'x' }, { rate: 0.3, random: () => 0.5 }), { sampled: false, rate: 0.3 });
    assert.deepEqual(sampleTrace({ name: 'a', op: 'x', parentSampled: true }, { rate: 0, random: () => 0.9 }), { sampled: true, rate: 1 });
    assert.deepEqual(sampleTrace({ name: '/checkout', op: 'x', parentSampled: false }, { tracesSampler: (c) => c.name === '/checkout', rate: 0, random: () => 0.9 }), { sampled: true, rate: 1 });
    assert.deepEqual(sampleTrace({ name: 'a', op: 'x' }, { rate: undefined, random: () => 0 }), { sampled: false, rate: 0 });
  });

  it('HTTP status mapping like OpenTelemetry', () => {
    assert.deepEqual([200, 304, 400, 401, 403, 404, 409, 418, 429, 500, 501, 503, 504, 599].map(statusFromHttp), [
      'ok', 'ok', 'invalid_argument', 'unauthenticated', 'permission_denied', 'not_found', 'already_exists', 'invalid_argument', 'resource_exhausted', 'internal_error', 'unimplemented', 'unavailable', 'deadline_exceeded', 'internal_error',
    ]);
  });

  it('transaction names never carry ids', () => {
    assert.equal(parameterizePath('/product/123?ref=x#top'), '/product/:id');
    assert.equal(parameterizePath('/orders/8f0e2c1a-1111-4222-8333-444455556666/items'), '/orders/:id/items');
    assert.equal(parameterizePath('/u/a1b2c3d4e5f6/settings'), '/u/:id/settings');
    assert.equal(parameterizePath('/reset/eyJhbGciOiJIUzI1NiJ9abc123'), '/reset/:id');
    assert.equal(parameterizePath('/checkout'), '/checkout');
    assert.equal(parameterizePath('/'), '/');
  });

  it('spans: children, statuses, idle finishing at the last child end, final timeout', async () => {
    const h = host();
    const tx = new Transaction(traceId(), null, true, 1, { name: '/cart', op: 'navigation', idleTimeoutMs: 20, finalTimeoutMs: 1000 }, h);
    const child = tx.startChild({ op: 'http.client', description: 'GET /api/cart' });
    assert.equal(child.parentSpanId, tx.spanId);
    assert.equal(child.traceId, tx.traceId);
    assert.match(child.toTraceparent(), /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    h.t = 1200;
    child.setHttpStatus(404).finish();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(h.finished.length, 1);
    assert.equal(tx.endTimestamp, 1200, 'ends when the last child did');
    const p = child.toPayload();
    assert.deepEqual([p.status, p.data?.['http.response.status_code'], p.op], ['not_found', 404, 'http.client']);

    const h2 = host();
    const slow = new Transaction(traceId(), null, true, 1, { name: '/x', op: 'navigation', idleTimeoutMs: 1000, finalTimeoutMs: 20 }, h2);
    const open = slow.startChild({ op: 'http.client' });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(slow.status, 'deadline_exceeded');
    assert.equal(open.status, 'cancelled', 'open children are cancelled when the transaction ends');
  });

  it('a held idle transaction waits for the release', async () => {
    const h = host();
    const tx = new Transaction(traceId(), null, true, 1, { name: '/', op: 'pageload', idleTimeoutMs: 10 }, h);
    const release = tx.hold();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(h.finished.length, 0);
    release();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(h.finished.length, 1);
  });
});

describe('web vitals', () => {
  it('CLS is the largest session window of shifts without recent input', () => {
    const cls = new ClsAccumulator();
    cls.add({ value: 0.1, startTime: 100, hadRecentInput: false });
    cls.add({ value: 0.1, startTime: 600, hadRecentInput: false });
    cls.add({ value: 0.5, startTime: 700, hadRecentInput: true });
    cls.add({ value: 0.05, startTime: 3000, hadRecentInput: false }); // > 1 s gap: new window
    assert.ok(Math.abs(cls.value - 0.2) < 1e-9);
    cls.add({ value: 0.3, startTime: 3500, hadRecentInput: false });
    assert.ok(Math.abs(cls.value - 0.35) < 1e-9);
  });

  it('INP is the longest interaction, skipping one per 50 interactions', () => {
    const inp = new InpAccumulator();
    assert.equal(inp.value, null);
    inp.add({ interactionId: 1, duration: 80, startTime: 10 });
    inp.add({ interactionId: 1, duration: 120, startTime: 10 });
    inp.add({ interactionId: 2, duration: 40, startTime: 50 });
    inp.add({ duration: 999, startTime: 60 }); // not an interaction
    assert.equal(inp.value, 120);
    assert.equal(inp.startTime, 10);
    const many = new InpAccumulator();
    for (let i = 1; i <= 100; i++) many.add({ interactionId: i, duration: i, startTime: i });
    assert.equal(many.value, 98);
  });
});

describe('default contexts', () => {
  it('browser and os from the user agent', () => {
    const chrome = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    assert.deepEqual(browserContext(chrome), { name: 'Chrome', version: '131.0.0.0' });
    assert.deepEqual(osContext(chrome), { name: 'macOS', version: '10.15.7' });
    const safari = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
    assert.deepEqual(browserContext(safari), { name: 'Safari', version: '18.1' });
    assert.deepEqual(osContext(safari), { name: 'iOS', version: '18.1' });
    assert.deepEqual(browserContext('x', { brands: [{ brand: 'Not A(Brand', version: '8' }, { brand: 'Chromium', version: '131' }, { brand: 'Google Chrome', version: '131' }] }), { name: 'Google Chrome', version: '131' });
    assert.deepEqual(browserContext('Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0'), { name: 'Firefox', version: '133.0' });
  });
});
