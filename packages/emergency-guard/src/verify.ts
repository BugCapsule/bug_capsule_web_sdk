/**
 * Trust anchor parsing (§2) and envelope verification (§4). The signing key
 * always comes from the anchor the developer configured, never from a
 * response. The signature is checked over the exact payload bytes before
 * the payload is parsed.
 */
import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { ACTIONS, SCHEMA_VERSION, SIGNATURE_ALG, WIRE_FORMAT, isFeaturePattern, type Action, type DocumentPolicy, type PolicyDocument, type VersionRange } from './contract.js';

export const ANCHOR_PREFIX = 'bcek.v1.';

/** Verification reasons, in the order they are checked (§4). */
export type VerifyFailure =
  | 'malformed'
  | 'unsupported_format'
  | 'unknown_key'
  | 'bad_signature'
  | 'unsupported_schema'
  | 'wrong_application'
  | 'wrong_environment';

export interface TrustAnchor {
  /** Application id (UUID) the documents must be bound to. */
  app: string;
  /** kid → P-256 public key. */
  keys: ReadonlyMap<string, KeyObject>;
}

export class InvalidTrustAnchorError extends Error {
  override readonly name = 'InvalidTrustAnchorError';
}

/** Strict unpadded (or padded) base64url; null when the input is not base64url. */
export function decodeBase64Url(s: string): Buffer | null {
  const body = s.replace(/={1,2}$/, '');
  if (!/^[A-Za-z0-9_-]*$/.test(body) || body.length % 4 === 1) return null;
  return Buffer.from(body, 'base64url');
}

/** Parses `bcek.v1.<base64url JSON>`. Throws InvalidTrustAnchorError; the message never contains key material. */
export function parseTrustAnchor(anchor: string): TrustAnchor {
  const bad = (why: string): never => {
    throw new InvalidTrustAnchorError(`invalid emergency trust anchor: ${why}`);
  };
  if (typeof anchor !== 'string') bad('expected a string');
  const s = anchor.trim();
  if (!s.startsWith(ANCHOR_PREFIX)) bad(`it must start with "${ANCHOR_PREFIX}"; copy it from the dashboard (Emergency → Settings → Signing keys)`);
  const raw = decodeBase64Url(s.slice(ANCHOR_PREFIX.length));
  if (!raw) return bad('the encoded part is not base64url');
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    return bad('the encoded part is not UTF-8 JSON');
  }
  if (!isObject(json)) return bad('expected a JSON object');
  const { app, keys } = json as { app?: unknown; keys?: unknown };
  if (typeof app !== 'string' || app.length === 0) return bad('missing "app"');
  if (!Array.isArray(keys) || keys.length === 0) return bad('no keys');
  const map = new Map<string, KeyObject>();
  for (const k of keys) {
    if (!isObject(k)) return bad('a key is not an object');
    const { kid, alg, spki } = k as { kid?: unknown; alg?: unknown; spki?: unknown };
    if (typeof kid !== 'string' || kid.length === 0) return bad('a key has no kid');
    if (alg !== SIGNATURE_ALG) return bad(`key ${kid} uses ${String(alg)}; only ${SIGNATURE_ALG} is allowed`);
    const der = typeof spki === 'string' ? decodeBase64Url(spki) : null;
    if (!der) return bad(`key ${kid} has no base64url spki`);
    let key: KeyObject;
    try {
      key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    } catch {
      return bad(`key ${kid} is not a DER SubjectPublicKeyInfo`);
    }
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return bad(`key ${kid} is not a P-256 key`);
    map.set(kid, key);
  }
  return { app, keys: map };
}

export type VerifyResult = { ok: true; document: PolicyDocument; payload: string } | { ok: false; reason: VerifyFailure };

/**
 * §4 verification, in order, stopping at the first failure. `payload` in the
 * result is the signed base64url text, kept so a cache can be compared and
 * re-verified byte for byte.
 */
