import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  compareVersions,
  evaluateDocument,
  parseTrustAnchor,
  parseVersion,
  rolloutBucket,
  verifyEnvelope,
  versionTargeted,
  type Decision,
  type DocumentPolicy,
  type Platform,
  type VersionRange,
} from '../../../packages/emergency-guard/src/index.js';
import { fixture } from './helpers.js';

/** Shared vectors (spec-fixtures/emergency-v1, §9): every case must pass. */

const here = path.dirname(fileURLToPath(import.meta.url));
const vendored = path.join(here, '..', '..', '..', 'spec-fixtures', 'emergency-v1');
const upstream = path.join(here, '..', '..', '..', '..', 'bug_capsule_flutter_sdk', 'spec', 'fixtures', 'emergency-v1');

describe('vendored emergency-v1 fixtures', () => {
  it('match bug_capsule_flutter_sdk/spec/fixtures/emergency-v1', { skip: !existsSync(upstream) && 'upstream checkout (with emergency-v1) not found' }, () => {
    const ours = readdirSync(vendored).sort();
    assert.deepEqual(ours, readdirSync(upstream).sort());
    for (const f of ours) assert.equal(readFileSync(path.join(vendored, f), 'utf8'), readFileSync(path.join(upstream, f), 'utf8'), `${f} differs`);
  });
});

describe('emergency-v1 vectors: versions.json', () => {
  const v = fixture<{
    compare: { a: string; b: string; result: number }[];
    invalid: { version: string; result: null }[];
    targeted: { version: string | null; ranges: VersionRange[]; expected: boolean }[];
  }>('versions.json');
  for (const c of v.compare) {
    it(`compare ${JSON.stringify(c.a)} vs ${JSON.stringify(c.b)} = ${c.result}`, () => {
      assert.equal(compareVersions(c.a, c.b), c.result);
      assert.equal(compareVersions(c.b, c.a), c.result === 0 ? 0 : -c.result);
    });
  }
  for (const c of v.invalid) {
    it(`invalid ${JSON.stringify(c.version)}`, () => {
      assert.equal(parseVersion(c.version), null);
      assert.equal(compareVersions(c.version, '1.0.0'), c.result);
      assert.equal(compareVersions('1.0.0', c.version), c.result);
    });
  }
  for (const c of v.targeted) {
    it(`targeted ${JSON.stringify(c.version)} in ${JSON.stringify(c.ranges)} = ${c.expected}`, () => {
      assert.equal(versionTargeted(c.version, c.ranges), c.expected);
    });
  }
});

describe('emergency-v1 vectors: rollout.json', () => {
  const v = fixture<{ cases: { seed: string; subject: string; bucket: number }[] }>('rollout.json');
  for (const c of v.cases) {
    it(`bucket(${JSON.stringify(c.seed)}, ${JSON.stringify(c.subject)}) = ${c.bucket}`, () => {
      assert.equal(rolloutBucket(c.seed, c.subject), c.bucket);
    });
  }
});

describe('emergency-v1 vectors: evaluation.json', () => {
  const v = fixture<{
    documents: Record<string, { revision: number; policies: DocumentPolicy[] }>;
    cases: {
      document: string;
      feature_key: string;
      context: { platform: Platform; app_version: string | null; subject: string | null; now: string };
      expected: Record<string, unknown>;
    }[];
  }>('evaluation.json');
  const snake = (d: Decision): Record<string, unknown> => ({
    feature_key: d.featureKey,
    allowed: d.allowed,
    action: d.action,
    reason_code: d.reasonCode,
    policy_id: d.policyId,
    policy_revision: d.policyRevision,
    document_revision: d.documentRevision,
    public_user_message: d.publicUserMessage,
    required_version: d.requiredVersion,
    fallback: d.fallback,
    fallback_available: d.fallbackAvailable,
  });
  v.cases.forEach((c, i) => {
    it(`#${i} ${c.document} / ${c.feature_key} / ${c.context.platform} ${c.context.app_version} ${c.context.subject} → ${String(c.expected.action)}`, () => {
      const doc = v.documents[c.document]!;
      const d = evaluateDocument(doc, c.feature_key, {
        platform: c.context.platform,
        appVersion: c.context.app_version,
        subject: c.context.subject,
        now: Date.parse(c.context.now),
      });
      assert.deepEqual(snake(d), c.expected);
      assert.equal(d.source, 'policy');
    });
  });
});

describe('emergency-v1 vectors: envelopes.json', () => {
  const v = fixture<{
    application_id: string;
    environment: string;
    anchor: string;
    anchor_rotated: string;
    cases: { name: string; envelope: unknown; expected: string; revision?: number }[];
  }>('envelopes.json');
  const anchor = parseTrustAnchor(v.anchor);
  const rotated = parseTrustAnchor(v.anchor_rotated);

  it('anchors carry the fixture application', () => {
    assert.equal(anchor.app, v.application_id);
    assert.equal(rotated.app, v.application_id);
    assert.equal(anchor.keys.size, 1);
    assert.equal(rotated.keys.size, 2);
  });

  for (const c of v.cases) {
    it(`${c.name} → ${c.expected}`, () => {
      const r = verifyEnvelope(c.envelope, anchor, v.environment);
      if (c.expected === 'ok') {
        assert.equal(r.ok, true, r.ok ? '' : r.reason);
        if (r.ok && c.revision !== undefined) assert.equal(r.document.revision, c.revision);
      } else {
        assert.deepEqual(r, { ok: false, reason: c.expected });
      }
    });
  }

  it('valid_second_key is ok with anchor_rotated', () => {
    const c = v.cases.find((x) => x.name === 'valid_second_key')!;
    const r = verifyEnvelope(c.envelope, rotated, v.environment);
    assert.equal(r.ok, true, r.ok ? '' : r.reason);
    if (r.ok && c.revision !== undefined) assert.equal(r.document.revision, c.revision);
  });

  it('every case verifies the same way under anchor_rotated, except valid_second_key', () => {
    for (const c of v.cases) {
      if (c.name === 'valid_second_key') continue;
      const r = verifyEnvelope(c.envelope, rotated, v.environment);
      assert.equal(r.ok ? 'ok' : r.reason, c.expected, c.name);
    }
  });
});
