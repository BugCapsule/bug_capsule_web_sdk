import { expect, test, type Page } from '@playwright/test';
import { gzipSync } from 'node:zlib';
import { validateCapsuleDocument } from '../../packages/web/src/core/validator.js';
import { API, BACKEND, ORIGIN, decodeUpload, newBackend, setUpRoutes, type BackendState } from './harness.js';

declare global {
  interface Window {
    BC: typeof import('../../packages/web/src/index.js');
    BCCore: typeof import('../../packages/web/src/core/index.js');
    BCInternal: { UploadOutbox: typeof import('../../packages/web/src/storage/outbox.js').UploadOutbox; openStorage: typeof import('../../packages/web/src/storage/idb.js').openStorage };
    __appSaw?: unknown;
  }
}

const INGEST = 'bci_test_key_0123456789abcdefghij';

async function init(page: Page, extra: Record<string, unknown> = {}) {
  await page.evaluate(
    async ({ BACKEND, INGEST, extra }) => {
      const { BugCapsule, networkIntegration, historyIntegration, localStorageIntegration } = window.BC;
      await BugCapsule.init({
        appVersion: '1.0.0',
        appBuild: '7',
        mode: 'qa',
        gitSha: 'abc123',
        backend: { url: BACKEND, ingestKey: INGEST },
        integrations: [networkIntegration(), historyIntegration(), localStorageIntegration({ allowPrefixes: ['shop.'] })],
        ...extra,
      });
      // Session time starts at the first frame after init (the anchor); input before it is not replayed.
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
    },
    { BACKEND, INGEST, extra },
  );
}

let backend: BackendState;
test.beforeEach(async ({ page }) => {
  backend = newBackend();
  await setUpRoutes(page, backend);
});

test('captures a failure with redacted network, input and pointer events, then uploads it', async ({ page }) => {
  await page.goto(`${ORIGIN}/cart?coupon=SAVE10&token=t0p`);
  await page.evaluate(() => {
    localStorage.setItem('shop.cart', '[1]');
    localStorage.setItem('other.key', 'not allowlisted');
    localStorage.setItem('shop.authToken', 'tok-123');
  });
  await init(page);
  await page.evaluate((API) => {
    const { BugCapsule } = window.BC;
    BugCapsule.trackInput('login.email', document.getElementById('email') as HTMLInputElement);
    BugCapsule.trackInput('card', document.getElementById('pw') as HTMLInputElement);
    BugCapsule.trackInput('note', document.getElementById('secret') as HTMLInputElement);
    document.getElementById('go')!.addEventListener(
      'click',
      BugCapsule.action('cart.checkout', async () => {
        const res = await fetch(`${API}/cart`, { headers: { Authorization: 'Bearer abcdefghijkl' } });
        const cart = await res.json();
        window.__appSaw = cart.session_token; // the app gets the real bytes
        return cart.items[0].price.amount; // TypeError: price is null
      }),
    );
  }, API);
  await page.fill('#email', 'qa@example.com');
  await page.fill('#pw', 'hunter2');
  await page.fill('#secret', 's3cret');
  await page.click('#go');
  await expect.poll(() => backend.uploads.length, { timeout: 10_000 }).toBe(1);
  expect(await page.evaluate(() => window.__appSaw)).toBe('abc123secret');

  const doc = decodeUpload(backend.uploads[0]!);
  expect(validateCapsuleDocument(doc)).toBeNull();
  const m = doc.manifest;
  expect(m.runtime).toMatchObject({ name: 'web', language: 'javascript' });
  expect(m.sdk).toEqual({ name: '@bugcapsule/web', version: '0.3.0' });
  expect(m.capabilities['network.fetch']).toBe('supported');
  expect(m.capabilities['lifecycle.replay']).toBe('partial');
  expect(m.failure.signature).toBe("exception:TypeError:Cannot read properties of null (reading 'amount')");
  // The redacted storage key is a known gap: replay restores a placeholder.
  expect(m.eligibility.status).toBe('partial');
  expect(m.eligibility.missing.map((x: { dependency: string }) => x.dependency)).toEqual(['storage.shop.authToken']);
  expect(m.platform.os).toBe('web');

  const byType = (t: string) => doc.events.filter((e: { type: string }) => e.type === t);
  const down = byType('pointer').find((e: any) => e.data.phase === 'down');
  expect(down.data.target).toMatchObject({ action: 'cart.checkout', tag: 'button', text: 'Checkout' });
  expect(byType('action').map((e: any) => e.data.id)).toContain('cart.checkout');
  const texts = Object.fromEntries(byType('text').map((e: any) => [e.data.id, e.data.value]));
  expect(texts['login.email']).toBe('qa@example.com');
  expect(texts.card).toBe('[REDACTED]'); // password input
  expect(texts.note).toBe('[REDACTED]'); // inside data-bugcapsule-sensitive
  const http = byType('http')[0].data;
  expect(http.key).toBe('GET api.bc.test/cart');
  expect(http.requestHeaders.authorization).toBe('[REDACTED]');
  expect(http.responseBody.session_token).toBe('[REDACTED]');
  expect(http.bodyEncoding).toBe('json');
  expect(http.durationMs).toBeGreaterThanOrEqual(0);
  const ls = doc.checkpoint.data.local_storage;
  expect(ls['shop.cart']).toBe('[1]');
  expect(ls['shop.authToken']).toBe('[REDACTED]');
  expect(ls['other.key']).toBeUndefined();
  expect(doc.checkpoint.data.history.location).toBe('/cart?coupon=SAVE10&token=[REDACTED]');
  expect(byType('failure')).toHaveLength(1);
  expect(byType('failure')[0].data.stack).toBeUndefined();
});

