import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  InvalidCredentialError,
  InvalidTrustAnchorError,
  parseTrustAnchor,
  resolveCredential,
  verifyEnvelope,
} from '../../../packages/emergency-guard/src/index.js';
import { APP_ID, ENV, INGEST_KEY, document, makeAnchor, makeKey, policy, signEnvelope } from './helpers.js';

const key = makeKey('ek_main');
const other = makeKey('ek_other');
const anchor = parseTrustAnchor(makeAnchor(APP_ID, [key]));

function reason(raw: unknown): string {
  const r = verifyEnvelope(raw, anchor, ENV);
  return r.ok ? 'ok' : r.reason;
}

describe('verification order and reasons (§4)', () => {
  it('accepts a correctly signed document', () => {
    const r = verifyEnvelope(signEnvelope(key, document({ revision: 9, policies: [policy()] })), anchor, ENV);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.document.revision, 9);
    assert.equal(r.ok && r.document.policies[0]!.action, 'BLOCK');
  });

  it('1. malformed: not an object, an array, missing or non-string fields', () => {
    const good = signEnvelope(key, document());
    assert.equal(reason(null), 'malformed');
    assert.equal(reason('{}'), 'malformed');
    assert.equal(reason([good]), 'malformed');
    assert.equal(reason({ ...good, kid: undefined }), 'malformed');
    assert.equal(reason({ ...good, payload: 42 }), 'malformed');
    assert.equal(reason({ ...good, signature: null }), 'malformed');
    // Missing fields are reported before an unsupported format.
    assert.equal(reason({ format: 'other', alg: 'none' }), 'malformed');
  });

  it('2. unsupported_format: format or alg', () => {
    assert.equal(reason(signEnvelope(key, document(), { format: 'bugcapsule.emergency.v2' })), 'unsupported_format');
    assert.equal(reason(signEnvelope(key, document(), { alg: 'ES384' })), 'unsupported_format');
  });

  it('3. unknown_key: kid not in the anchor (a key in the response is never trusted)', () => {
    assert.equal(reason(signEnvelope(other, document())), 'unknown_key');
    assert.equal(reason({ ...signEnvelope(key, document()), kid: 'ek_missing', jwk: { kty: 'EC' } }), 'unknown_key');
  });

  it('4. bad_signature: other key, tampered bytes, undecodable base64 or DER', () => {
    const good = signEnvelope(key, document());
    assert.equal(reason({ ...signEnvelope(other, document()), kid: key.kid }), 'bad_signature');
    const tampered = Buffer.from(JSON.stringify(document({ revision: 2 })), 'utf8').toString('base64url');
    assert.equal(reason({ ...good, payload: tampered }), 'bad_signature');
    assert.equal(reason({ ...good, payload: `${good.payload}!` }), 'bad_signature');
    assert.equal(reason({ ...good, signature: 'not base64 *' }), 'bad_signature');
    assert.equal(reason({ ...good, signature: 'AAAA' }), 'bad_signature');
    assert.equal(reason({ ...good, signature: 'A' }), 'bad_signature');
    assert.equal(reason({ ...good, signature: '' }), 'bad_signature');
  });

  it('padded base64url is accepted too', () => {
    const good = signEnvelope(key, document());
    const pad = (s: string) => s + '='.repeat((4 - (s.length % 4)) % 4);
    assert.equal(reason({ ...good, payload: pad(good.payload), signature: pad(good.signature) }), 'ok');
  });

  it('5. malformed: signed payload that is not a JSON object', () => {
    assert.equal(reason(signEnvelope(key, 'not json')), 'malformed');
    assert.equal(reason(signEnvelope(key, '[1,2]')), 'malformed');
    assert.equal(reason(signEnvelope(key, 'null')), 'malformed');
  });

  it('6. unsupported_schema', () => {
    assert.equal(reason(signEnvelope(key, document({ schema_version: 2 }))), 'unsupported_schema');
    assert.equal(reason(signEnvelope(key, document({ schema_version: '1' }))), 'unsupported_schema');
  });

  it('7. wrong_application', () => {
    assert.equal(reason(signEnvelope(key, document({ application_id: '16fd2706-8baf-433b-82eb-8c7fada847da' }))), 'wrong_application');
  });

  it('8. wrong_environment', () => {
    assert.equal(reason(signEnvelope(key, document({ environment: 'staging' }))), 'wrong_environment');
  });

  it('a malformed policy makes the whole document malformed', () => {
    const bad = [
      { revision: -1 },
      { revision: 1.5 },
      { issued_at: 'yesterday' },
      { expires_at: null },
      { policies: {} },
      { policies: [policy({ key: 'Checkout' })] },
      { policies: [policy({ key: '*' })] },
      { policies: [policy({ policy_id: '' })] },
      { policies: [policy({ action: 7 })] },
      { policies: [policy({ priority: '1' })] },
      { policies: [policy({ rollout_bp: null })] },
      { policies: [policy({ target_platforms: 'SERVER' })] },
      { policies: [policy({ version_ranges: [{ min: 1 }] })] },
      { policies: [policy({ public_user_message: 3 })] },
      { policies: [policy({ expires_at: 'soon' })] },
      { policies: [policy(), 'x'] },
    ];
    for (const overrides of bad) assert.equal(reason(signEnvelope(key, document(overrides))), 'malformed', JSON.stringify(overrides));
  });

  it('unknown actions fail safe as BLOCK; unknown fields are ignored', () => {
    const r = verifyEnvelope(signEnvelope(key, document({ future: { x: 1 }, policies: [policy({ action: 'SELF_DESTRUCT', extra: true })] })), anchor, ENV);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.document.policies[0]!.action, 'BLOCK');
  });
});

