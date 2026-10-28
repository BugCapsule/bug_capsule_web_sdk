import { expect, test, type Page } from '@playwright/test';
import { snippet } from '../../packages/cli/src/sourcemaps.js';
import { API, BACKEND, ORIGIN, decodeUpload, envelopeItems, newBackend, setUpRoutes, type BackendState } from './harness.js';

declare global {
  interface Window {
    BC: typeof import('../../packages/web/src/index.js');
  }
}

const INGEST = 'bci_test_key_0123456789abcdefghij';
const DEBUG_ID = '3f2a9c1e-5b7d-4e10-8a42-9d6c1b2e7f00';

/** An app script served from the page origin, with a debug id like `sourcemaps inject` writes. */
const APP_JS = `
function checkout() {
  const cart = { items: [{ price: null }] };
  return cart.items[0].price.amount;
}
document.getElementById('go').addEventListener('click', () => checkout());
window.__fetchCart = () => fetch('/api/cart').then((r) => r.json());
window.__fetchApi = () => fetch('${API}/cart').then((r) => r.json());
${snippet(DEBUG_ID)}
//# debugId=${DEBUG_ID}
`;

let backend: BackendState;
let sameOriginHeaders: Record<string, string>[];
let apiHeaders: Record<string, string>[];

test.beforeEach(async ({ page }) => {
  backend = newBackend();
  sameOriginHeaders = [];
  apiHeaders = [];
  await setUpRoutes(page, backend, async (route) => {
    const h = { 'access-control-allow-origin': ORIGIN, 'access-control-allow-headers': 'content-type, traceparent, baggage', 'content-type': 'application/json' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    apiHeaders.push(await route.request().allHeaders());
    return route.fulfill({ headers: h, body: '{"items":[]}' });
  });
  await page.route(`${ORIGIN}/app.js`, (route) => route.fulfill({ contentType: 'text/javascript', body: APP_JS }));
  await page.route(`${ORIGIN}/api/**`, async (route) => {
    sameOriginHeaders.push(await route.request().allHeaders());
    return route.fulfill({ contentType: 'application/json', body: '{"items":[1]}' });
  });
});

async function init(page: Page, extra: Record<string, unknown> = {}) {
  await page.evaluate(
    async ({ BACKEND, INGEST, extra }) => {
      const { BugCapsule, networkIntegration, historyIntegration } = window.BC;
      await BugCapsule.init({
        appVersion: '1.4.0',
        appBuild: '52',
        mode: 'qa',
        gitSha: 'abc123',
        release: 'shop-web@1.4.0+52',
        backend: { url: BACKEND, ingestKey: INGEST },
        integrations: [networkIntegration(), historyIntegration()],
        ...extra,
      });
    },
    { BACKEND, INGEST, extra },
  );
}

async function loadApp(page: Page, extra: Record<string, unknown> = {}) {
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
      if (init?.keepalive) sessionStorage.setItem('keepalive', new TextDecoder().decode(init.body as Uint8Array));
      return original.call(this, input, init);
    } as typeof fetch;
  });
  await page.goto(`${ORIGIN}/shop`);
  await init(page, extra);
  await page.addScriptTag({ url: '/app.js' });
}

test('an unhandled error becomes an event linked to its capsule, with frames, debug images and a crashed session', async ({ page }) => {
  await loadApp(page);
  await page.evaluate(() => window.BC.BugCapsule.setUser({ id: 'u_123' }));
  await page.click('#go');
  await expect.poll(() => backend.uploads.length, { timeout: 10_000 }).toBe(1);
  await page.evaluate(() => window.BC.BugCapsule.flush(5000));
  await expect.poll(() => envelopeItems(backend, 'event').length).toBe(1);

  const event = envelopeItems(backend, 'event')[0]!;
  const ex = event.exception.values.at(-1);
  expect(ex.type).toBe('TypeError');
  expect(ex.mechanism).toEqual({ type: 'onerror', handled: false });
  const crash = ex.stacktrace.frames.at(-1);
  expect(crash).toMatchObject({ function: 'checkout', absPath: `${ORIGIN}/app.js`, filename: '/app.js', inApp: true });
  expect(crash.lineno).toBeGreaterThan(0);
  expect(crash.colno).toBeGreaterThan(0);
  expect(event.debugImages).toEqual([{ type: 'sourcemap', debugId: DEBUG_ID, codeFile: `${ORIGIN}/app.js` }]);
  expect(event).toMatchObject({ runtime: 'web', release: 'shop-web@1.4.0+52', environment: 'qa', user: { id: 'u_123' }, request: { url: `${ORIGIN}/shop`, method: 'GET' } });
  expect(event.contexts.browser.name).toBeTruthy();
  expect(event.breadcrumbs.map((b: any) => b.category)).toContain('ui.click');

  // The capsule and the event point at each other.
  const capsule = decodeUpload(backend.uploads[0]!);
  expect(event.capsuleId).toBe(capsule.manifest.capsuleId);
  expect(capsule.manifest.monitoring).toEqual({ eventId: event.eventId, traceId: event.contexts.trace.traceId, release: 'shop-web@1.4.0+52', environment: 'qa' });

  const sessions = envelopeItems(backend, 'session');
  expect(sessions.map((s) => [s.init, s.status, s.errors])).toEqual([
    [true, 'ok', 0],
    [false, 'crashed', 1],
  ]);
  expect(sessions[1]!.did).toBe('u_123');
  const withEvent = backend.envelopes.find((e) => e.body.items.some((i: any) => i.type === 'event'))!;
  expect(withEvent.headers['content-encoding']).toBe('gzip');
  expect(withEvent.headers.authorization).toBe(`Bearer ${INGEST}`);
  expect(withEvent.body.sdk).toEqual({ name: '@bugcapsule/web', version: '0.4.0-beta.4' });
});