test('response streams reach the app unchanged; large bodies are truncated, event streams omitted', async ({ page }) => {
  await page.goto(`${ORIGIN}/`);
  await init(page);
  const lengths = await page.evaluate(async (API) => {
    const big = await (await fetch(`${API}/big`)).text();
    const sse = await (await fetch(`${API}/events`)).text();
    const echo = await (await fetch(`${API}/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'p', q: 1 }) })).json();
    await new Promise((r) => setTimeout(r, 200));
    window.BC.BugCapsule.fail('manual_check', 'test');
    return { big: big.length, sse, echo };
  }, API);
  expect(lengths.big).toBe(600 * 1024);
  expect(lengths.sse).toBe('data: hi\n\n');
  expect(lengths.echo).toEqual({ password: 'p', q: 1 });
  await expect.poll(() => backend.uploads.length).toBe(1);
  const doc = decodeUpload(backend.uploads[0]!);
  const http = doc.events.filter((e: any) => e.type === 'http').map((e: any) => e.data);
  expect(http.find((h: any) => h.key.includes('/big')).bodyEncoding).toBe('truncated');
  expect(http.find((h: any) => h.key.includes('/events')).bodyEncoding).toBe('omitted');
  const echo = http.find((h: any) => h.key.includes('/echo'));
  expect(echo.requestBody).toEqual({ password: '[REDACTED]', q: 1 });
  expect(echo.key).toMatch(/^POST api\.bc\.test\/echo#[0-9a-f]{16}$/);
  expect(doc.manifest.failure.signature).toBe('assertion:manual_check:');
});

test('offline capture survives a reload and uploads later', async ({ page }) => {
  backend.offline = true;
  await page.goto(`${ORIGIN}/`);
  await init(page);
  await page.evaluate(() => window.BC.BugCapsule.fail('offline_bug', 'while offline'));
  await expect.poll(() => page.evaluate(() => window.BC.BugCapsule.pendingUploads())).toBe(1);
  expect(backend.uploads).toHaveLength(0);

  backend.offline = false;
  await page.reload();
  await init(page);
  await expect.poll(() => backend.uploads.length, { timeout: 10_000 }).toBe(1);
  expect(decodeUpload(backend.uploads[0]!).manifest.failure.assertionId).toBe('offline_bug');
  await expect.poll(() => page.evaluate(() => window.BC.BugCapsule.pendingUploads())).toBe(0);
});

test('a server Retry-After deadline is honoured, even across reloads', async ({ page }) => {
  backend.uploadStatus = 503;
  backend.retryAfter = '3600';
  await page.goto(`${ORIGIN}/`);
  await init(page);
  await page.evaluate(() => window.BC.BugCapsule.fail('retry_bug'));
  await expect.poll(() => page.evaluate(() => window.BC.BugCapsule.pendingUploads())).toBe(1);
  backend.uploadStatus = 201;
  await page.reload();
  await init(page);
  await page.evaluate(() => window.BC.BugCapsule.flushUploads());
  expect(backend.uploads).toHaveLength(0);
  expect(await page.evaluate(() => window.BC.BugCapsule.pendingUploads())).toBe(1);
});

test('kill switch: stops recording, purges queued and saved captures, and persists across reloads', async ({ page }) => {
  backend.offline = true;
  await page.goto(`${ORIGIN}/`);
  await init(page);
  await page.evaluate(() => window.BC.BugCapsule.fail('queued_bug'));
  await expect.poll(() => page.evaluate(() => window.BC.BugCapsule.pendingUploads())).toBe(1);
  backend.config = { ...backend.config, enabled: false };
  await page.evaluate(() => window.BC.BugCapsule.refreshRemoteConfig());
  await expect.poll(() => page.evaluate(() => window.BC.BugCapsule.pendingUploads())).toBe(0);
  expect(await page.evaluate(() => window.BC.BugCapsule.isRecording)).toBe(false);
  expect(await page.evaluate(async () => (await window.BC.BugCapsule.savedCaptures()).length)).toBe(0);
  backend.configStatus = 500; // offline config: the cached kill switch still applies
  await page.reload();
  await init(page);
  expect(await page.evaluate(() => window.BC.BugCapsule.isRecording)).toBe(false);
});

test('a rejected ingest key stops capture for the session', async ({ page }) => {
  backend.configStatus = 401;
  await page.goto(`${ORIGIN}/`);
  await init(page);
  await expect.poll(() => page.evaluate(() => window.BC.BugCapsule.isRecording)).toBe(false);
});

test('outbox: bounded, oldest evicted first, corrupt records dropped, one upload per capsule across tabs', async ({ page, context }) => {
  await page.goto(`${ORIGIN}/`);
  const result = await page.evaluate(async () => {
    const { UploadOutbox, openStorage } = window.BCInternal;
    const storage = await openStorage('outbox-test');
    let t = 1_000_000;
    const outbox = new UploadOutbox(storage, { maxCount: 3, maxBytes: 1000 }, 'lock-a', () => t++);
    const gz = (n: number) => new Uint8Array([0x1f, 0x8b, ...new Array(n).fill(1)]);
    for (let i = 0; i < 5; i++) await outbox.enqueue(`c${i}`, gz(10));
    const tooBig = await outbox.enqueue('huge', gz(2000));
    const ids = (await outbox.entries()).map((e) => e.capsuleId);
    await storage.update('outbox', (records) => ({ put: [{ ...records[0]!, id: '000000000000000_corrupt', capsuleId: 'corrupt', bytes: new Uint8Array([1, 2, 3]) }], result: null }));
    const uploaded: string[] = [];
    await outbox.flush({ upload: async (b) => (uploaded.push(String(b.length)), { status: 'uploaded' }), allowed: () => true });
    return { ids, tooBig, remaining: (await outbox.entries()).length, uploaded: uploaded.length };
  });
  expect(result.tooBig).toBe(false);
  expect(result.ids).toEqual(['c2', 'c3', 'c4']);
  expect(result.uploaded).toBe(3);
  expect(result.remaining).toBe(0);

  // Two tabs flushing the same queue at once upload each capsule once.
  backend.offline = true;
  await init(page);
  await page.evaluate(() => {
    window.BC.BugCapsule.fail('tab_bug_1');
    window.BC.BugCapsule.fail('tab_bug_2');
  });
  await expect.poll(() => page.evaluate(() => window.BC.BugCapsule.pendingUploads())).toBe(2);
  const second = await context.newPage();
  await second.goto(`${ORIGIN}/`);
  backend.offline = false;
  await Promise.all([init(second), page.evaluate(() => window.BC.BugCapsule.flushUploads())]);
  await Promise.all([page.evaluate(() => window.BC.BugCapsule.flushUploads()), second.evaluate(() => window.BC.BugCapsule.flushUploads())]);
  await expect.poll(() => page.evaluate(() => window.BC.BugCapsule.pendingUploads())).toBe(0);
  const ids = backend.uploads.map((b) => decodeUpload(b).manifest.capsuleId);
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(2);
});

test('XMLHttpRequest exchanges are captured', async ({ page }) => {
  await page.goto(`${ORIGIN}/`);
  await init(page);
  const body = await page.evaluate(
    (API) =>
      new Promise<string>((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${API}/echo`);
        xhr.setRequestHeader('content-type', 'application/json');
        xhr.onload = () => resolve(xhr.responseText);
        xhr.send(JSON.stringify({ a: 1, apiKey: 'k' }));
      }),
    API,
  );
  expect(JSON.parse(body)).toEqual({ a: 1, apiKey: 'k' });
  await page.evaluate(() => window.BC.BugCapsule.fail('xhr_check'));
  await expect.poll(() => backend.uploads.length).toBe(1);
  const http = decodeUpload(backend.uploads[0]!).events.find((e: any) => e.type === 'http').data;
  expect(http.method).toBe('POST');
  expect(http.status).toBe(200);
  expect(http.requestBody).toEqual({ a: 1, apiKey: '[REDACTED]' });
  expect(http.responseBody).toEqual({ a: 1, apiKey: '[REDACTED]' });
});

