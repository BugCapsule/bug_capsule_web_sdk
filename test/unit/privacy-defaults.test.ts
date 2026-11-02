import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { activeRuntime, BugCapsule } from '../../packages/web/src/bugcapsule.js';
import { Redactor, type ReplayReport } from '../../packages/web/src/core/index.js';
import { networkIntegration, type NetworkOptions } from '../../packages/web/src/integrations/network.js';
import { parseRemoteConfig, type BugCapsuleTransport } from '../../packages/web/src/remote-config.js';
import { MemoryStorage } from '../../packages/web/src/storage/idb.js';
import type { BugCapsuleConfig, UploadResult } from '../../packages/web/src/types.js';

/** BC-ENT-017: privacy-safe production defaults for bodies, binary payloads and redaction. */
class Transport implements BugCapsuleTransport {
  capsules: any[] = [];
  constructor(readonly config: Record<string, unknown> = { enabled: true, sampleRate: 1 }) {}
  async fetchConfig() {
    return { ok: true as const, config: parseRemoteConfig(this.config, Date.now()) };
  }
  async upload(bytes: Uint8Array): Promise<UploadResult> {
    this.capsules.push(JSON.parse(gunzipSync(bytes).toString('utf8')));
    return { status: 'uploaded', serverId: 's' };
  }
}

const realFetch = globalThis.fetch;
afterEach(async () => {
  await BugCapsule.resetForTest();
  BugCapsule.setTestOverrides(undefined);
  globalThis.fetch = realFetch;
});

