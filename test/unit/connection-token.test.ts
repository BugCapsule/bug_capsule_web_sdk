import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { BugCapsule } from '../../packages/web/src/bugcapsule.js';
import { parseConnectionToken } from '../../packages/web/src/connection-token.js';
import { MemoryStorage } from '../../packages/web/src/storage/idb.js';

/** Connection token v1 (spec-fixtures/connection-token-v1) and token-only setup. */
const vectors = JSON.parse(readFileSync(new URL('../../spec-fixtures/connection-token-v1/vectors.json', import.meta.url), 'utf8')) as {
  valid: { name: string; token: string; url: string; ingestKey: string }[];
  invalid: { name: string; token: string; error: string }[];
};

describe('connection token v1 vectors', () => {
  for (const v of vectors.valid) {
    it(`parses: ${v.name}`, () => {
      assert.deepEqual(parseConnectionToken(v.token), { ok: true, backend: { url: v.url, ingestKey: v.ingestKey } });
    });
  }
  for (const v of vectors.invalid) {
    it(`refuses: ${v.name}`, () => {
      const r = parseConnectionToken(v.token);
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.error, v.error);
    });
  }
});

const hosted = vectors.valid.find((v) => v.name === 'hosted')!;

interface Seen {
  url: string;
  method: string;
  auth: string | null;
}

/** A fake backend behind globalThis.fetch (the runtime binds fetch when it is created). */
function backend(answer: (url: string, method: string) => Response | Promise<Response> | 'offline' | 'hang') {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    seen.push({ url, method, auth: headers.get('authorization') });
    const a = await answer(url, method);
    if (a === 'offline') throw new TypeError('Failed to fetch');
    if (a === 'hang') return new Promise<Response>(() => {});
    return a;
  }) as typeof fetch;
  return seen;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const okBackend = (url: string, method: string) =>
  url.endsWith('/v1/sdk/config')
    ? json({ enabled: true, sampleRate: 1, configTtlSeconds: 300 })
    : url.endsWith('/v1/envelope')
      ? json({ accepted: 1, rejected: [] })
      : method === 'POST'
        ? json({ id: 'srv-1' }, 201)
        : json({}, 404);

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const realFetch = globalThis.fetch;
const realError = console.error;
const realWarn = console.warn;
let logged: string[] = [];
beforeEach(() => {
  logged = [];
  console.error = (...a: unknown[]) => void logged.push(a.join(' '));
  console.warn = (...a: unknown[]) => void logged.push(a.join(' '));
  BugCapsule.setTestOverrides({ storage: new MemoryStorage(), random: () => 0.01, bridge: null });
});
afterEach(async () => {
  await BugCapsule.resetForTest();
  BugCapsule.setTestOverrides(undefined);
  globalThis.fetch = realFetch;
  console.error = realError;
  console.warn = realWarn;
});