test('production mode samples sessions and never uploads without a fetched config', async ({ page }) => {
  backend.configStatus = 500;
  await page.goto(`${ORIGIN}/`);
  await init(page, { mode: 'production', productionSampleRate: 1 });
  await page.evaluate(() => window.BC.BugCapsule.fail('prod_bug'));
  await expect.poll(() => page.evaluate(() => window.BC.BugCapsule.pendingUploads())).toBe(1);
  expect(backend.uploads).toHaveLength(0);
  await page.reload();
  await init(page, { mode: 'production', productionSampleRate: 0 });
  expect(await page.evaluate(() => window.BC.BugCapsule.isRecording)).toBe(false);
});

// ------------------------------------------------------------------ replay

interface Bridge {
  reports: any[];
  loads: number;
}

async function withBridge(page: Page, capsule: unknown, settings: Record<string, unknown> = {}): Promise<Bridge> {
  const bridge: Bridge = { reports: [], loads: 0 };
  await page.addInitScript(() => {
    (window as any).__BUGCAPSULE_REPLAY__ = { version: 1 };
  });
  await page.exposeBinding('__bugcapsuleReplayCall', async ({ page: p }, op: string, payload: any) => {
    if (op === 'load') {
      bridge.loads++;
      return { capsule, settings: { strategy: 'auto', settleTimeoutMs: 1500, attempt: 1, kind: 'replay', strictNetwork: true, idleCompression: true, attemptId: 'att-1', runtime: 'web', ...settings } };
    }
    if (op === 'pointer') {
      await p.mouse.move(payload.x, payload.y);
      if (payload.phase === 'down') await p.mouse.down();
      if (payload.phase === 'up') await p.mouse.up();
      return null;
    }
    if (op === 'report') bridge.reports.push(payload);
    return null;
  });
  return bridge;
}

