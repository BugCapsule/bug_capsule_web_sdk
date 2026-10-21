import { buildSync } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { BACKEND, ORIGIN, envelopeItems, newBackend, setUpRoutes, type BackendState } from './harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let bundle: string | null = null;
function reactBundle(): string {
  bundle ??= buildSync({
    entryPoints: [path.join(here, 'react-entry.tsx')],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2022',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    alias: { '@bugcapsule/web': path.join(here, '..', '..', 'packages', 'web', 'src', 'index.ts') },
  }).outputFiles[0]!.text;
  return bundle;
}

let backend: BackendState;
test.beforeEach(async ({ page }) => {
  backend = newBackend();
  await setUpRoutes(page, backend);
  await page.route(`${ORIGIN}/sdk.js`, (route) => route.fulfill({ contentType: 'text/javascript', body: reactBundle() }));
});

async function init(page: Page, extra: Record<string, unknown> = {}) {
  await page.evaluate(
    async ({ BACKEND, extra }) => {
      await (window as any).BC.BugCapsule.init({
        appVersion: '1.0.0',
        appBuild: '1',
        mode: 'qa',
        gitSha: 'abc',
        backend: { url: BACKEND, ingestKey: 'bci_test_key_0123456789abcdefghij' },
        integrations: [(window as any).BC.historyIntegration()],
        ...extra,
      });
    },
    { BACKEND, extra },
  );
}

test('BugCapsuleErrorBoundary reports a handled event with the component stack and gets its event id', async ({ page }) => {
  await page.goto(`${ORIGIN}/`);
  await init(page);
  await page.evaluate(() => {
    const w = window as any;
    const { createElement: h } = w.React;
    function Price(): never {
      throw new TypeError('price is null');
    }
    const root = w.ReactDOMClient.createRoot(document.getElementById('app'));
    w.__boundary = null;
    root.render(
      h(w.BCReact.BugCapsuleErrorBoundary, { fallback: (_e: unknown, _reset: unknown, eventId: string | null) => h('p', { id: 'oops' }, `oops ${eventId}`), onError: (_e: unknown, _s: unknown, id: string) => (w.__boundary = id) }, h(Price)),
    );
  });
  await expect(page.locator('#oops')).toContainText('oops ');
  await page.evaluate(() => (window as any).BC.BugCapsule.flush(5000));
  await expect.poll(() => envelopeItems(backend, 'event').length).toBeGreaterThan(0);
  const event = envelopeItems(backend, 'event').find((e) => e.contexts?.react)!;
  expect(event.exception.values.at(-1)).toMatchObject({ type: 'TypeError', value: 'price is null', mechanism: { type: 'manual', handled: true, data: { source: 'react.errorBoundary' } } });
  expect(event.contexts.react.componentStack).toContain('Price');
  expect(await page.evaluate(() => (window as any).__boundary)).toBe(event.eventId);
  expect(await page.locator('#oops').textContent()).toBe(`oops ${event.eventId}`);
  // Handled: the session is errored, not crashed.
  expect(envelopeItems(backend, 'session').map((s) => s.status)).not.toContain('crashed');
});

test('BugCapsuleRouteListener names navigation transactions after the matched route pattern', async ({ page }) => {
  await page.goto(`${ORIGIN}/`);
  await init(page, { tracesSampleRate: 1 });
  await page.evaluate(() => {
    const w = window as any;
    const { createElement: h } = w.React;
    const { BrowserRouter, Routes, Route, Link } = w.Router;
    const routes = [{ path: '/' }, { path: '/shop', children: [{ path: 'product/:productId' }] }];
    const root = w.ReactDOMClient.createRoot(document.getElementById('app'));
    root.render(
      h(
        BrowserRouter,
        null,
        h(w.BCRouter.BugCapsuleRouteListener, { routes }),
        h(Link, { id: 'to-product', to: '/shop/product/8f3a2b9c1d' }, 'product'),
        h(Routes, null, h(Route, { path: '/', element: h('p', null, 'home') }), h(Route, { path: '/shop/product/:productId', element: h('p', { id: 'product' }, 'product page') })),
      ),
    );
  });
  await page.click('#to-product');
  await expect(page.locator('#product')).toBeVisible();
  await expect.poll(() => envelopeItems(backend, 'transaction').map((t) => [t.op, t.name]), { timeout: 15_000 }).toContainEqual(['navigation', '/shop/product/:productId']);
});

test('reactErrorHandler for React 19 root callbacks reports uncaught errors as unhandled', async ({ page }) => {
  await page.goto(`${ORIGIN}/`);
  await init(page);
  await page.evaluate(() => {
    const w = window as any;
    const { createElement: h } = w.React;
    function Boom(): never {
      throw new RangeError('quantity out of range');
    }
    const root = w.ReactDOMClient.createRoot(document.getElementById('app'), { onUncaughtError: w.BCReact.reactErrorHandler('uncaught') });
    root.render(h(Boom));
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => (window as any).BC.BugCapsule.flush(5000));
  await expect.poll(() => envelopeItems(backend, 'event').length).toBeGreaterThan(0);
  const event = envelopeItems(backend, 'event').find((e) => e.exception.values.at(-1).value === 'quantity out of range')!;
  expect(event.exception.values.at(-1).mechanism).toMatchObject({ type: 'uncaught', handled: false });
  expect(envelopeItems(backend, 'session').map((s) => s.status)).toContain('crashed');
});
