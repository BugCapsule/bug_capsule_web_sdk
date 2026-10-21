import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  CapsuleFormatError,
  EndpointRule,
  Redactor,
  RequestKeyBuilder,
  capsuleToJson,
  decodeCapsule,
  failureSignature,
  parseUri,
  queryParametersAll,
  validateCapsuleDocument,
  type FailureKind,
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
    for (const sub of ['capsule-v1', 'conformance']) {
      const ours = listFiles(path.join(vendored, sub));
      assert.deepEqual(ours, listFiles(path.join(upstream, sub)), `${sub}: run bug_capsule_flutter_sdk/tool/sync_spec.sh`);
      for (const f of ours) {
        assert.equal(readFileSync(path.join(vendored, sub, f), 'utf8'), readFileSync(path.join(upstream, sub, f), 'utf8'), `${sub}/${f} differs`);
      }
    }
  });
});

describe('capsule-v1 fixtures', () => {
  for (const kind of ['valid', 'invalid'] as const) {
    for (const name of readdirSync(path.join(vendored, 'capsule-v1', kind)).filter((f) => f.endsWith('.json')).sort()) {
      const fixture = json(path.join(vendored, 'capsule-v1', kind, name));
      it(`${kind}/${name}`, async () => {
        if (kind === 'valid') {
          assert.equal(validateCapsuleDocument(fixture.document), null);
          const capsule = await decodeCapsule(gz(fixture.document));
          assert.equal(capsule.manifest.capsuleId, fixture.document.manifest.capsuleId);
          assert.equal(capsule.events.length, fixture.document.events.length);
          assert.equal(validateCapsuleDocument(capsuleToJson(capsule)), null, 're-encoded document is valid');
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