async function captureCheckoutCapsule(page: Page): Promise<any> {
  await page.goto(`${ORIGIN}/`);
  await page.evaluate(() => localStorage.setItem('shop.legacy', 'v0.9'));
  await init(page);
  await installApp(page);
  await page.fill('#email', 'qa@example.com');
  await page.click('#go');
  await expect.poll(() => backend.uploads.length, { timeout: 10_000 }).toBe(1);
  return decodeUpload(backend.uploads[0]!);
}

/** The "app": same code in capture and replay. */
async function installApp(page: Page): Promise<void> {
  await page.evaluate((API) => {
    const { BugCapsule } = window.BC;
    BugCapsule.trackInput('login.email', document.getElementById('email') as HTMLInputElement);
    document.getElementById('go')!.addEventListener(
      'click',
      BugCapsule.action('cart.checkout', async () => {
        const email = (document.getElementById('email') as HTMLInputElement).value;
        const cart = await (await fetch(`${API}/cart?who=${encodeURIComponent(email)}`)).json();
        (window as any).__legacy = localStorage.getItem('shop.legacy');
        return cart.items[0].price.amount;
      }),
    );
  }, API);
}

test('replay reproduces a captured failure in the real page code', async ({ page, context }) => {
  const capsule = await captureCheckoutCapsule(page);
  const replayPage = await context.newPage();
  await replayPage.setViewportSize({ width: capsule.manifest.platform.screen.width, height: capsule.manifest.platform.screen.height });
  const bridge = await withBridge(replayPage, capsule);
  let apiHits = 0;
  await replayPage.route(`${API}/**`, (r) => {
    apiHits++;
    return r.abort();
  });
  await replayPage.goto(`${ORIGIN}/`);
  await replayPage.evaluate(() => localStorage.clear());
  await init(replayPage, { allowReplay: true });
  expect(await replayPage.evaluate(() => localStorage.getItem('shop.legacy'))).toBe('v0.9'); // restored before the app runs
  await installApp(replayPage);
  await expect.poll(() => bridge.reports.length, { timeout: 15_000 }).toBe(1);
  const r = bridge.reports[0];
  expect(r.outcome).toBe('reproduced');
  expect(r.attemptId).toBe('att-1');
  expect(r.runtime).toBe('web');
  expect(r.strategy).toBe('pointer');
  expect(r.eventsDispatched).toBe(r.eventsExpected);
  expect(r.fixturesServed).toBe(1);
  expect(r.observed.signature).toBe(capsule.manifest.failure.signature);
  expect(r.divergences.filter((d: any) => !['network.unused', 'build.gitSha'].includes(d.type))).toEqual([]);
  expect(apiHits).toBe(0); // served from the capsule, never the network
  expect(await replayPage.evaluate(() => (window as any).__legacy)).toBe('v0.9');
});

