import { buildSync } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import type { Page, Route } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
let bundle: string | null = null;

/** The SDK bundled for the browser (window.BC = public API, window.BCCore = core). */
export function sdkBundle(): string {
  bundle ??= buildSync({
    entryPoints: [path.join(here, 'entry.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2022',
  }).outputFiles[0]!.text;
  return bundle;
}

export const ORIGIN = 'http://shop.bc.test';
export const BACKEND = 'http://backend.bc.test';
export const API = 'http://api.bc.test';

export interface BackendState {
  config: Record<string, unknown>;
  configStatus: number;
  uploadStatus: number;
  retryAfter?: string;
  uploads: Buffer[];
  configFetches: number;
  /** Abort uploads at the network level (offline). */
  offline: boolean;
  /** `POST /v1/envelope` bodies (decoded) with their request headers. */
  envelopes: { body: Record<string, any>; headers: Record<string, string> }[];
  envelopeStatus: number;
}

export function newBackend(): BackendState {
  return {
    config: { enabled: true, sampleRate: 1, maxCapsuleBytes: 5 * 1024 * 1024, captureNetworkBodies: true, redactKeys: [], configTtlSeconds: 300 },
    configStatus: 200,
    uploadStatus: 201,
    uploads: [],
    configFetches: 0,
    offline: false,
    envelopes: [],
    envelopeStatus: 200,
  };
}

const cors = { 'access-control-allow-origin': ORIGIN, 'access-control-allow-headers': 'authorization, content-type, content-encoding', 'access-control-allow-methods': 'GET, POST', 'access-control-expose-headers': 'Retry-After' };

/** Serves the test page, a fake backend (CORS like bug_capsule_backend) and an app API. */
export async function setUpRoutes(page: Page, backend: BackendState, api: (route: Route, url: URL) => Promise<void> | void = defaultApi): Promise<void> {
  await page.context().route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/sdk.js') return route.fulfill({ contentType: 'text/javascript', body: sdkBundle() });
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="app"><button id="go" data-bugcapsule-action="cart.checkout">Checkout</button><input id="email"><input id="pw" type="password"><div data-bugcapsule-sensitive><input id="secret"></div></div><script src="/sdk.js"></script></body></html>` });
  });
  await page.context().route(`${BACKEND}/**`, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const url = new URL(req.url());
    if (url.pathname === '/v1/sdk/config') {
      backend.configFetches++;
      return route.fulfill({ status: backend.configStatus, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(backend.config) });
    }
    if (url.pathname === '/v1/capsules') {
      if (backend.offline) return route.abort('internetdisconnected');
      const body = req.postDataBuffer();
      if (backend.uploadStatus < 300 && body) backend.uploads.push(body);
      return route.fulfill({
        status: backend.uploadStatus,
        headers: { ...cors, 'content-type': 'application/json', ...(backend.retryAfter ? { 'retry-after': backend.retryAfter } : {}) },
        body: JSON.stringify(backend.uploadStatus < 300 ? { id: 'srv-' + backend.uploads.length } : { code: backend.uploadStatus === 403 ? 'capture_disabled' : 'unavailable' }),
      });
    }
    if (url.pathname === '/v1/envelope') {
      const raw = req.postDataBuffer() ?? Buffer.alloc(0);
      const headers = await req.allHeaders();
      const body = JSON.parse((headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw).toString('utf8'));
      if (backend.envelopeStatus === 200) backend.envelopes.push({ body, headers });
      return route.fulfill({ status: backend.envelopeStatus, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ accepted: body.items.length, rejected: [] }) });
    }
    return route.fulfill({ status: 404, headers: cors });
  });
  await page.context().route(`${API}/**`, (route) => api(route, new URL(route.request().url())));
}

export async function defaultApi(route: Route, url: URL): Promise<void> {
  const h = { 'access-control-allow-origin': ORIGIN, 'access-control-allow-headers': 'content-type, authorization, traceparent, baggage', 'content-type': 'application/json' };
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
  switch (url.pathname) {
    case '/cart':
      return route.fulfill({ headers: h, body: JSON.stringify({ items: [{ sku: 'A1', price: null }], session_token: 'abc123secret' }) });
    case '/big':
      return route.fulfill({ headers: { ...h, 'content-type': 'text/plain' }, body: 'x'.repeat(600 * 1024) });
    case '/events':
      return route.fulfill({ headers: { ...h, 'content-type': 'text/event-stream' }, body: 'data: hi\n\n' });
    case '/echo':
      return route.fulfill({ headers: h, body: route.request().postData() ?? '{}' });
    default:
      return route.fulfill({ status: 404, headers: h, body: '{}' });
  }
}

/** Every item of a type the fake backend received. */
export function envelopeItems(backend: BackendState, type: string): Record<string, any>[] {
  return backend.envelopes.flatMap((e) => e.body.items.filter((i: { type: string }) => i.type === type).map((i: { payload: unknown }) => i.payload));
}

export function decodeUpload(buf: Buffer): Record<string, any> {
  return JSON.parse(gunzipSync(buf).toString('utf8'));
}

export const initScript = (config: Record<string, unknown>) => `
  window.__bcConfig = ${JSON.stringify(config)};
`;