test('pageload and navigation transactions with http, resource spans, web vitals; traceparent only to same-origin targets', async ({ page }) => {
  await loadApp(page, { tracesSampleRate: 1 });
  await page.evaluate(() => (window as any).__fetchCart());
  await page.evaluate(() => (window as any).__fetchApi());
  expect(sameOriginHeaders[0]!.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  expect(sameOriginHeaders[0]!.baggage).toContain('bugcapsule-release=shop-web%401.4.0%2B52');
  expect(apiHeaders[0]!.traceparent).toBeUndefined();

  await expect.poll(() => envelopeItems(backend, 'transaction').length, { timeout: 10_000 }).toBe(1);
  const pageload = envelopeItems(backend, 'transaction')[0]!;
  expect(pageload).toMatchObject({ op: 'pageload', name: '/shop', status: 'ok', runtime: 'web' });
  expect(sameOriginHeaders[0]!.traceparent.split('-')[1]).toBe(pageload.traceId);
  const ops = pageload.spans.map((s: any) => s.op);
  expect(ops).toContain('http.client');
  expect(ops).toContain('resource.script');
  const timing = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    return { request: nav?.requestStart > 0 && nav?.responseStart > 0,
      ttfb: nav?.responseStart > 0,
      cls: PerformanceObserver.supportedEntryTypes.includes('layout-shift') };
  });
  expect(ops.includes('browser.request')).toBe(timing.request);
  const http = pageload.spans.find((s: any) => s.op === 'http.client' && s.description === `GET ${ORIGIN}/api/cart`);
  expect(http.data['http.response.status_code']).toBe(200);
  expect(sameOriginHeaders[0]!.traceparent.split('-')[2]).toBe(http.spanId);
  if (timing.ttfb) expect(pageload.measurements.ttfb.unit).toBe('millisecond');
  else expect(pageload.measurements?.ttfb).toBeUndefined();
  if (timing.cls) expect(pageload.measurements.cls).toEqual({ value: expect.any(Number), unit: 'none' });
  else expect(pageload.measurements?.cls).toBeUndefined();

  await page.evaluate(() => history.pushState({}, '', '/product/42?ref=mail'));
  await page.evaluate(() => (window as any).__fetchCart());
  await expect.poll(() => envelopeItems(backend, 'transaction').length, { timeout: 10_000 }).toBe(2);
  const nav = envelopeItems(backend, 'transaction')[1]!;
  expect(nav).toMatchObject({ op: 'navigation', name: '/product/:id' });
  expect(nav.traceId).not.toBe(pageload.traceId);
  expect(nav.spans.some((s: any) => s.op === 'http.client')).toBe(true);
});

test('the feedback widget sends feedback linked to the last event', async ({ page }) => {
  await loadApp(page, { captureCapsuleWithFeedback: false });
  const eventId = await page.evaluate(() => window.BC.BugCapsule.captureException(new Error('declined')));
  await page.evaluate(() => {
    window.BC.BugCapsule.showFeedbackWidget({ theme: { accent: '#0a7' }, defaults: { name: 'Ana' } });
  });
  await page.click('[data-bugcapsule-feedback] >> button.trigger');
  await expect(page.locator('[data-bugcapsule-feedback] >> [role=dialog]')).toBeVisible();
  await page.fill('[data-bugcapsule-feedback] >> textarea', 'Checkout button did nothing');
  await page.fill('[data-bugcapsule-feedback] >> input[name=email]', 'ana@example.com');
  await page.click('[data-bugcapsule-feedback] >> button.submit');
  await expect(page.locator('[data-bugcapsule-feedback] >> .status')).toHaveText('Thanks! Your report was sent.');
  await page.evaluate(() => window.BC.BugCapsule.flush(5000));
  await expect.poll(() => envelopeItems(backend, 'feedback').length).toBe(1);
  expect(envelopeItems(backend, 'feedback')[0]).toMatchObject({ message: 'Checkout button did nothing', name: 'Ana', email: 'ana@example.com', eventId, url: `${ORIGIN}/shop`, capsuleId: null });
  // Pointer events on the widget never record what is typed.
  const crumbs = envelopeItems(backend, 'event')[0]?.breadcrumbs ?? [];
  expect(crumbs.filter((b: any) => b.category === 'ui.click')).toEqual([]);
});