test('semantic replay invokes registered actions; a fix makes the attempt clean', async ({ page, context }) => {
  const capsule = await captureCheckoutCapsule(page);
  const replayPage = await context.newPage();
  const bridge = await withBridge(replayPage, capsule, { strategy: 'semantic', kind: 'verify' });
  await replayPage.goto(`${ORIGIN}/`);
  await init(replayPage, { allowReplay: true });
  // The "fixed" app: same action, guards the null price.
  await replayPage.evaluate((API) => {
    const { BugCapsule } = window.BC;
    BugCapsule.trackInput('login.email', document.getElementById('email') as HTMLInputElement);
    document.getElementById('go')!.addEventListener(
      'click',
      BugCapsule.action('cart.checkout', async () => {
        const email = (document.getElementById('email') as HTMLInputElement).value;
        const cart = await (await fetch(`${API}/cart?who=${encodeURIComponent(email)}`)).json();
        return cart.items[0].price?.amount ?? 0;
      }),
    );
  }, API);
  await expect.poll(() => bridge.reports.length, { timeout: 15_000 }).toBe(1);
  const r = bridge.reports[0];
  expect(r.strategy).toBe('semantic');
  expect(r.outcome).toBe('not_reproduced');
  expect(r.eventsDispatched).toBe(r.eventsExpected);
  expect(r.otherFailures).toEqual([]);
  expect(r.divergences.filter((d: any) => !['network.unused', 'build.gitSha'].includes(d.type))).toEqual([]);
});