describe('trust anchor (§2)', () => {
  it('parses keys and the application id', () => {
    const a = parseTrustAnchor(makeAnchor(APP_ID, [key, other]));
    assert.equal(a.app, APP_ID);
    assert.deepEqual([...a.keys.keys()], ['ek_main', 'ek_other']);
  });

  it('refuses a key with another alg, a missing prefix, junk and non-P-256 keys', () => {
    assert.throws(() => parseTrustAnchor(makeAnchor(APP_ID, [{ ...key, alg: 'RS256' }])), InvalidTrustAnchorError);
    assert.throws(() => parseTrustAnchor(makeAnchor(APP_ID, [key, { ...other, alg: 'ES384' }])), InvalidTrustAnchorError);
    assert.throws(() => parseTrustAnchor(makeAnchor(APP_ID, [])), InvalidTrustAnchorError);
    assert.throws(() => parseTrustAnchor(makeAnchor(APP_ID, [{ kid: 'k', spki: 'AAAA' }])), InvalidTrustAnchorError);
    assert.throws(() => parseTrustAnchor('bcek.v2.e30'), InvalidTrustAnchorError);
    assert.throws(() => parseTrustAnchor('bcek.v1.%%%'), InvalidTrustAnchorError);
    assert.throws(() => parseTrustAnchor(`bcek.v1.${Buffer.from('[1]').toString('base64url')}`), InvalidTrustAnchorError);
  });
});

describe('credential resolution', () => {
  const token = `bcsdk.v1.${Buffer.from(JSON.stringify({ api: 'https://bugs.example.com/bc/', key: INGEST_KEY })).toString('base64url')}`;

  it('takes the API URL from a connection token, or apiUrl with an ingest key', () => {
    assert.deepEqual(resolveCredential(token, undefined), { apiUrl: 'https://bugs.example.com/bc', key: INGEST_KEY });
    assert.deepEqual(resolveCredential(token, 'http://127.0.0.1:9/'), { apiUrl: 'http://127.0.0.1:9', key: INGEST_KEY });
    assert.deepEqual(resolveCredential(` ${INGEST_KEY}\n`, 'https://api.bugcapsule.com'), { apiUrl: 'https://api.bugcapsule.com', key: INGEST_KEY });
  });

  it('refuses secret keys, junk, missing apiUrl, and never echoes the credential', () => {
    const cases: [string, string | undefined][] = [
      ['bcs_SuperSecretValueNeverLogged0001', 'https://api.bugcapsule.com'],
      [INGEST_KEY, undefined],
      [INGEST_KEY, 'ftp://x'],
      ['bcsdk.v2.abc', undefined],
      ['bcsdk.v1.!!!', undefined],
      ['hello', 'https://api.bugcapsule.com'],
      ['', 'https://api.bugcapsule.com'],
    ];
    for (const [c, api] of cases) {
      assert.throws(
        () => resolveCredential(c, api),
        (e: unknown) => e instanceof InvalidCredentialError && (c.length < 8 || !e.message.includes(c)),
        c,
      );
    }
  });
});
