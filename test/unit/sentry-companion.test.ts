import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { BugCapsule } from '../../packages/web/src/bugcapsule.js';
import { capsuleFromJson } from '../../packages/web/src/core/codec.js';
import { validateCapsuleDocument } from '../../packages/web/src/core/validator.js';
import { sentryCompanion, type SentryClientLike, type SentryEventLike } from '../../packages/web/src/integrations/sentry.js';
import type { Envelope, EventPayload } from '../../packages/web/src/monitoring/types.js';
import { parseRemoteConfig, type BugCapsuleTransport } from '../../packages/web/src/remote-config.js';
import { MemoryStorage } from '../../packages/web/src/storage/idb.js';
import type { BugCapsuleConfig, UploadResult } from '../../packages/web/src/types.js';

class Transport implements BugCapsuleTransport {
  envelopes: Envelope[] = [];
  capsules: Record<string, any>[] = [];
  async fetchConfig() {
    return { ok: true as const, config: parseRemoteConfig({ enabled: true, sampleRate: 1 }, Date.now()) };
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

afterEach(async () => {
  await BugCapsule.resetForTest();
  BugCapsule.setTestOverrides(undefined);
});

async function init(transport: Transport, config: Partial<BugCapsuleConfig> = {}, random = 0.01) {
  BugCapsule.setTestOverrides({ storage: new MemoryStorage(), transport, random: () => random, bridge: null });
  await BugCapsule.init({ appVersion: '1.0.0', appBuild: '7', mode: 'qa', gitSha: 'abc', consoleBreadcrumbs: false, ...config });
}

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const client: SentryClientLike = { getDsn: () => ({ projectId: '4567', host: 'o123.ingest.us.sentry.io' }) };
let n = 0;
/** A Sentry error event like `@sentry/browser` builds for `error`. */
function sentryEvent(error: unknown, extra: Partial<SentryEventLike> = {}): SentryEventLike {
  n++;
  const e = error as { name?: string; message?: string };
  return {
    event_id: n.toString(16).padStart(32, 'a'),
    level: 'error',
    release: 'shop@1.0.0+7',
    environment: 'staging',
    exception: { values: [{ type: e?.name ?? 'Error', value: e?.message ?? String(error) }] },
    tags: { user_tag: 'kept' },
    contexts: { os: { name: 'macOS' } },
    ...extra,
  };
}

const failures = (capsule: Record<string, any>) => capsule.events.filter((e: { type: string }) => e.type === 'failure');

describe('sentryCompanion', () => {
  it('is a Sentry integration object', () => {
    const i = sentryCompanion();
    assert.equal(i.name, 'BugCapsule');
    assert.equal(typeof i.setupOnce, 'function');
    assert.equal(typeof i.setup, 'function');
    assert.equal(typeof i.processEvent, 'function');
  });

  it('without BugCapsule: tags capture=disabled and returns the same event', () => {
    const event = sentryEvent(new Error('x'));
    const out = sentryCompanion().processEvent(event, { originalException: new Error('x') }, client);
    assert.equal(out, event);
    assert.deepEqual(out.tags, { user_tag: 'kept', 'bugcapsule.capture': 'disabled' });
    assert.deepEqual(out.contexts, { os: { name: 'macOS' }, bugcapsule: { capsule_id: null, capture: 'disabled' } });
  });

  it('leaves transactions and other typed events alone', async () => {
    await init(new Transport());
    const tx = { type: 'transaction', event_id: 'b'.repeat(32), tags: { a: 1 } };
    const before = structuredClone(tx);
    assert.deepEqual(sentryCompanion().processEvent(tx, {}, client), before);
    const info = { level: 'info', event_id: 'c'.repeat(32) };
    assert.deepEqual(sentryCompanion().processEvent(info, {}, client), { level: 'info', event_id: 'c'.repeat(32) });
  });

  it('a caught error only Sentry saw: capsule scheduled, linked both ways, no BugCapsule monitoring event', async () => {
    const t = new Transport();
    await init(t);
    const err = new TypeError('price is null');
    const event = sentryEvent(err);
    const out = sentryCompanion().processEvent(event, { originalException: err }, client);
    const capsuleId = out.tags!['bugcapsule.capsule_id'] as string;
    assert.match(capsuleId, /^[0-9a-f-]{36}$/);
    assert.equal(out.tags!['bugcapsule.capture'], 'scheduled');
    assert.deepEqual(out.contexts!.bugcapsule, { capsule_id: capsuleId, capture: 'scheduled' });
    assert.equal(out.tags!.user_tag, 'kept');

    await until(() => t.capsules.length === 1);
    await BugCapsule.flush(1000);
    const m = t.capsules[0]!.manifest;
    assert.equal(m.capsuleId, capsuleId);
    assert.deepEqual(m.links, { sentry: { eventId: event.event_id, projectId: '4567', orgId: '123', release: 'shop@1.0.0+7', environment: 'staging' } });
    assert.equal(m.failure.signature, 'exception:TypeError:price is null');
    assert.equal(t.events().length, 0, 'Sentry is the monitoring tool for this error');
    assert.equal(validateCapsuleDocument(t.capsules[0]), null);
  });

  it('BugCapsule saw the error first: the Sentry event reuses its capsule id', async () => {
    const t = new Transport();
    await init(t);
    const err = new Error('boom 1');
    BugCapsule.reportError(err);
    const out = sentryCompanion().processEvent(sentryEvent(err), { originalException: err }, client);
    await until(() => t.capsules.length === 1);
    await BugCapsule.flush(1000);
    assert.equal(out.tags!['bugcapsule.capsule_id'], t.capsules[0]!.manifest.capsuleId);
    assert.equal(t.capsules[0]!.manifest.links.sentry.eventId, out.event_id);
    assert.equal(failures(t.capsules[0]!).length, 1);
    assert.equal(t.events().length, 1);
    assert.equal(t.events()[0]!.capsuleId, t.capsules[0]!.manifest.capsuleId);
  });

  it('Sentry saw the error first: BugCapsule does not record it again (its monitoring event is still sent once)', async () => {
    const t = new Transport();
    await init(t);
    const err = new Error('boom 2');
    const out = sentryCompanion().processEvent(sentryEvent(err), { originalException: err }, client);
    BugCapsule.reportError(err);
    BugCapsule.reportError(err);
    await until(() => t.capsules.length === 1);
    await sleep(400);
    await BugCapsule.flush(1000);
    assert.equal(t.capsules.length, 1);
    assert.equal(failures(t.capsules[0]!).length, 1);
    assert.equal(out.tags!['bugcapsule.capsule_id'], t.capsules[0]!.manifest.capsuleId);
    assert.deepEqual(t.events().map((e) => e.capsuleId), [t.capsules[0]!.manifest.capsuleId]);
  });

  it('a second Sentry event for the same error or the same failure is a duplicate (one link per capsule)', async () => {
    const t = new Transport();
    await init(t);
    const companion = sentryCompanion();
    const err = new Error('boom 3');
    const first = companion.processEvent(sentryEvent(err), { originalException: err }, client);
    const again = companion.processEvent(sentryEvent(err), { originalException: err }, client);
    const sameSignature = companion.processEvent(sentryEvent(new Error('boom 4')), { originalException: new Error('boom 4') }, client);
    assert.equal(first.tags!['bugcapsule.capture'], 'scheduled');
    for (const e of [again, sameSignature]) {
      assert.equal(e.tags!['bugcapsule.capture'], 'duplicate');
      assert.equal(e.tags!['bugcapsule.capsule_id'], undefined);
      assert.deepEqual(e.contexts!.bugcapsule, { capsule_id: null, capture: 'duplicate' });
    }
    await until(() => t.capsules.length === 1);
    await sleep(400);
    assert.equal(t.capsules.length, 1);
    assert.equal(t.capsules[0]!.manifest.links.sentry.eventId, first.event_id);
  });

  it('primitive thrown values are matched by signature', async () => {
    const t = new Transport();
    await init(t);
    const out = sentryCompanion().processEvent(sentryEvent('plain string'), { originalException: 'plain string' }, client);
    BugCapsule.reportError('plain string');
    await until(() => t.capsules.length === 1);
    await sleep(400);
    assert.equal(t.capsules.length, 1);
    assert.equal(failures(t.capsules[0]!).length, 1);
    assert.equal(out.tags!['bugcapsule.capsule_id'], t.capsules[0]!.manifest.capsuleId);
  });

  it('events without originalException use the exception values', async () => {
    const t = new Transport();
    await init(t);
    const out = sentryCompanion().processEvent(sentryEvent(null, { exception: { values: [{ type: 'RangeError', value: 'bad 7' }] } }), {}, client);
    assert.equal(out.tags!['bugcapsule.capture'], 'scheduled');
    await until(() => t.capsules.length === 1);
    assert.equal(t.capsules[0]!.manifest.failure.signature, 'exception:RangeError:bad #');
  });

  it('reasons: sampled_out, disabled, limit, not_a_failure', async () => {
    const tag = (e: SentryEventLike) => e.tags!['bugcapsule.capture'];
    const run = (err: unknown) => sentryCompanion().processEvent(sentryEvent(err), { originalException: err }, client);

    await init(new Transport(), { mode: 'production' }, 0.99);
    assert.equal(tag(run(new Error('a'))), 'sampled_out');
    await BugCapsule.resetForTest();

    await init(new Transport(), { enabled: false });
    assert.equal(tag(run(new Error('a'))), 'disabled');
    await BugCapsule.resetForTest();

    await init(new Transport(), { autoCaptureOnFailure: false });
    assert.equal(tag(run(new Error('a'))), 'disabled');
    await BugCapsule.resetForTest();

    const t = new Transport();
    await init(t, { maxCapsulesPerSession: 0 });
    assert.equal(tag(run(new Error('a'))), 'limit');
    await BugCapsule.resetForTest();

    await init(new Transport(), { ignoreError: (e) => (e as Error).message === 'ignored' });
    assert.equal(tag(run(new Error('ignored'))), 'not_a_failure');
    const message = sentryCompanion().processEvent({ event_id: 'd'.repeat(32), level: 'error' }, {}, client);
    assert.equal(tag(message), 'not_a_failure');
    assert.deepEqual(message.contexts, { bugcapsule: { capsule_id: null, capture: 'not_a_failure' } });
    assert.equal(t.capsules.length, 0);
  });

  it('during replay: no capsule or link, the replay engine sees the failure once', async () => {
    await init(new Transport());
    const seen: string[] = [];
    const rt = BugCapsule.session as unknown as { engine: unknown };
    rt.engine = { onFailure: (f: { signature: string }) => seen.push(f.signature) };
    try {
      const err = new Error('in replay');
      const out = sentryCompanion().processEvent(sentryEvent(err), { originalException: err }, client);
      BugCapsule.reportError(err);
      assert.equal(out.tags!['bugcapsule.capture'], 'replaying');
      assert.equal(out.tags!['bugcapsule.capsule_id'], undefined);
      assert.deepEqual(seen, ['exception:Error:in replay']);
    } finally {
      rt.engine = null;
    }
  });

  it('an internal error returns the event unchanged', async () => {
    await init(new Transport());
    (BugCapsule.session as unknown as { sentryEvent: () => never }).sentryEvent = () => {
      throw new Error('companion bug');
    };
    const event = sentryEvent(new Error('x'));
    const before = structuredClone(event);
    const out = sentryCompanion().processEvent(event, { originalException: new Error('x') }, client);
    assert.equal(out, event);
    assert.deepEqual(out, before);
  });

  it('an unusable event id: capsule still scheduled and tagged, but not linked', async () => {
    const t = new Transport();
    await init(t);
    const err = new Error('no id');
    const out = sentryCompanion().processEvent(sentryEvent(err, { event_id: 'NOT-HEX' }), { originalException: err }, client);
    assert.equal(out.tags!['bugcapsule.capture'], 'scheduled');
    await until(() => t.capsules.length === 1);
    assert.equal(t.capsules[0]!.manifest.links, undefined);
  });

  it('DSN ids from options when getDsn is missing; no orgId for hosts without o<digits>', async () => {
    const t = new Transport();
    await init(t);
    const a = new Error('dsn a');
    const b = new Error('dsn b');
    sentryCompanion().processEvent(sentryEvent(a), { originalException: a }, { getOptions: () => ({ dsn: 'https://key@o42.ingest.sentry.io/99' }) });
    sentryCompanion().processEvent(sentryEvent(b, { release: undefined }), { originalException: b }, { getDsn: () => ({ projectId: '7', host: 'sentry.example.com' }) });
    await until(() => t.capsules.length === 2);
    const links = t.capsules.map((c) => c.manifest.links.sentry).sort((x, y) => x.projectId.localeCompare(y.projectId));
    assert.deepEqual(links.map(({ projectId, orgId, release }) => [projectId, orgId, release]), [
      ['7', undefined, null],
      ['99', '42', 'shop@1.0.0+7'],
    ]);
  });

  it('tag keys and values stay within Sentry limits', async () => {
    await init(new Transport());
    const err = new Error('limits');
    const out = sentryCompanion().processEvent(sentryEvent(err), { originalException: err }, client);
    for (const k of ['bugcapsule.capsule_id', 'bugcapsule.capture']) {
      assert.ok(k.length <= 32);
      assert.ok(String(out.tags![k]).length <= 200);
    }
  });
});

describe('manifest.links.sentry validation', () => {
  const base = () => {
    const doc: Record<string, any> = {
      format: 'bugcapsule.capsule',
      specVersion: 1,
      manifest: {
        capsuleId: 'c1',
        createdAt: '2026-10-23T10:00:00Z',
        mode: 'qa',
        app: { version: '1', build: '1' },
        platform: { os: 'web' },
        session: { id: 's', startedAt: '2026-10-23T10:00:00Z', wallClockAtAnchorMs: 0, seed: 1, durationMs: 0 },
        eligibility: { status: 'eligible', missing: [] },
        links: { sentry: { eventId: 'a'.repeat(32), projectId: '4567', orgId: '123', release: 'r', environment: null } },
      },
      checkpoint: { kind: 'launch', t: 0, wallClockMs: 0, afterSeq: 0, data: {} },
      events: [],
    };
    return doc;
  };

  it('accepts a valid link and keeps it through JSON decoding', () => {
    const doc = base();
    assert.equal(validateCapsuleDocument(doc), null);
    const decoded = capsuleFromJson(JSON.parse(JSON.stringify(doc)));
    assert.deepEqual(decoded.manifest.links, doc.manifest.links);
  });

  it('rejects a bad eventId and over-long strings', () => {
    for (const eventId of ['A'.repeat(32), 'a'.repeat(31), '', 42, undefined]) {
      const doc = base();
      doc.manifest.links.sentry.eventId = eventId;
      assert.equal(validateCapsuleDocument(doc), '$.manifest.links.sentry.eventId must be 32 lowercase hex characters');
    }
    const doc = base();
    doc.manifest.links.sentry.release = 'x'.repeat(201);
    assert.equal(validateCapsuleDocument(doc), '$.manifest.links.sentry.release must be at most 200 characters');
    const other = base();
    other.manifest.links = { other: { anything: true } };
    assert.equal(validateCapsuleDocument(other), null, 'other links are not validated');
  });
});