export function verifyEnvelope(raw: unknown, anchor: TrustAnchor, environment: string): VerifyResult {
  const fail = (reason: VerifyFailure): VerifyResult => ({ ok: false, reason });
  if (!isObject(raw)) return fail('malformed');
  const e = raw as Record<string, unknown>;
  if (typeof e.kid !== 'string' || typeof e.payload !== 'string' || typeof e.signature !== 'string') return fail('malformed');
  if (e.format !== WIRE_FORMAT || e.alg !== SIGNATURE_ALG) return fail('unsupported_format');
  const key = anchor.keys.get(e.kid);
  if (!key) return fail('unknown_key');
  const payload = decodeBase64Url(e.payload);
  const signature = decodeBase64Url(e.signature);
  if (!payload || !signature) return fail('bad_signature');
  let valid = false;
  try {
    valid = verify('sha256', payload, { key, dsaEncoding: 'der' }, signature);
  } catch {
    valid = false;
  }
  if (!valid) return fail('bad_signature');
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
  } catch {
    return fail('malformed');
  }
  if (!isObject(doc)) return fail('malformed');
  const d = doc as Record<string, unknown>;
  if (d.schema_version !== SCHEMA_VERSION) return fail('unsupported_schema');
  if (d.application_id !== anchor.app) return fail('wrong_application');
  if (d.environment !== environment) return fail('wrong_environment');
  const document = normalizeDocument(d);
  if (!document) return fail('malformed');
  return { ok: true, document, payload: e.payload };
}

/**
 * Checks the fields the guard relies on and maps unknown actions to BLOCK.
 * Any malformed policy makes the whole document malformed (§4). Unknown
 * fields are ignored for forward compatibility.
 */
function normalizeDocument(d: Record<string, unknown>): PolicyDocument | null {
  if (!isRevision(d.revision) || !isInstant(d.issued_at) || !isInstant(d.expires_at) || !Array.isArray(d.policies)) return null;
  const policies: DocumentPolicy[] = [];
  for (const p of d.policies) {
    const policy = normalizePolicy(p);
    if (!policy) return null;
    policies.push(policy);
  }
  return { ...(d as unknown as PolicyDocument), policies };
}

function normalizePolicy(raw: unknown): DocumentPolicy | null {
  if (!isObject(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.policy_id !== 'string' || p.policy_id.length === 0) return null;
  if (!isFeaturePattern(p.key)) return null;
  if (!isRevision(p.revision) || !Number.isSafeInteger(p.priority) || !Number.isSafeInteger(p.rollout_bp)) return null;
  if (typeof p.action !== 'string' || typeof p.rollout_seed !== 'string') return null;
  if (!Array.isArray(p.target_platforms) || !p.target_platforms.every((x) => typeof x === 'string')) return null;
  if (!Array.isArray(p.version_ranges)) return null;
  const ranges: VersionRange[] = [];
  for (const r of p.version_ranges) {
    if (!isObject(r)) return null;
    const { min, max } = r as { min?: unknown; max?: unknown };
    if (!isNullableString(min ?? null) || !isNullableString(max ?? null)) return null;
    ranges.push({ min: (min as string | null | undefined) ?? null, max: (max as string | null | undefined) ?? null });
  }
  for (const f of ['reason_code', 'public_user_message', 'required_version', 'fallback'] as const) {
    if (!isNullableString(p[f] ?? null)) return null;
  }
  const expires = p.expires_at ?? null;
  if (expires !== null && !isInstant(expires)) return null;
  // An unknown action fails safe (§4).
  const action: Action = (ACTIONS as readonly string[]).includes(p.action) ? (p.action as Action) : 'BLOCK';
  return {
    policy_id: p.policy_id,
    key: p.key,
    revision: p.revision,
    action,
    priority: p.priority as number,
    target_platforms: p.target_platforms as string[],
    version_ranges: ranges,
    rollout_bp: p.rollout_bp as number,
    rollout_seed: p.rollout_seed,
    reason_code: (p.reason_code as string | null | undefined) ?? null,
    public_user_message: (p.public_user_message as string | null | undefined) ?? null,
    required_version: (p.required_version as string | null | undefined) ?? null,
    fallback: (p.fallback as string | null | undefined) ?? null,
    expires_at: expires as string | null,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isRevision(v: unknown): v is number {
  return Number.isSafeInteger(v) && (v as number) >= 0;
}

function isInstant(v: unknown): v is string {
  return typeof v === 'string' && Number.isFinite(Date.parse(v));
}

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}