test('strict replay: an unrecorded request never reaches the network and is reported', async ({ page, context }) => {
  const capsule = await captureCheckoutCapsule(page);
  capsule.events = capsule.events.filter((e: any) => e.type !== 'http');
  const replayPage = await context.newPage();
  const bridge = await withBridge(replayPage, capsule, { strategy: 'semantic' });
  let apiHits = 0;
  await replayPage.route(`${API}/**`, (r) => {
    apiHits++;
    return r.abort();
  });
  await replayPage.goto(`${ORIGIN}/`);
  await init(replayPage, { allowReplay: true });
  await installApp(replayPage);
  await expect.poll(() => bridge.reports.length, { timeout: 15_000 }).toBe(1);
  const types = bridge.reports[0].divergences.map((d: any) => d.type);
  expect(types).toContain('network.unrecorded');
  expect(types).toContain('failure.other');
  expect(apiHits).toBe(0);
});

test('production protection: the replay bridge is ignored unless allowReplay is set', async ({ page, context }) => {
  const capsule = await captureCheckoutCapsule(page);
  const replayPage = await context.newPage();
  const bridge = await withBridge(replayPage, capsule);
  await replayPage.goto(`${ORIGIN}/`);
  await init(replayPage, { allowReplay: false });
  expect(await replayPage.evaluate(() => window.BC.BugCapsule.isReplaying)).toBe(false);
  expect(await replayPage.evaluate(() => window.BC.BugCapsule.isRecording)).toBe(true);
  expect(bridge.loads).toBe(0);
});

test('a capsule from another runtime is reported incompatible', async ({ page, context }) => {
  const capsule = await captureCheckoutCapsule(page);
  capsule.manifest.runtime = { name: 'android' };
  const replayPage = await context.newPage();
  const bridge = await withBridge(replayPage, capsule);
  await replayPage.goto(`${ORIGIN}/`);
  await init(replayPage, { allowReplay: true });
  await expect.poll(() => bridge.reports.length).toBe(1);
  expect(bridge.reports[0].outcome).toBe('incompatible');
  expect(bridge.reports[0].divergences[0].type).toBe('runtime.mismatch');
});

test('XMLHttpRequest replay serves the recorded response with its latency', async ({ page, context }) => {
  await page.goto(`${ORIGIN}/`);
  await init(page);
  await page.evaluate((API) => {
    document.getElementById('go')!.addEventListener('click', window.BC.BugCapsule.action('xhr.load', () => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', `${API}/cart`);
      xhr.responseType = 'json';
      xhr.onload = () => {
        (window as any).__xhr = { status: xhr.status, ready: xhr.readyState, type: xhr.getResponseHeader('content-type') };
        (xhr.response as any).items[0].price.amount;
      };
      xhr.send();
    }));
  }, API);
  await page.click('#go');
  await expect.poll(() => backend.uploads.length, { timeout: 10_000 }).toBe(1);
  const capsule = decodeUpload(backend.uploads[0]!);
  const replayPage = await context.newPage();
  const bridge = await withBridge(replayPage, capsule, { strategy: 'semantic' });
  await replayPage.goto(`${ORIGIN}/`);
  await init(replayPage, { allowReplay: true });
  await replayPage.evaluate((API) => {
    window.BC.BugCapsule.action('xhr.load', () => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', `${API}/cart`);
      xhr.responseType = 'json';
      xhr.onload = () => {
        (window as any).__xhr = { status: xhr.status, ready: xhr.readyState, type: xhr.getResponseHeader('content-type') };
        (xhr.response as any).items[0].price.amount;
      };
      xhr.send();
    });
  }, API);
  await expect.poll(() => bridge.reports.length, { timeout: 15_000 }).toBe(1);
  expect(bridge.reports[0].outcome).toBe('reproduced');
  expect(await replayPage.evaluate(() => (window as any).__xhr)).toEqual({ status: 200, ready: 4, type: 'application/json' });
});

test('invalid capsules from the runner are rejected as incompatible', async ({ context }) => {
  const page = await context.newPage();
  const bridge = await withBridge(page, { format: 'bugcapsule.capsule', specVersion: 1, manifest: {} });
  await page.goto(`${ORIGIN}/`);
  await init(page, { allowReplay: true });
  await expect.poll(() => bridge.reports.length).toBe(1);
  expect(bridge.reports[0].outcome).toBe('incompatible');
  expect(bridge.reports[0].message).toContain('$.manifest.capsuleId');
  void gzipSync;
});
