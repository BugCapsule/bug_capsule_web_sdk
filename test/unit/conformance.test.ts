import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  CapsuleFormatError,
  DependencyStats,
  EndpointRule,
  InteractionScript,
  PayloadBudget,
  PayloadEncoder,
  Redactor,
  RequestKeyBuilder,
  TypedValue,
  VERDICT_WIRE,
  DEFAULT_INTERACTION_LIMITS,
  EXPECTED_DIVERGENCES,
  canonicalJson,
  capsuleToJson,
  decodeCapsule,
  evaluateRun,
  failureSignature,
  fnvHash,
  interactionKey,
  isObject,
  parseUri,
  payloadToJson,
  queryParametersAll,
  validateCapsuleDocument,
  type CapsuleEvent,
  type FailureKind,
  type RecordedInteraction,
  type ReplayReport,
  type RunKind,
} from '../../packages/web/src/core/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const vendored = path.join(here, '..', '..', 'spec-fixtures');
const upstream = path.join(here, '..', '..', '..', 'bug_capsule_flutter_sdk', 'spec', 'fixtures');
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const gz = (doc: unknown) => new Uint8Array(gzipSync(Buffer.from(JSON.stringify(doc))));

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
    .sort();
}

describe('vendored spec fixtures', () => {
  it('match bug_capsule_flutter_sdk/spec/fixtures', { skip: !existsSync(upstream) && 'upstream checkout not found' }, () => {
    for (const sub of ['capsule-v1', 'capsule-v2', 'conformance']) {
      const ours = listFiles(path.join(vendored, sub));
      assert.deepEqual(ours, listFiles(path.join(upstream, sub)), `${sub}: run bug_capsule_flutter_sdk/tool/sync_spec.sh`);
      for (const f of ours) {
        assert.equal(readFileSync(path.join(vendored, sub, f), 'utf8'), readFileSync(path.join(upstream, sub, f), 'utf8'), `${sub}/${f} differs`);
      }
    }
  });
});

for (const spec of ['capsule-v1', 'capsule-v2'] as const) describe(`${spec} fixtures`, () => {
  for (const kind of ['valid', 'invalid'] as const) {
    for (const name of readdirSync(path.join(vendored, spec, kind)).filter((f) => f.endsWith('.json')).sort()) {
      const fixture = json(path.join(vendored, spec, kind, name));
      it(`${kind}/${name}`, async () => {
        if (kind === 'valid') {
          assert.equal(validateCapsuleDocument(fixture.document), null);
          const capsule = await decodeCapsule(gz(fixture.document));
          assert.equal(capsule.specVersion, fixture.document.specVersion);
          assert.equal(capsule.manifest.capsuleId, fixture.document.manifest.capsuleId);
          assert.equal(capsule.events.length, fixture.document.events.length);
          assert.deepEqual(capsule.manifest.dependencies ?? [], spec === 'capsule-v2' ? fixture.document.manifest.dependencies : []);
          const reencoded = capsuleToJson(capsule);
          // capsule-v2 §1: written as v2 only with dependencies.
          assert.equal(reencoded.specVersion, (capsule.manifest.dependencies ?? []).length > 0 ? 2 : 1);
          assert.equal(validateCapsuleDocument(reencoded), null, 're-encoded document is valid');
        } else {
          await assert.rejects(decodeCapsule(gz(fixture.document)), (e: unknown) => {
            assert.ok(e instanceof CapsuleFormatError);
            assert.ok(e.message.includes(fixture.errorPath), `expected ${fixture.errorPath} in: ${e.message}`);
            return true;
          });
        }
      });
    }
  }

  if (spec === 'capsule-v2') return;

  it('a v1 document may carry manifest.dependencies; it has no effect', async () => {
    const doc = json(path.join(vendored, 'capsule-v1', 'valid', 'minimal.json')).document;
    doc.manifest.dependencies = 'ignored by v1 readers';
    assert.equal(validateCapsuleDocument(doc), null);
    const capsule = await decodeCapsule(gz(doc));
    assert.equal(capsule.manifest.dependencies, undefined);
    assert.equal(capsuleToJson(capsule).specVersion, 1);
  });

  it('bounded decoding: gzip bombs, value counts, depth, not gzip', async () => {
    const bomb = new Uint8Array(gzipSync(Buffer.alloc(4 * 1024 * 1024, 32)));
    await assert.rejects(decodeCapsule(bomb, { maxDecompressedBytes: 1024 * 1024 }), /exceeds/);
    const tiny = new Uint8Array(gzipSync(Buffer.from(`[${'{},'.repeat(4_100_000)}{}]`)));
    await assert.rejects(decodeCapsule(tiny), /JSON values/);
    await assert.rejects(decodeCapsule(new Uint8Array([1, 2, 3])), /not a gzip/);
    await assert.rejects(decodeCapsule(new Uint8Array([0x1f, 0x8b, 0, 0])), CapsuleFormatError);
    let deep: unknown = 1;
    for (let i = 0; i < 120; i++) deep = [deep];
    const doc = json(path.join(vendored, 'capsule-v1', 'valid', 'minimal.json')).document;
    doc.manifest.labels = undefined;
    doc.checkpoint.data = { x: deep };
    await assert.rejects(decodeCapsule(gz(doc)), /nests deeper/);
  });
});

