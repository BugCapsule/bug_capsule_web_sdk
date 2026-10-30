import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createEmergencyGuard,
  EmergencyBlockedError,
  type EmergencyGuard,
  type EmergencyGuardOptions,
  type GuardChange,
} from '../../../packages/emergency-guard/src/index.js';
import {
  APP_ID,
  ENV,
  FakeBugCapsule,
  INGEST_KEY,
  T0,
  captureLogger,
  delay,
  document,
  fixture,
  makeAnchor,
  makeKey,
  policy,
  signEnvelope,
  until,
  type CapturedLogger,
  type Envelope,
} from './helpers.js';

const key = makeKey('ek_guard');
const ANCHOR = makeAnchor(APP_ID, [key]);

interface Ctx {
  api: FakeBugCapsule;
  guard: EmergencyGuard;
  log: CapturedLogger;
  clock: { now: number };
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(options: Partial<EmergencyGuardOptions> = {}, api?: FakeBugCapsule): Promise<Ctx> {
  const server = api ?? (await new FakeBugCapsule().start());
  if (!api) cleanups.push(() => server.close());
  const clock = { now: T0 };
  const log = captureLogger();
  const guard = createEmergencyGuard({
    apiUrl: server.url,
    credential: INGEST_KEY,
    trustAnchor: ANCHOR,
    environment: ENV,
    now: () => clock.now,
    random: () => 0.5,
    logger: log,
    ...options,
  });
  cleanups.push(() => guard.stop());
  return { api: server, guard, log, clock };
}

function signed(overrides: Record<string, unknown> = {}): Envelope {
  return signEnvelope(key, document(overrides));
}

const blockCheckout = (revision: number, extra: Record<string, unknown> = {}) => signed({ revision, policies: [policy({ revision, ...extra })] });

describe('fetching and acceptance (§3, §5)', () => {
  it('fetches with platform SERVER, verifies, evaluates, and sends one APPLIED receipt', async () => {
    const { api, guard } = await setup({ appVersion: '3.1.0' });
    api.serve(blockCheckout(5));
    await guard.start();
    const get = api.policyGets[0]!;
    assert.equal(get.path, `/v1/apps/${APP_ID}/emergency/policies`);
    assert.equal(get.query.get('platform'), 'SERVER');
    assert.equal(get.query.get('environment'), ENV);
    assert.equal(get.query.get('app_version'), '3.1.0');
    assert.ok(get.query.get('sdk_version'));
    assert.equal(get.headers.authorization, `Bearer ${INGEST_KEY}`);
    assert.equal(get.headers['if-none-match'], undefined);

    const s = guard.status();
    assert.equal(s.state, 'usable');
    assert.equal(s.revision, 5);
    assert.equal(s.running, true);
    const d = guard.evaluate('checkout.confirm_order', { subject: 'user-1' });
    assert.equal(d.action, 'BLOCK');
    assert.equal(d.source, 'policy');
    assert.equal(d.documentRevision, 5);
    assert.equal(guard.evaluate('search.query').action, 'ALLOW');

    await until(() => api.receipts.length === 1);
    const r = api.receipts[0]!;
    assert.match(String(r.installationId), /^[A-Za-z0-9_-]{22}$/);
    assert.deepEqual({ ...r, installationId: 'x', sdkVersion: 'x' }, {
      environment: ENV,
      platform: 'SERVER',
      installationId: 'x',
      appVersion: '3.1.0',
      sdkVersion: 'x',
      revision: 5,
      status: 'APPLIED',
      errorCode: null,
    });
  });

  it('sends If-None-Match and treats 304 as current', async () => {
    const { api, guard } = await setup();
    api.serve(blockCheckout(5));
    await guard.refresh();
    const outcome = await guard.refresh();
    assert.deepEqual(outcome, { kind: 'not_modified' });
    assert.ok(api.policyGets[1]!.headers['if-none-match']);
    assert.equal(guard.status().revision, 5);
  });

  it('rejects a lower revision (stale_revision) and keeps the current document; FAILED receipt once', async () => {
    const { api, guard } = await setup();
    api.serve(blockCheckout(5));
    await guard.refresh();
    api.serve(signed({ revision: 4, policies: [] }));
    assert.deepEqual(await guard.refresh(), { kind: 'rejected', reason: 'stale_revision' });
    assert.deepEqual(await guard.refresh(), { kind: 'rejected', reason: 'stale_revision' });
    assert.equal(guard.status().revision, 5);
    assert.equal(guard.evaluate('checkout.confirm_order').action, 'BLOCK');
    assert.equal(guard.status().lastError?.code, 'stale_revision');
    await until(() => api.receipts.length === 2);
    await delay(20);
    assert.deepEqual(
      api.receipts.map((r) => [r.revision, r.status, r.errorCode]),
      [
        [5, 'APPLIED', null],
        [4, 'FAILED', 'stale_revision'],
      ],
    );
  });

  it('same revision: keeps the current document unless issued_at is later', async () => {
    const { api, guard } = await setup();
    const changes: GuardChange[] = [];
    guard.onChange((c) => changes.push(c));
    const first = signed({ revision: 5, issued_at: new Date(T0 - 60_000).toISOString(), policies: [policy()] });
    api.serve(first);
    await guard.refresh();
    // Same revision and issued_at, re-signed (different bytes): nothing changes.
    api.serve(signed({ revision: 5, issued_at: new Date(T0 - 60_000).toISOString(), policies: [] }));
    assert.deepEqual(await guard.refresh(), { kind: 'unchanged', revision: 5 });
    assert.equal(guard.evaluate('checkout.confirm_order').action, 'BLOCK');
    // Same revision, later issued_at (re-issued with a new expiry): accepted.
    const reissued = signed({ revision: 5, issued_at: new Date(T0).toISOString(), expires_at: new Date(T0 + 7200_000).toISOString(), policies: [policy()] });
    api.serve(reissued);
    assert.deepEqual(await guard.refresh(), { kind: 'updated', revision: 5 });
    assert.equal(guard.status().expiresAt, new Date(T0 + 7200_000).toISOString());
    assert.deepEqual(
      changes.map((c) => [c.reason, c.previousRevision, c.revision]),
      [
        ['fetched', null, 5],
        ['fetched', 5, 5],
      ],
    );
  });

  it('expired_on_arrival only beyond the 300 s allowance', async () => {
    const { api, guard } = await setup();
    api.serve(signed({ revision: 3, expires_at: new Date(T0 - 301_000).toISOString() }));
    assert.deepEqual(await guard.refresh(), { kind: 'rejected', reason: 'expired_on_arrival' });
    assert.equal(guard.status().state, 'none');
    api.serve(signed({ revision: 3, expires_at: new Date(T0 - 299_000).toISOString(), policies: [policy()] }));
    assert.deepEqual(await guard.refresh(), { kind: 'updated', revision: 3 });
    assert.equal(guard.status().state, 'usable');
    assert.equal(guard.evaluate('checkout.confirm_order').source, 'policy');
  });

  it('serves the shared fixture envelopes end to end', async () => {
    const env = fixture<{ anchor: string; cases: { name: string; envelope: Envelope; revision?: number }[] }>('envelopes.json');
    const pick = (n: string) => env.cases.find((c) => c.name === n)!.envelope;
    const revision = env.cases.find((c) => c.name === 'valid')!.revision!;
    const { api, guard } = await setup({ trustAnchor: env.anchor });
    api.serve(pick('valid'));
    assert.deepEqual(await guard.refresh(), { kind: 'updated', revision });
    const d = guard.evaluate('checkout.confirm_order');
    assert.equal(d.action, 'BLOCK');
    assert.equal(d.reasonCode, 'PRICING_SAFETY');
    for (const [name, reason] of [
      ['valid_older_revision', 'stale_revision'],
      ['payload_tampered', 'bad_signature'],
      ['valid_second_key', 'unknown_key'],
      ['other_environment', 'wrong_environment'],
      ['future_schema', 'unsupported_schema'],
    ] as const) {
      api.serve(pick(name));
      assert.deepEqual(await guard.refresh(), { kind: 'rejected', reason }, name);
      assert.equal(guard.status().revision, revision);
    }
  });

  it('answers non-200 statuses as failed fetches', async () => {
    const { api, guard } = await setup();
    assert.deepEqual(await guard.refresh(), { kind: 'failed', code: 'emergency_not_configured' });
    api.overrides.push({ status: 500, body: 'oops' });
    assert.deepEqual(await guard.refresh(), { kind: 'failed', code: 'http_500' });
    api.overrides.push({ status: 200, body: 'not json' });
    assert.deepEqual(await guard.refresh(), { kind: 'rejected', reason: 'malformed' });
    api.overrides.push({ status: 200, body: JSON.stringify({ padding: 'x'.repeat(1024 * 1024) }) });
    assert.deepEqual(await guard.refresh(), { kind: 'failed', code: 'body_too_large' });
    assert.equal(guard.status().lastError?.code, 'body_too_large');
  });

  it('times out a hanging request', async () => {
    const { api, guard } = await setup({ requestTimeoutMs: 100 });
    api.overrides.push({ hang: true });
    assert.deepEqual(await guard.refresh(), { kind: 'failed', code: 'timeout' });
  });

  it('joins concurrent refreshes into one request', async () => {
    const { api, guard } = await setup();
    api.serve(blockCheckout(1));
    api.delayMs = 50;
    const outcomes = await Promise.all([guard.refresh(), guard.refresh(), guard.refresh(), guard.refresh(), guard.refresh()]);
    assert.equal(api.policyGets.length, 1);
    assert.ok(outcomes.every((o) => o.kind === 'updated'));
  });
});

describe('failure modes (§7.4)', () => {
  it('with no document: FAIL_OPEN by default, FAIL_CLOSED and USE_LAST_VALID_POLICY per key', async () => {
    const { api, guard } = await setup({
      failureModes: { 'checkout.*': 'FAIL_CLOSED', 'checkout.view_cart': 'FAIL_OPEN', 'checkout.pay.*': 'USE_LAST_VALID_POLICY', 'wallet.*': 'USE_LAST_VALID_POLICY' },
    });
    api.sticky = { status: 503 };
    await guard.start();
    assert.equal(guard.status().state, 'none');
    const open = guard.evaluate('search.query');
    assert.deepEqual(
      { allowed: open.allowed, action: open.action, reason: open.reasonCode, source: open.source, rev: open.documentRevision },
      { allowed: true, action: 'ALLOW', reason: 'POLICY_UNAVAILABLE', source: 'failure_mode', rev: null },
    );
    const closed = guard.evaluate('checkout.confirm_order');
    assert.equal(closed.action, 'BLOCK');
    assert.equal(closed.reasonCode, 'POLICY_UNAVAILABLE');
    assert.equal(closed.source, 'failure_mode');
    // `checkout.*` does not cover `checkout` itself.
    assert.equal(guard.evaluate('checkout').action, 'ALLOW');
    // Exact beats prefix; the longest prefix wins.
    assert.equal(guard.evaluate('checkout.view_cart').action, 'ALLOW');
    assert.equal(guard.failureModeFor('checkout.pay.card'), 'USE_LAST_VALID_POLICY');
    assert.equal(guard.failureModeFor('checkout.pay'), 'FAIL_CLOSED');
    // USE_LAST_VALID_POLICY without any document behaves like FAIL_OPEN.
    const last = guard.evaluate('wallet.transfer');
    assert.equal(last.action, 'ALLOW');
    assert.equal(last.source, 'failure_mode');
    await assert.rejects(guard.enforce({ featureKey: 'checkout.confirm_order', subject: 'u1' }), (e: unknown) => {
      return e instanceof EmergencyBlockedError && e.reasonCode === 'POLICY_UNAVAILABLE' && e.action === 'BLOCK';
    });
  });

  it('after the document expires (+300 s), each mode applies; USE_LAST_VALID_POLICY evaluates it as stale', async () => {
    const { api, guard, clock } = await setup({ failureModes: { 'checkout.confirm_order': 'USE_LAST_VALID_POLICY', 'wallet.*': 'FAIL_CLOSED' } });
    api.serve(signed({ revision: 8, expires_at: new Date(T0 + 60_000).toISOString(), policies: [policy({ key: 'checkout.*' })] }));
    await guard.refresh();
    clock.now = T0 + 60_000 + 300_000;
    assert.equal(guard.status().state, 'usable');
    assert.equal(guard.evaluate('checkout.view_cart').source, 'policy');
    clock.now += 1;
    assert.equal(guard.status().state, 'expired');
    const stale = guard.evaluate('checkout.confirm_order');
    assert.deepEqual([stale.action, stale.source, stale.documentRevision], ['BLOCK', 'stale_policy', 8]);
    const open = guard.evaluate('checkout.view_cart');
    assert.deepEqual([open.action, open.source, open.reasonCode], ['ALLOW', 'failure_mode', 'POLICY_UNAVAILABLE']);
    const closed = guard.evaluate('wallet.transfer');
    assert.deepEqual([closed.action, closed.source, closed.documentRevision], ['BLOCK', 'failure_mode', 8]);
  });

  it('an invalid anchor turns policies off: one warning, no fetches, failure modes only', async () => {
    const { api, guard, log } = await setup({ trustAnchor: makeAnchor(APP_ID, [{ ...key, alg: 'RS256' }]), failureModes: { 'checkout.*': 'FAIL_CLOSED' } });
    await guard.start();
    assert.equal(api.requests.length, 0);
    assert.equal(guard.status().anchorValid, false);
    assert.equal(guard.status().lastError?.code, 'invalid_anchor');
    assert.equal(log.lines.filter((l) => l.startsWith('warn')).length, 1);
    assert.equal(guard.evaluate('checkout.confirm_order').action, 'BLOCK');
    assert.equal(guard.evaluate('search.query').action, 'ALLOW');
    assert.deepEqual(await guard.refresh(), { kind: 'disabled' });
  });

  it('validates configuration eagerly', () => {
    const base = { apiUrl: 'http://127.0.0.1:1', credential: INGEST_KEY, trustAnchor: ANCHOR, environment: ENV, logger: false as const };
    assert.throws(() => createEmergencyGuard({ ...base, environment: 'Prod' }), TypeError);
    assert.throws(() => createEmergencyGuard({ ...base, refreshIntervalMs: 999 }), RangeError);
    assert.throws(() => createEmergencyGuard({ ...base, failureModes: { '*': 'FAIL_CLOSED' } }), TypeError);
    assert.throws(() => createEmergencyGuard({ ...base, failureModes: { 'a.b': 'CLOSED' as never } }), TypeError);
    assert.throws(() => createEmergencyGuard({ ...base, credential: 'bcs_secretsecretsecretsecret' }), TypeError);
    const g = createEmergencyGuard(base);
    assert.equal(g.refreshIntervalMs, 5000);
    assert.throws(() => g.evaluate('Checkout'), TypeError);
    assert.throws(() => g.evaluate('checkout.*'), TypeError);
  });
});

describe('enforce', () => {
  it('READ_ONLY: reads pass, writes are refused with a 503 problem', async () => {
    const { api, guard } = await setup();
    api.serve(signed({ revision: 11, policies: [policy({ policy_id: 'ro', key: 'wallet.*', action: 'READ_ONLY', revision: 4, reason_code: 'LEDGER_CHECK', public_user_message: 'Transfers are paused.' })] }));
    await guard.refresh();
    const read = await guard.enforce({ featureKey: 'wallet.balance', operation: 'read', subject: 'u1' });
    assert.equal(read.action, 'READ_ONLY');
    await assert.rejects(guard.enforce({ featureKey: 'wallet.transfer', operation: 'write', subject: 'u1' }), (e: unknown) => {
      assert.ok(e instanceof EmergencyBlockedError);
      assert.equal(e.code, 'emergency_blocked');
      assert.equal(e.retryable, true);
      assert.equal(e.status, 503);
      assert.equal(e.featureKey, 'wallet.transfer');
      assert.equal(e.action, 'READ_ONLY');
      assert.equal(e.reasonCode, 'LEDGER_CHECK');
      assert.equal(e.publicUserMessage, 'Transfers are paused.');
      assert.equal(e.policyRevision, 4);
      assert.equal(e.documentRevision, 11);
      const p = e.toProblem({ instance: '/transfers' });
      assert.equal(p.status, 503);
      assert.equal(p.code, 'emergency_blocked');
      assert.equal(p.detail, 'Transfers are paused.');
      assert.equal(p.instance, '/transfers');
      assert.equal(p.policyRevision, 4);
      assert.equal(p.retryable, true);
      return true;
    });
    // Default operation is write.
    await assert.rejects(guard.enforce({ featureKey: 'wallet.transfer' }), EmergencyBlockedError);
  });

  it('every non-ALLOW action except READ_ONLY-for-reads refuses', async () => {
    const { api, guard } = await setup();
    const actions = ['BLOCK', 'REQUIRE_UPDATE', 'SHOW_MAINTENANCE', 'DISABLE_FEATURE', 'USE_SAFE_FALLBACK'];
    api.serve(signed({ revision: 2, policies: actions.map((action, i) => policy({ policy_id: `p${i}`, key: `f.${action.toLowerCase()}`, action, fallback: 'cached' })) }));
    await guard.refresh();
    for (const action of actions) {
      for (const operation of ['read', 'write'] as const) {
        await assert.rejects(guard.enforce({ featureKey: `f.${action.toLowerCase()}`, operation }), (e: unknown) => e instanceof EmergencyBlockedError && e.action === action);
      }
    }
    assert.equal((await guard.enforce({ featureKey: 'f.other' })).action, 'ALLOW');
  });

  it('strong: a conditional fetch (304) confirms the cache', async () => {
    const { api, guard } = await setup({ refreshIntervalMs: 60_000 });
    api.serve(signed({ revision: 1, policies: [] }));
    await guard.start();
    const d = await guard.enforce({ featureKey: 'checkout.confirm_order', consistency: 'strong', subject: 'u1' });
    assert.equal(d.allowed, true);
    assert.equal(api.policyGets.length, 2);
    assert.ok(api.policyGets[1]!.headers['if-none-match']);
  });

  it('strong: sees a block activated since the last refresh, before the next interval', async () => {
    const { api, guard } = await setup({ refreshIntervalMs: 60_000 });
    api.serve(signed({ revision: 1, policies: [] }));
    await guard.start();
    api.serve(blockCheckout(2));
    // Cached is still the old document...
    assert.equal((await guard.enforce({ featureKey: 'checkout.confirm_order' })).allowed, true);
    // ...strong is not.
    await assert.rejects(guard.enforce({ featureKey: 'checkout.confirm_order', consistency: 'strong' }), (e: unknown) => e instanceof EmergencyBlockedError && e.reasonCode === 'PRICING_SAFETY' && e.documentRevision === 2);
  });

  it('strong timeout: FAIL_CLOSED refuses with POLICY_UNAVAILABLE, FAIL_OPEN keeps the cached decision', async () => {
    const { api, guard } = await setup({ refreshIntervalMs: 60_000, strongTimeoutMs: 100, requestTimeoutMs: 5000, failureModes: { 'checkout.*': 'FAIL_CLOSED' } });
    api.serve(signed({ revision: 1, policies: [policy({ key: 'search.*', action: 'BLOCK' })] }));
    await guard.start();
    api.sticky = { hang: true };
    const t = Date.now();
    await assert.rejects(guard.enforce({ featureKey: 'checkout.confirm_order', consistency: 'strong' }), (e: unknown) => {
      return e instanceof EmergencyBlockedError && e.reasonCode === 'POLICY_UNAVAILABLE' && e.decision.source === 'failure_mode' && e.documentRevision === 1;
    });
    assert.ok(Date.now() - t < 1000);
    // FAIL_OPEN: the cached (usable) decision stands.
    assert.equal((await guard.enforce({ featureKey: 'profile.update', consistency: 'strong', timeoutMs: 50 })).allowed, true);
    // A cached restriction is never loosened by a failed strong check.
    await assert.rejects(guard.enforce({ featureKey: 'search.query', consistency: 'strong', timeoutMs: 50 }), (e: unknown) => e instanceof EmergencyBlockedError && e.reasonCode === 'PRICING_SAFETY');
    // Cached consistency is unaffected by the hanging API.
    assert.equal((await guard.enforce({ featureKey: 'checkout.confirm_order' })).allowed, true);
  });

  it('strong: concurrent checks share fetches; each waits for one that started after it', async () => {
    const { api, guard } = await setup({ refreshIntervalMs: 60_000 });
    api.serve(signed({ revision: 1, policies: [] }));
    await guard.refresh();
    api.delayMs = 40;
    // The first check starts a fetch; the nine after it share one follow-up that started after them.
    await Promise.all(Array.from({ length: 10 }, () => guard.enforce({ featureKey: 'checkout.confirm_order', consistency: 'strong' })));
    assert.equal(api.policyGets.length, 3);
    // A fetch already in flight started before these checks: one follow-up fetch serves all ten.
    const inflight = guard.refresh();
    await delay(5);
    await Promise.all(Array.from({ length: 10 }, () => guard.enforce({ featureKey: 'checkout.confirm_order', consistency: 'strong' })));
    await inflight;
    assert.equal(api.policyGets.length, 5);
  });

  it('strongMaxStalenessMs lets strong checks reuse a recent confirmation', async () => {
    const { api, guard, clock } = await setup({ refreshIntervalMs: 60_000, strongMaxStalenessMs: 1000 });
    api.serve(signed({ revision: 1, policies: [] }));
    await guard.refresh();
    await guard.enforce({ featureKey: 'checkout.confirm_order', consistency: 'strong' });
    assert.equal(api.policyGets.length, 1);
    clock.now += 1001;
    await guard.enforce({ featureKey: 'checkout.confirm_order', consistency: 'strong' });
    assert.equal(api.policyGets.length, 2);
  });
});

describe('credential refusal (§3)', () => {
  for (const status of [401, 403, 404]) {
    it(`HTTP ${status}: stops scheduled fetches, keeps the cache, logs once`, async () => {
      const { api, guard, log } = await setup({ refreshIntervalMs: 1000, failureModes: { 'checkout.*': 'FAIL_CLOSED' } });
      api.serve(blockCheckout(3));
      await guard.start();
      assert.ok(guard.status().nextFetchAt);
      api.sticky = { status };
      assert.deepEqual(await guard.refresh(), { kind: 'credential_rejected', status });
      await guard.refresh();
      const s = guard.status();
      assert.equal(s.credentialRejected, true);
      assert.equal(s.nextFetchAt, null);
      assert.equal(s.state, 'usable');
      assert.equal(guard.evaluate('checkout.confirm_order').reasonCode, 'PRICING_SAFETY');
      assert.equal(log.lines.filter((l) => l.startsWith('error') && l.includes('refused')).length, 1);
      // Strong checks do not hammer the API with a refused credential: failure mode applies.
      const before = api.policyGets.length;
      await assert.rejects(guard.enforce({ featureKey: 'checkout.view_cart', consistency: 'strong' }), (e: unknown) => e instanceof EmergencyBlockedError && e.reasonCode === 'POLICY_UNAVAILABLE');
      assert.equal(api.policyGets.length, before);
      // An explicit refresh that succeeds resumes the schedule.
      api.sticky = null;
      await guard.refresh();
      assert.equal(guard.status().credentialRejected, false);
      assert.ok(guard.status().nextFetchAt);
    });
  }

  it('a refused credential at start: start() resolves and nothing is scheduled', async () => {
    const { guard, api } = await setup({ credential: 'bct_SomeOtherIngestKeyThatIsRefused' });
    await guard.start();
    assert.equal(guard.status().credentialRejected, true);
    assert.equal(guard.status().nextFetchAt, null);
    assert.equal(api.policyGets.length, 1);
  });
});

describe('backoff (§7.2)', () => {
  it('doubles from the interval, caps at 15 min, honours Retry-After, resets on success', async () => {
    let r = 0.5;
    const { api, guard, clock } = await setup({ refreshIntervalMs: 1000, random: () => r });
    api.sticky = { status: 503 };
    await guard.start();
    const next = () => guard.status().nextFetchAt! - clock.now;
    assert.equal(next(), 1000);
    await guard.refresh();
    assert.equal(next(), 2000);
    await guard.refresh();
    assert.equal(next(), 4000);
    for (let i = 0; i < 12; i++) await guard.refresh();
    assert.equal(guard.status().consecutiveFailures, 15);
    assert.equal(next(), 900_000);
    r = 0;
    await guard.refresh();
    assert.equal(next(), 720_000);
    r = 0.999999;
    await guard.refresh();
    assert.ok(next() > 1_079_000 && next() <= 1_080_000);
    api.sticky = null;
    api.serve(blockCheckout(1));
    await guard.refresh();
    assert.equal(guard.status().consecutiveFailures, 0);
    assert.equal(next(), 1000);
  });

  it('Retry-After raises the delay (seconds, clamped to a day)', async () => {
    const { api, guard, clock } = await setup({ refreshIntervalMs: 1000 });
    await guard.start();
    api.overrides.push({ status: 429, headers: { 'retry-after': '120' } });
    await guard.refresh();
    assert.equal(guard.status().nextFetchAt! - clock.now, 120_000);
    api.overrides.push({ status: 503, headers: { 'retry-after': '999999' } });
    await guard.refresh();
    assert.equal(guard.status().nextFetchAt! - clock.now, 86_400_000);
    // A failure without Retry-After goes back to plain backoff.
    api.overrides.push({ status: 503 });
    await guard.refresh();
    assert.ok(guard.status().nextFetchAt! - clock.now < 86_400_000);
  });

  it('refreshes on the interval while running and stops on stop()', async () => {
    const { api, guard } = await setup({ refreshIntervalMs: 1000 });
    api.serve(blockCheckout(1));
    await guard.start();
    await until(() => api.policyGets.length >= 2, 3000);
    guard.stop();
    const n = api.policyGets.length;
    await delay(1200);
    assert.equal(api.policyGets.length, n);
    assert.equal(guard.status().running, false);
    assert.equal(guard.evaluate('checkout.confirm_order').action, 'BLOCK');
  });
});

describe('persistent cache (§5, §7.1)', () => {
  function tmpFile(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'bc-guard-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, 'nested', 'policy.json');
  }

  it('survives a restart, is re-verified, and keeps the anti-replay revision', async () => {
    const cacheFile = tmpFile();
    const a = await setup({ cacheFile });
    a.api.serve(blockCheckout(7));
    await a.guard.refresh();
    await a.guard.flush();
    assert.equal(statSync(cacheFile).mode & 0o777, 0o600);
    assert.ok(!readFileSync(cacheFile, 'utf8').includes(INGEST_KEY));

    // Restart while BugCapsule is down: the cached document is in force immediately.
    a.api.sticky = { status: 503 };
    const b = await setup({ cacheFile }, a.api);
    const changes: GuardChange[] = [];
    b.guard.onChange((c) => changes.push(c));
    await b.guard.start();
    assert.equal(b.guard.status().revision, 7);
    assert.equal(b.guard.evaluate('checkout.confirm_order').action, 'BLOCK');
    assert.deepEqual(changes.map((c) => c.reason), ['loaded']);

    // A replayed older document is still refused after the restart.
    a.api.sticky = null;
    a.api.serve(signed({ revision: 6, policies: [] }));
    assert.deepEqual(await b.guard.refresh(), { kind: 'rejected', reason: 'stale_revision' });
  });

  it('discards the cache after an anchor change, and ignores a corrupt file', async () => {
    const cacheFile = tmpFile();
    const a = await setup({ cacheFile });
    a.api.serve(blockCheckout(7));
    await a.guard.refresh();
    await a.guard.flush();
    a.api.sticky = { status: 503 };
    const rotated = makeKey('ek_new');
    const b = await setup({ cacheFile, trustAnchor: makeAnchor(APP_ID, [rotated]) }, a.api);
    await b.guard.start();
    assert.equal(b.guard.status().state, 'none');

    writeFileSync(cacheFile, '{not json');
    const c = await setup({ cacheFile }, a.api);
    await c.guard.start();
    assert.equal(c.guard.status().state, 'none');
    assert.ok(c.log.lines.some((l) => l.includes('not JSON')));
  });

  it('a tampered cache file is not trusted', async () => {
    const cacheFile = tmpFile();
    const a = await setup({ cacheFile });
    a.api.serve(blockCheckout(7));
    await a.guard.refresh();
    await a.guard.flush();
    const file = JSON.parse(readFileSync(cacheFile, 'utf8')) as { envelope: Envelope };
    file.envelope.payload = Buffer.from(JSON.stringify(document({ revision: 7, policies: [] }))).toString('base64url');
    writeFileSync(cacheFile, JSON.stringify(file));
    a.api.sticky = { status: 503 };
    const b = await setup({ cacheFile }, a.api);
    await b.guard.start();
    assert.equal(b.guard.status().state, 'none');
  });
});

describe('observation and hygiene', () => {
  it('onChange: listeners that throw are isolated; unsubscribe works; expiry is announced', async () => {
    const { api, guard, clock, log } = await setup();
    const seen: string[] = [];
    guard.onChange(() => {
      throw new Error('listener bug');
    });
    const off = guard.onChange((c) => seen.push(`${c.reason}:${c.revision}`));
    api.serve(signed({ revision: 1, expires_at: new Date(T0 - 299_950).toISOString(), policies: [] }));
    await guard.start();
    assert.deepEqual(seen, ['fetched:1']);
    assert.ok(log.lines.some((l) => l.includes('listener threw')));
    // The document stops being usable ~50 ms later (real timer, injected clock).
    clock.now = T0 + 60;
    await until(() => seen.length === 2);
    assert.deepEqual(seen, ['fetched:1', 'expired:1']);
    off();
    api.serve(signed({ revision: 2, policies: [] }));
    await guard.refresh();
    assert.equal(seen.length, 2);
  });

  it('never logs the credential', async () => {
    const token = `bcsdk.v1.${Buffer.from(JSON.stringify({ api: 'http://127.0.0.1:1', key: INGEST_KEY })).toString('base64url')}`;
    const { api, guard, log } = await setup({ credential: token, apiUrl: undefined, requestTimeoutMs: 200 });
    await guard.refresh(); // connection refused on port 1
    const g2 = await setup({ credential: token }, api);
    api.overrides.push({ status: 401 }, { status: 200, body: '[]' });
    await g2.guard.refresh();
    await g2.guard.refresh();
    const all = [...log.lines, ...g2.log.lines, JSON.stringify(guard.status()), JSON.stringify(g2.guard.status())].join('\n');
    assert.ok(all.length > 0);
    assert.ok(!all.includes(INGEST_KEY));
    assert.ok(!all.includes(token));
  });

  it('never keeps the process alive', async () => {
    const api = await new FakeBugCapsule().start();
    cleanups.push(() => api.close());
    api.serve(blockCheckout(1));
    const guardSrc = fileURLToPath(new URL('../../../packages/emergency-guard/src/index.ts', import.meta.url));
    const script = `
      import { createEmergencyGuard } from ${JSON.stringify(guardSrc)};
      const g = createEmergencyGuard({ apiUrl: ${JSON.stringify(api.url)}, credential: ${JSON.stringify(INGEST_KEY)}, trustAnchor: ${JSON.stringify(ANCHOR)}, environment: 'production', refreshIntervalMs: 1000, now: () => ${T0} });
      await g.start();
      if (g.status().revision !== 1) process.exit(3);
      console.log('started');
    `;
    const started = Date.now();
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
      const kill = setTimeout(() => child.kill('SIGKILL'), 8000);
      child.on('exit', (c) => {
        clearTimeout(kill);
        resolve(c);
      });
    });
    assert.equal(code, 0);
    assert.ok(Date.now() - started < 8000);
  });
});