const until = async (cond: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const base: BugCapsuleConfig = { appVersion: '1.0.0', appBuild: '7', gitSha: 'abc', monitoring: false, consoleBreadcrumbs: false, productionSampleRate: 1 };

/** The "server" behind fetch: JSON, binary and non-UTF-8 text. */
function stubFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/bin')) return new Response(new Uint8Array([0, 1, 2, 255]), { headers: { 'content-type': 'application/octet-stream' } });
    if (url.endsWith('/latin1')) return new Response(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), { headers: { 'content-type': 'text/plain' } });
    return new Response(JSON.stringify({ price: null, email: 'qa@example.com' }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

async function captureOne(config: Partial<BugCapsuleConfig>, remote?: Record<string, unknown>, network: NetworkOptions = {}, requests: [string, RequestInit?][] = [['https://api.shop.test/cart']]) {
  stubFetch();
  const t = new Transport(remote);
  BugCapsule.setTestOverrides({ storage: new MemoryStorage(), transport: t, random: () => 0.01, bridge: null });
  await BugCapsule.init({ ...base, integrations: [networkIntegration(network)], ...config });
  for (const [url, init] of requests) await (await fetch(url, init)).arrayBuffer();
  await new Promise((r) => setTimeout(r, 20)); // the response clone is read in the background
  BugCapsule.fail('checkout.total');
  await until(() => t.capsules.length === 1);
  const capsule = t.capsules[0]!;
  return { capsule, http: capsule.events.filter((e: any) => e.type === 'http').map((e: any) => e.data), runtime: activeRuntime()! };
}

describe('network body capture defaults', () => {
  it('production records no bodies by default; debug and qa do', async () => {
    const prod = await captureOne({ mode: 'production' });
    assert.equal(prod.runtime.captureNetworkBodies, false);
    assert.equal(prod.http[0].bodyEncoding, 'omitted');
    assert.equal('responseBody' in prod.http[0] && prod.http[0].responseBody !== null, false);
    // (d) eligibility says why replay will be partial.
    assert.ok(prod.capsule.manifest.eligibility.missing.some((m: any) => m.dependency === 'network.bodies' && /production default/.test(m.reason)));
    await BugCapsule.resetForTest();
    for (const mode of ['qa', 'debug'] as const) {
      const r = await captureOne({ mode });
      assert.equal(r.runtime.captureNetworkBodies, true, mode);
      assert.deepEqual(r.http[0].responseBody, { price: null, email: 'qa@example.com' });
      await BugCapsule.resetForTest();
    }
  });

  it('an explicit app setting wins; the backend can only turn bodies off', async () => {
    let r = await captureOne({ mode: 'production', captureNetworkBodies: true });
    assert.equal(r.http[0].bodyEncoding, 'json');
    await BugCapsule.resetForTest();
    r = await captureOne({ mode: 'qa', captureNetworkBodies: false });
    assert.equal(r.http[0].bodyEncoding, 'omitted');
    await BugCapsule.resetForTest();
    r = await captureOne({ mode: 'production' }, { enabled: true, sampleRate: 1, captureNetworkBodies: true });
    assert.equal(r.runtime.captureNetworkBodies, false, 'remote true cannot turn production bodies on');
    assert.equal(r.http[0].bodyEncoding, 'omitted');
    await BugCapsule.resetForTest();
    r = await captureOne({ mode: 'qa' }, { enabled: true, sampleRate: 1, captureNetworkBodies: false });
    assert.equal(r.runtime.captureNetworkBodies, false, 'remote false turns qa bodies off');
    assert.equal(r.http[0].bodyEncoding, 'omitted');
  });
});

describe('binary and non-UTF-8 bodies', () => {
  const requests: [string, RequestInit?][] = [
    ['https://api.shop.test/bin'],
    ['https://api.shop.test/latin1'],
    ['https://api.shop.test/upload', { method: 'POST', body: new Uint8Array([9, 8, 7, 255]), headers: { 'content-type': 'application/octet-stream' } }],
  ];

  it('record only size and content type by default, even in qa; request keys do not change', async () => {
    const off = await captureOne({ mode: 'qa' }, undefined, {}, requests);
    const [bin, latin1, upload] = off.http;
    assert.deepEqual([bin.bodyEncoding, bin.responseBody ?? null, bin.responseBodyBytes, bin.responseContentType], ['omitted', null, 4, 'application/octet-stream']);
    assert.deepEqual([latin1.bodyEncoding, latin1.responseBodyBytes, latin1.responseContentType], ['omitted', 4, 'text/plain']);
    assert.deepEqual([upload.requestEncoding, upload.requestBody, upload.requestBodyBytes, upload.requestContentType], ['omitted', null, 4, 'application/octet-stream']);
    await BugCapsule.resetForTest();

    const on = await captureOne({ mode: 'qa' }, undefined, { captureBinaryBodies: true }, requests);
    assert.deepEqual([on.http[0].bodyEncoding, on.http[0].responseBody], ['base64', 'AAEC/w==']);
    assert.equal(on.http[1].bodyEncoding, 'base64');
    assert.deepEqual([on.http[2].requestEncoding, on.http[2].requestBody], ['base64', 'CQgH/w==']);
    assert.equal('responseBodyBytes' in on.http[0], false);
    assert.deepEqual(
      on.http.map((h: any) => h.key),
      off.http.map((h: any) => h.key),
      'keys hash the body whatever is stored',
    );
  });
});

describe('replay of bodiless fixtures', () => {
  it('serves the recorded status with an empty body and reports network.noBody', async () => {
    const { capsule } = await captureOne({ mode: 'production' });
    await BugCapsule.resetForTest();
    stubFetch();
    const reports: ReplayReport[] = [];
    BugCapsule.setTestOverrides({
      storage: new MemoryStorage(),
      random: () => 0.01,
      bridge: {
        load: async () => ({ capsule, settings: { strategy: 'semantic', settleTimeoutMs: 300, attempt: 1, kind: 'replay', strictNetwork: true, idleCompression: true } }),
        pointer: async () => {},
        report: async (r) => void reports.push(r),
      },
    });
    let realCalls = 0;
    const stub = globalThis.fetch;
    globalThis.fetch = ((...a: Parameters<typeof fetch>) => {
      realCalls++;
      return stub(...a);
    }) as typeof fetch;
    await BugCapsule.init({ ...base, mode: 'qa', allowReplay: true, integrations: [networkIntegration()] });
    const res = await fetch('https://api.shop.test/cart');
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '');
    await until(() => reports.length === 1);
    assert.equal(realCalls, 0, 'served from the capsule');
    assert.equal(reports[0]!.fixturesServed, 1);
    assert.ok(reports[0]!.divergences.some((d) => d.type === 'network.noBody'));
  });
});

describe('redaction additions (W1)', () => {
  const r = new Redactor();
  it('exact body keys pwd, pass, passcode, csrf, refresh, access; no false positives', () => {
    for (const k of ['pwd', 'pass', 'PASS', 'passcode', 'csrf', 'refresh', 'access', 'Access']) assert.equal(r.isSensitiveKey(k), true, k);
    for (const k of ['author', 'accessibility', 'access_level', 'passenger', 'compass', 'refreshRate', 'sessionCount', 'authority']) assert.equal(r.isSensitiveKey(k), false, k);
    assert.deepEqual(r.redactJson({ pwd: 'a', pass: 'b', csrf: 'c', refresh: 'd', access: 'e', author: 'Jane' }), {
      pwd: '[REDACTED]',
      pass: '[REDACTED]',
      csrf: '[REDACTED]',
      refresh: '[REDACTED]',
      access: '[REDACTED]',
      author: 'Jane',
    });
  });

  it('sid, session and auth stay readable as JSON keys (pinned by the shared conformance fixture) but not in URLs or forms', () => {
    for (const k of ['sid', 'session', 'auth']) {
      assert.equal(r.isSensitiveKey(k), false, k);
      assert.equal(r.isSensitiveQueryKey(k), true, k);
    }
  });

  it('headers X-Session and Authentication', () => {
    assert.equal(r.isSensitiveHeader('X-Session'), true);
    assert.equal(r.isSensitiveHeader('Authentication'), true);
    assert.deepEqual(r.redactHeaders({ 'X-Session': 's1', Authentication: 'a', Accept: 'json' }), { 'x-session': '[REDACTED]', authentication: '[REDACTED]', accept: 'json' });
  });

  it('form bodies use the URL parameter list', () => {
    assert.deepEqual(r.redactForm({ code: '123', sid: 's', session: 'x', auth: 'y', name: 'qa', note: 'token abcdefghijk1' }), {
      code: '[REDACTED]',
      sid: '[REDACTED]',
      session: '[REDACTED]',
      auth: '[REDACTED]',
      name: 'qa',
      note: 'token [REDACTED]',
    });
  });

  it('a recorded form request body is redacted with the URL list', async () => {
    const { http } = await captureOne({ mode: 'qa' }, undefined, {}, [
      ['https://api.shop.test/login', { method: 'POST', body: 'code=123&sid=s1&user=qa', headers: { 'content-type': 'application/x-www-form-urlencoded' } }],
    ]);
    assert.equal(http[0].requestEncoding, 'form');
    assert.deepEqual(http[0].requestBody, { code: '[REDACTED]', sid: '[REDACTED]', user: 'qa' });
  });
});