test('console.error capture (opt-in), console breadcrumbs, and the session ends on pagehide', async ({ page }) => {
  await loadApp(page, { captureConsoleErrors: true });
  await page.evaluate(() => {
    console.warn('low stock for', { sku: 'A1' });
    console.error(new RangeError('bad quantity'));
  });
  await page.evaluate(() => window.BC.BugCapsule.flush(5000));
  await expect.poll(() => envelopeItems(backend, 'event').length).toBe(1);
  const event = envelopeItems(backend, 'event')[0]!;
  expect(event.exception.values.at(-1)).toMatchObject({ type: 'RangeError', mechanism: { type: 'logging', handled: true } });
  expect(event.breadcrumbs.find((b: any) => b.category === 'console')).toMatchObject({ level: 'warning', message: 'low stock for {"sku":"A1"}' });
  const sid = envelopeItems(backend, 'session')[0]!.sid;
  // Leaving the page ends the session with a keepalive request. Playwright's routing cannot see
  // requests made during unload, so the page's fetch is observed (sessionStorage survives the navigation).
  await page.goto(`${ORIGIN}/elsewhere`);
  const sent = await page.evaluate(() => sessionStorage.getItem('keepalive'));
  const items = JSON.parse(sent!).items;
  expect(items).toEqual([{ type: 'session', payload: expect.objectContaining({ sid, status: 'exited', errors: 1, init: false }) }]);
});

test('remote monitoringEnabled: false sends no envelopes; capsules still upload', async ({ page }) => {
  backend.config.monitoringEnabled = false;
  await loadApp(page);
  await page.click('#go');
  await expect.poll(() => backend.uploads.length, { timeout: 10_000 }).toBe(1);
  await page.evaluate(() => window.BC.BugCapsule.flush(2000));
  expect(backend.envelopes).toEqual([]);
});

test('replay sends no envelopes and adds no trace headers', async ({ page, context }) => {
  // Capture a capsule whose request reaches the API (a propagation target).
  await page.goto(`${ORIGIN}/`);
  await init(page, { tracePropagationTargets: [API] });
  await page.evaluate((API) => {
    document.getElementById('go')!.addEventListener('click', async () => {
      await fetch(`${API}/cart`);
      throw new Error('after cart');
    });
  }, API);
  await page.click('#go');
  await expect.poll(() => backend.uploads.length, { timeout: 10_000 }).toBe(1);
  expect(apiHeaders[0]!.traceparent).toMatch(/^00-/);
  await page.evaluate(() => window.BC.BugCapsule.flush(5000));
  const capsule = decodeUpload(backend.uploads[0]!);
  capsule.events = capsule.events.filter((e: any) => e.type !== 'http');

  const replayPage = await context.newPage();
  await replayPage.addInitScript(() => {
    (window as any).__BUGCAPSULE_REPLAY__ = { version: 1 };
  });
  const reports: any[] = [];
  await replayPage.exposeBinding('__bugcapsuleReplayCall', async ({ page: p }, op: string, payload: any) => {
    if (op === 'load') return { capsule, settings: { strategy: 'pointer', settleTimeoutMs: 1500, attempt: 1, kind: 'replay', strictNetwork: false, idleCompression: true, attemptId: 'att-1', runtime: 'web' } };
    if (op === 'pointer') {
      await p.mouse.move(payload.x, payload.y);
      if (payload.phase === 'down') await p.mouse.down();
      if (payload.phase === 'up') await p.mouse.up();
    }
    if (op === 'report') reports.push(payload);
    return null;
  });
  const before = backend.envelopes.length;
  apiHeaders.length = 0;
  await replayPage.goto(`${ORIGIN}/`);
  await init(replayPage, { allowReplay: true, tracePropagationTargets: [API] });
  await replayPage.evaluate((API) => {
    document.getElementById('go')!.addEventListener('click', async () => {
      await fetch(`${API}/cart`);
      throw new Error('after cart');
    });
  }, API);
  await expect.poll(() => reports.length, { timeout: 15_000 }).toBe(1);
  expect(reports[0].outcome).toBe('reproduced');
  expect(apiHeaders.length).toBe(1);
  expect(apiHeaders[0]!.traceparent).toBeUndefined();
  expect(await replayPage.evaluate(() => window.BC.BugCapsule.getTraceparent())).toBeNull();
  await replayPage.waitForTimeout(1500);
  expect(backend.envelopes.length).toBe(before);
});