describe('conformance: request keys', () => {
  const fixture = json(path.join(vendored, 'conformance', 'request-keys.json'));
  for (const c of fixture.cases) {
    it(c.name, () => {
      const builder = new RequestKeyBuilder({
        rules: (c.rules ?? []).map((r: Record<string, unknown>) => new EndpointRule(r as never)),
        ...(c.globalIgnoreQuery ? { globalIgnoreQuery: c.globalIgnoreQuery } : {}),
        globalIgnoreBodyFields: c.globalIgnoreBodyFields ?? [],
      });
      const redactor = new Redactor({ extraKeys: c.redactKeys ?? [] });
      let url: string = c.url;
      let body: unknown = c.body;
      if (c.redact) {
        url = redactor.redactUrl(url);
        if (body !== null) {
          if (typeof body === 'string') {
            try {
              body = JSON.parse(body);
            } catch {
              /* text */
            }
          }
          body = redactor.redactJson(body);
        }
      }
      assert.equal(builder.keyFor(c.method, url, body), c.expectedKey);
    });
  }
});

describe('conformance: signatures', () => {
  for (const c of json(path.join(vendored, 'conformance', 'signatures.json')).cases) {
    it(`${c.kind}:${c.type}:${c.message.slice(0, 30)}`, () => {
      assert.equal(failureSignature(c.kind as FailureKind, c.type, c.message), c.expected);
    });
  }
});

describe('conformance: redaction', () => {
  const f = json(path.join(vendored, 'conformance', 'redaction.json'));
  const r = new Redactor({ extraKeys: f.extraKeys, extraHeaders: f.extraHeaders });
  it('placeholder', () => assert.equal(Redactor.placeholder, f.placeholder));
  for (const k of f.keys) {
    it(`key ${k.key}`, () => {
      assert.equal(r.isSensitiveKey(k.key), k.sensitive);
      assert.equal(r.isSensitiveQueryKey(k.key), k.sensitiveQuery);
    });
  }
  for (const h of f.headers) it(`header ${h.name}`, () => assert.equal(r.isSensitiveHeader(h.name), h.sensitive));
  for (const c of f.scrubText) it(`scrubText ${c.input.slice(0, 40)}`, () => assert.equal(r.scrubText(c.input), c.output));
  for (const c of f.redactUrl) {
    it(`redactUrl ${c.input}`, () => {
      const out = r.redactUrl(c.input);
      assert.equal(out, c.output);
      const params = [...queryParametersAll(parseUri(out)!.query)].flatMap(([k, vs]) => vs.map((v) => [k, v]));
      assert.deepEqual(params, c.params);
    });
  }
  f.redactHeaders.forEach((c: { input: Record<string, unknown>; output: unknown }, i: number) =>
    it(`redactHeaders #${i}`, () => assert.deepEqual(r.redactHeaders(c.input), c.output)),
  );
  f.redactJson.forEach((c: { input: unknown; output: unknown }, i: number) =>
    it(`redactJson #${i}`, () => assert.deepEqual(r.redactJson(c.input), c.output)),
  );
  for (const c of f.redactText) {
    it(`redactText ${c.id}`, () => assert.equal(r.redactText(c.id, c.value, c.sensitive ?? false), c.output));
  }
});

// ------------------------------------------------------------- capsule-v2

/**
 * JS cannot tell `1` from `1.0`: an integral double (`{"$t":"double","v":"80.0"}`)
 * decodes to the number 80 and re-encodes as a plain integer. Everything
 * else must round-trip exactly as the Dart reference does.
 */
