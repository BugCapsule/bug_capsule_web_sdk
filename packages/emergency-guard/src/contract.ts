/**
 * Emergency policy contract v1: the signed document, version order, rollout
 * buckets and the reference evaluation. Pure code: no I/O, no clock. Checked
 * against the shared vectors in spec-fixtures/emergency-v1/.
 */
import { createHash } from 'node:crypto';

export const WIRE_FORMAT = 'bugcapsule.emergency.v1';
export const SIGNATURE_ALG = 'ES256';
export const SCHEMA_VERSION = 1;

export const ACTIONS = ['ALLOW', 'BLOCK', 'READ_ONLY', 'REQUIRE_UPDATE', 'SHOW_MAINTENANCE', 'DISABLE_FEATURE', 'USE_SAFE_FALLBACK'] as const;
export type Action = (typeof ACTIONS)[number];

export const PLATFORMS = ['FLUTTER_ANDROID', 'FLUTTER_IOS', 'NATIVE_ANDROID', 'NATIVE_IOS', 'SERVER'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Ties at the same priority go to the more restrictive action. */
export const RESTRICTIVENESS: Readonly<Record<Action, number>> = {
  ALLOW: 0,
  USE_SAFE_FALLBACK: 1,
  READ_ONLY: 2,
  DISABLE_FEATURE: 3,
  SHOW_MAINTENANCE: 4,
  REQUIRE_UPDATE: 5,
  BLOCK: 6,
};

const FEATURE_KEY_RE = /^[a-z0-9_-]{1,64}(\.[a-z0-9_-]{1,64}){0,7}$/;
const FEATURE_PATTERN_RE = /^[a-z0-9_-]{1,64}(\.[a-z0-9_-]{1,64}){0,7}(\.\*)?$/;
const ENVIRONMENT_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** A concrete feature key such as `checkout.confirm_order` (no wildcard). */
export function isFeatureKey(v: unknown): v is string {
  return typeof v === 'string' && FEATURE_KEY_RE.test(v);
}

/** A feature key or a `prefix.*` pattern, as used by policies and failure modes. */
export function isFeaturePattern(v: unknown): v is string {
  return typeof v === 'string' && FEATURE_PATTERN_RE.test(v);
}

export function isEnvironment(v: unknown): v is string {
  return typeof v === 'string' && ENVIRONMENT_RE.test(v);
}

/** Exact match, or `prefix.*` covering every key below `prefix` (not `prefix` itself). */
export function keyMatches(pattern: string, featureKey: string): boolean {
  if (pattern.endsWith('.*')) return featureKey.startsWith(pattern.slice(0, -1));
  return pattern === featureKey;
}

export interface VersionRange {
  /** Inclusive; null = no lower bound. */
  min: string | null;
  /** Inclusive; null = no upper bound. */
  max: string | null;
}

/** One policy of a verified document (snake_case, as signed). Unknown actions are already mapped to BLOCK. */
export interface DocumentPolicy {
  policy_id: string;
  key: string;
  revision: number;
  action: Action;
  priority: number;
  /** Empty: every platform. */
  target_platforms: string[];
  /** Empty: every version. */
  version_ranges: VersionRange[];
  rollout_bp: number;
  rollout_seed: string;
  reason_code: string | null;
  public_user_message: string | null;
  required_version: string | null;
  fallback: string | null;
  expires_at: string | null;
}

/** A verified policy document. Fields the guard does not use are kept as signed but not typed. */
export interface PolicyDocument {
  schema_version: number;
  application_id: string;
  environment: string;
  revision: number;
  issued_at: string;
  expires_at: string;
  policies: DocumentPolicy[];
  [extra: string]: unknown;
}

// ------------------------------------------------------------------ versions

export interface ParsedVersion {
  nums: number[];
  pre: string[] | null;
}

const VERSION_RE = /^v?(\d{1,9}(?:\.\d{1,9}){0,5})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/i;

/** `v?N(.N){0,5}(-pre)?(+build)?`; null for anything else. Surrounding whitespace is ignored. */
export function parseVersion(raw: string): ParsedVersion | null {
  const m = VERSION_RE.exec(raw.trim());
  if (!m) return null;
  return { nums: m[1]!.split('.').map(Number), pre: m[2] ? m[2].split('.') : null };
}

/** -1, 0 or 1; null when either side does not parse. Missing parts are 0; build metadata is ignored. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  const n = Math.max(x.nums.length, y.nums.length);
  for (let i = 0; i < n; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (!x.pre && !y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  const m = Math.max(x.pre.length, y.pre.length);
  for (let i = 0; i < m; i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      const d = Number(p) - Number(q);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (pn !== qn) {
      return pn ? -1 : 1;
    } else if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Whether `version` falls in any of `ranges` (inclusive bounds). No ranges:
 * every version. A null or unparseable version counts as targeted, so a
 * restriction never silently skips an unusual version string. A bound that
 * does not parse does not constrain (same as the reference evaluation).
 */
export function versionTargeted(version: string | null, ranges: readonly VersionRange[]): boolean {
  if (ranges.length === 0) return true;
  if (version === null || !parseVersion(version)) return true;
  return ranges.some(
    (r) => (r.min === null || (compareVersions(version, r.min) ?? 0) >= 0) && (r.max === null || (compareVersions(version, r.max) ?? 0) <= 0),
  );
}

// ------------------------------------------------------------------- rollout

/** 0..9999: first 4 bytes of SHA-256(UTF-8 "<seed>:<subject>") as a big-endian uint32, mod 10000. */
export function rolloutBucket(seed: string, subject: string): number {
  return createHash('sha256').update(`${seed}:${subject}`, 'utf8').digest().readUInt32BE(0) % 10000;
}

export function inRollout(p: Pick<DocumentPolicy, 'rollout_bp' | 'rollout_seed'>, subject: string | null): boolean {
  if (p.rollout_bp >= 10000) return true;
  if (p.rollout_bp <= 0) return false;
  // A partial rollout without a subject applies the restriction (fails safe).
  if (subject === null || subject === '') return true;
  return rolloutBucket(p.rollout_seed, subject) < p.rollout_bp;
}

// ---------------------------------------------------------------- evaluation

export interface EvaluationContext {
  platform: Platform;
  /** The caller's own version, for `version_ranges`; null counts as targeted. */
  appVersion: string | null;
  /** Stable pseudonymous id for partial rollouts. */
  subject: string | null;
  /** Epoch milliseconds, for per-policy expiry. */
  now: number;
}

/** Where a decision came from (§7.4). */
export type DecisionSource = 'policy' | 'stale_policy' | 'failure_mode';

export interface Decision {
  featureKey: string;
  allowed: boolean;
  action: Action;
  reasonCode: string | null;
  policyId: string | null;
  policyRevision: number | null;
  /** Revision of the document the decision came from; null when there was none. */
  documentRevision: number | null;
  publicUserMessage: string | null;
  requiredVersion: string | null;
  fallback: string | null;
  fallbackAvailable: boolean;
  source: DecisionSource;
}

/**
 * The reference decision over one document (§6). Candidates: the key
 * matches, not expired, aimed at the platform and version, and the rollout
 * includes the subject. Winner: highest priority, then the most restrictive
 * action, then an exact key over a wildcard, then the lowest policy_id.
 * No candidate: ALLOW. Only ALLOW is `allowed`.
 */
export function evaluateDocument(
  doc: { revision: number; policies: readonly DocumentPolicy[] },
  featureKey: string,
  ctx: EvaluationContext,
  source: DecisionSource = 'policy',
): Decision {
  const candidates = doc.policies.filter(
    (p) =>
      keyMatches(p.key, featureKey) &&
      (p.expires_at === null || Date.parse(p.expires_at) > ctx.now) &&
      (p.target_platforms.length === 0 || p.target_platforms.includes(ctx.platform)) &&
      versionTargeted(ctx.appVersion, p.version_ranges) &&
      inRollout(p, ctx.subject),
  );
  candidates.sort(
    (a, b) =>
      b.priority - a.priority ||
      RESTRICTIVENESS[b.action] - RESTRICTIVENESS[a.action] ||
      Number(b.key === featureKey) - Number(a.key === featureKey) ||
      (a.policy_id < b.policy_id ? -1 : a.policy_id > b.policy_id ? 1 : 0),
  );
  const w = candidates[0];
  if (!w) {
    return {
      featureKey,
      allowed: true,
      action: 'ALLOW',
      reasonCode: null,
      policyId: null,
      policyRevision: null,
      documentRevision: doc.revision,
      publicUserMessage: null,
      requiredVersion: null,
      fallback: null,
      fallbackAvailable: false,
      source,
    };
  }
  return {
    featureKey,
    allowed: w.action === 'ALLOW',
    action: w.action,
    reasonCode: w.reason_code,
    policyId: w.policy_id,
    policyRevision: w.revision,
    documentRevision: doc.revision,
    publicUserMessage: w.public_user_message,
    requiredVersion: w.required_version,
    fallback: w.fallback,
    fallbackAvailable: w.action === 'USE_SAFE_FALLBACK' && w.fallback !== null,
    source,
  };
}