describe('token-only setup', () => {
  it('connects with nothing but the token: config from the token’s API, then data, each confirmed separately', async () => {
    const seen = backend(okBackend);
    await BugCapsule.init({ token: hosted.token, mode: 'qa', consoleBreadcrumbs: false });
    await until(() => BugCapsule.status()!.connection.state === 'connected');
    const s = BugCapsule.status()!;
    assert.equal(s.connection.source, 'token');
    assert.equal(s.connection.apiUrl, 'https://api.bugcapsule.com');
    assert.ok(s.connection.configFetchedAt);
    assert.equal(s.connection.firstCapsuleAcceptedAt, null);
    assert.deepEqual(seen[0], { url: 'https://api.bugcapsule.com/v1/sdk/config', method: 'GET', auth: `Bearer ${hosted.ingestKey}` });

    BugCapsule.reportError(new TypeError('price is null'));
    await until(() => BugCapsule.status()!.connection.firstCapsuleAcceptedAt !== null);
    await BugCapsule.flush(2000);
    assert.ok(seen.some((r) => r.url === 'https://api.bugcapsule.com/v1/capsules' && r.auth === `Bearer ${hosted.ingestKey}`));
    assert.ok(seen.some((r) => r.url === 'https://api.bugcapsule.com/v1/envelope'));
    assert.ok(BugCapsule.status()!.connection.firstEventAcceptedAt);
    // Basic connectivity is not full instrumentation.
    assert.deepEqual(BugCapsule.status()!.instrumentation.missing, ['network', 'navigation', 'app_state']);
    assert.deepEqual(logged, []);
  });

  it('keeps the explicit backend URL + ingest key setup working, and prefers it over a token', async () => {
    const seen = backend(okBackend);
    await BugCapsule.init({ appVersion: '1', appBuild: '1', backend: { url: 'https://self.example.test/bc/', ingestKey: 'bci_' + 'k'.repeat(43) }, token: hosted.token, mode: 'qa' });
    await until(() => BugCapsule.status()!.connection.state === 'connected');
    assert.equal(seen[0]!.url, 'https://self.example.test/bc/v1/sdk/config');
    assert.equal(seen[0]!.auth, `Bearer bci_${'k'.repeat(43)}`);
    assert.equal(BugCapsule.status()!.connection.source, 'backend');
    assert.match(logged.join('\n'), /ignoring token/);
  });

  it('an invalid or unsupported token never throws or touches the network; the app runs without BugCapsule', async () => {
    for (const [token, state] of [
      ['bcsdk.v1.not-json', 'invalid_token'],
      ['bci_' + 'x'.repeat(43), 'invalid_token'],
      [vectors.invalid.find((v) => v.error === 'unsupported_token_version')!.token, 'unsupported_token_version'],
    ] as const) {
      const seen = backend(okBackend);
      await BugCapsule.init({ token, mode: 'qa' });
      const s = BugCapsule.status()!;
      assert.equal(s.connection.state, state);
      assert.ok(s.connection.message);
      BugCapsule.reportError(new Error('still fine'));
      await BugCapsule.flush(200);
      assert.equal(seen.length, 0);
      assert.match(logged.join('\n'), /\[bugcapsule\] the SDK token can't be used/);
      await BugCapsule.resetForTest();
      logged = [];
    }
  });

  it('a revoked token stops capture with the backend’s actionable reason', async () => {
    backend((url) =>
      url.endsWith('/v1/sdk/config')
        ? json({ code: 'unauthorized', reason: 'token_revoked', detail: 'this SDK token was revoked; generate a new token in the BugCapsule dashboard' }, 401)
        : json({}, 401),
    );
    await BugCapsule.init({ token: hosted.token, mode: 'qa' });
    await until(() => BugCapsule.status()!.connection.state === 'rejected');
    const s = BugCapsule.status()!;
    assert.equal(s.connection.reason, 'token_revoked');
    assert.match(s.connection.message!, /generate a new token/);
    assert.equal(BugCapsule.isRecording, false);
    assert.match(logged.join('\n'), /refused this app's SDK token \(token_revoked\): this SDK token was revoked/);
  });

  it('a hanging network never blocks start-up', async () => {
    backend(() => 'hang');
    const started = Date.now();
    await BugCapsule.init({ token: hosted.token, mode: 'qa', setupTimeoutMs: 500 });
    assert.ok(Date.now() - started < 1000, 'init does not wait for the network');
    assert.equal(BugCapsule.status()!.connection.state, 'connecting');
    BugCapsule.reportError(new TypeError('still fine'));
  });

  it('offline: data waits in the outbox and goes out when the backend is back', async () => {
    let mode: 'offline' | 'ok' = 'offline';
    const seen = backend((url, method) => (mode === 'ok' ? okBackend(url, method) : mode));
    await BugCapsule.init({ token: hosted.token, mode: 'qa' });
    await until(() => BugCapsule.status()!.connection.state === 'offline');
    assert.match(BugCapsule.status()!.connection.message!, /could not be reached/);
    BugCapsule.reportError(new TypeError('while offline'));
    let pending = 0;
    for (let i = 0; i < 100 && pending === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      pending = await BugCapsule.pendingUploads();
    }
    assert.ok(pending >= 1, 'the Capsule waits in the outbox');

    mode = 'ok';
    await BugCapsule.refreshRemoteConfig();
    await BugCapsule.flushUploads();
    assert.equal(BugCapsule.status()!.connection.state, 'connected');
    assert.equal(await BugCapsule.pendingUploads(), 0);
    assert.ok(BugCapsule.status()!.connection.firstCapsuleAcceptedAt);
  });
});