function jsView(json: unknown): unknown {
  if (Array.isArray(json)) return json.map(jsView);
  if (!isObject(json)) return json;
  if (json.$t === 'double') {
    const n = Number(json.v);
    if (Number.isFinite(n) && Number.isInteger(n) && !Object.is(n, -0) && Math.abs(n) <= Number.MAX_SAFE_INTEGER) return n;
    return json;
  }
  if (json.$t === 'map') return { $t: 'map', e: (json.e as unknown[][]).map(([k, v]) => [jsView(k), jsView(v)]) };
  if (json.$t !== undefined) return json;
  return Object.fromEntries(Object.entries(json).map(([k, v]) => [k, jsView(v)]));
}

describe('conformance: interactions', () => {
  const f = json(path.join(vendored, 'conformance', 'interactions.json'));

  for (const c of f.typedValues) {
    it(`typed value: ${c.name}`, () => {
      assert.equal(canonicalJson(c.encoded), c.canonical);
      assert.equal(fnvHash(canonicalJson(c.encoded)), c.hash);
      assert.deepEqual(TypedValue.encode(TypedValue.decode(c.encoded)), jsView(c.reencoded));
    });
  }

  it('typed values: JS values encode like their Dart counterparts', () => {
    assert.deepEqual(TypedValue.encode(42), 42);
    assert.deepEqual(TypedValue.encode(12.5), 12.5);
    assert.deepEqual(TypedValue.encode(2 ** 53), { $t: 'double', v: '9007199254740992.0' });
    assert.deepEqual(TypedValue.encode(9007199254740993n), { $t: 'int', v: '9007199254740993' });
    assert.deepEqual(TypedValue.encode(7n), 7);
    assert.deepEqual(TypedValue.encode(NaN), { $t: 'double', v: 'NaN' });
    assert.deepEqual(TypedValue.encode(-0), { $t: 'double', v: '-0.0' });
    assert.deepEqual(TypedValue.encode(-Infinity), { $t: 'double', v: '-Infinity' });
    assert.deepEqual(TypedValue.encode(new Uint8Array([0, 1, 2, 255]).buffer), { $t: 'bytes', b64: 'AAEC/w==' });
    assert.deepEqual(TypedValue.encode(new DataView(new Uint8Array([9, 0, 1, 2]).buffer, 1)), { $t: 'bytes', b64: 'AAEC' });
    assert.deepEqual(TypedValue.encode(new Int32Array([1, -2, 3])), { $t: 'i32', v: [1, -2, 3] });
    assert.deepEqual(TypedValue.encode(new BigInt64Array([1n, -(2n ** 63n)])), { $t: 'i64', v: ['1', '-9223372036854775808'] });
    assert.deepEqual(TypedValue.encode(new Float64Array([1.5, Infinity])), { $t: 'f64', v: [1.5, 'Infinity'] });
    assert.deepEqual(TypedValue.encode(new Uint16Array([1, 2])), [1, 2]);
    assert.deepEqual(TypedValue.encode(new Map<unknown, unknown>([[1, 'one'], ['two', 2]])), { $t: 'map', e: [[1, 'one'], ['two', 2]] });
    assert.deepEqual(TypedValue.encode(new Map([['a', 1]])), { a: 1 });
    assert.deepEqual(TypedValue.encode({ $t: 'x' }), { $t: 'map', e: [['$t', 'x']] });
    assert.deepEqual(TypedValue.encode([undefined, new Date(0)]), [null, { $t: 'unsupported', type: 'Date' }]);
    assert.equal(TypedValue.isReplayable(TypedValue.encode({ when: new Date(0) })), false);
    assert.equal(TypedValue.hasBinary(TypedValue.encode({ a: [new Uint8Array(1)] })), true);
  });

  for (const c of f.keys) {
    it(`key: ${c.key}`, () => assert.equal(interactionKey(c.scope, c.method, c.args), c.key));
  }

  const redactor = new Redactor();
  for (const c of f.payloads) {
    it(`payload: ${c.name}`, () => {
      const encoder = new PayloadEncoder({
        redactor: () => redactor,
        budget: new PayloadBudget({ ...DEFAULT_INTERACTION_LIMITS, maxPayloadBytes: c.maxPayloadBytes ?? 64 * 1024 }),
        stats: new DependencyStats(),
        now: () => 0,
        captureBinary: c.captureBinary ?? false,
        redactedReplayable: c.redactedReplayable ?? false,
      });
      assert.deepEqual(payloadToJson(encoder.encode(TypedValue.decode(c.value), c.kind ?? undefined)), c.payload);
    });
  }

  it('payloads: the rolling budget drops later payloads to metadata', () => {
    const stats = new DependencyStats();
    let now = 0;
    const encoder = new PayloadEncoder({
      redactor: () => redactor,
      budget: new PayloadBudget({ ...DEFAULT_INTERACTION_LIMITS, maxWindowPayloadBytes: 40, windowMs: 1000 }),
      stats,
      now: () => now,
    });
    assert.equal(encoder.encode('x'.repeat(30), 'text').mode, 'full');
    assert.deepEqual(payloadToJson(encoder.encode('y'.repeat(30), 'text')), { mode: 'metadata', replayable: false, bytes: 30, kind: 'text' });
    now = 1500; // the first payload left the window
    assert.equal(encoder.encode('z'.repeat(30), 'text').mode, 'full');
    assert.equal(stats.dropped, 1);
    assert.deepEqual(stats.gaps.map((g) => g.code), ['payload.dropped']);
  });

  // Same driver as `_schedule` in bug_capsule_flutter_sdk/packages/bug_capsule/tool/generate_conformance.dart.
  for (const c of f.schedules) {
    it(`schedule: ${c.name}`, () => {
      let seq = 0;
      const events: CapsuleEvent[] = c.events.map((e: CapsuleEvent) => ({ seq: ++seq, t: e.t, type: e.type, data: e.data }));
      let now = 0;
      const deliveries: { seq: number; at: number }[] = [];
      const script = new InteractionScript(events, { dependencies: new Set<string>(c.deps), clock: () => now, base: c.base });
      const deliver = (r: RecordedInteraction) => deliveries.push({ seq: r.event.seq, at: now });
      const advanceTo = (target: number) => {
        for (;;) {
          const next = script.nextDueAt;
          if (next === null || next > target) break;
          if (next > now) now = next;
          script.pump();
        }
        now = target;
        script.pump();
      };
      const matched: (number | null)[] = [];
      for (const step of c.steps) {
        advanceTo(step.at);
        switch (step.op) {
          case 'runStarted':
            script.runStarted(now);
            break;
          case 'bind':
            script.bind(step.scope, deliver);
            break;
          case 'unbind':
            script.unbind(step.scope);
            break;
          case 'take':
            matched.push(script.take(step.dep, step.type, step.key)?.event.seq ?? null);
            break;
          case 'takeNext':
            matched.push(script.takeNext(step.scope, new Set<string>(step.types))?.event.seq ?? null);
            break;
        }
        script.pump();
      }
      while (script.nextDueAt !== null) advanceTo(script.nextDueAt);
      assert.deepEqual(events, c.events);
      assert.deepEqual(matched, c.matched);
      assert.deepEqual(deliveries, c.deliveries);
      assert.deepEqual(script.unused(c.failureT ?? null).map(([type, detail]) => ({ type, detail })), c.unused);
    });
  }
});

describe('conformance: verdicts', () => {
  const f = json(path.join(vendored, 'conformance', 'verdicts.json'));
  type FixtureReport = {
    outcome: ReplayReport['outcome'];
    expectedSignature?: string;
    eventsDispatched?: number;
    eventsExpected?: number;
    divergences?: string[];
    otherFailures?: string[];
    message?: string;
  };
  const report = (r: FixtureReport): ReplayReport => ({
    outcome: r.outcome,
    attempt: 1,
    durationMs: 100,
    strategy: 'auto',
    expectedSignature: r.expectedSignature ?? null,
    observed: null,
    otherFailures: (r.otherFailures ?? []).map((signature) => ({ kind: 'exception', signature, type: 'E', message: '', t: 0 })),
    divergences: (r.divergences ?? []).map((type) => ({ type, detail: 'x' })),
    eventsDispatched: r.eventsDispatched ?? 0,
    eventsExpected: r.eventsExpected ?? null,
    fixturesServed: 0,
    compressedMs: 0,
    gapsCompressed: 0,
    buildGitSha: null,
    message: r.message ?? null,
  });

  it('expected divergences', () => {
    assert.deepEqual([...EXPECTED_DIVERGENCES].sort(), f.expectedDivergences);
  });
  for (const c of f.cases) {
    it(c.name, () => {
      const e = evaluateRun(c.kind as RunKind, c.requested, c.reports.map(report));
      assert.equal(e.verdict, c.verdict);
      assert.equal(VERDICT_WIRE[e.verdict], c.wire);
      assert.equal(e.exitCode, c.exitCode);
      assert.equal(e.validAttempts, c.validAttempts);
      assert.deepEqual(e.attempts.map((a) => a.status), c.attemptStatuses);
      assert.deepEqual(e.reasonCodes, c.reasonCodes);
    });
  }
});
