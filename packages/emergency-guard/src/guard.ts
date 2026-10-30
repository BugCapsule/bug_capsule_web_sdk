/**
 * The server guard: fetches the signed emergency policy document (§3),
 * verifies it against the configured trust anchor (§4), accepts it with
 * anti-replay rules (§5), caches it in memory (and optionally on disk), and
 * evaluates and enforces it synchronously for platform SERVER (§6–§8).
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { evaluateDocument, isEnvironment, isFeatureKey, isFeaturePattern, keyMatches, type Action, type Decision, type PolicyDocument } from './contract.js';
import { resolveCredential, type ResolvedCredential } from './credential.js';
import { EmergencyBlockedError, type Operation } from './errors.js';
import { InvalidTrustAnchorError, parseTrustAnchor, verifyEnvelope, type TrustAnchor, type VerifyFailure } from './verify.js';
import { SDK_VERSION } from './version.js';

export type FailureMode = 'FAIL_OPEN' | 'FAIL_CLOSED' | 'USE_LAST_VALID_POLICY';
export type Consistency = 'cached' | 'strong';

const FAILURE_MODES: readonly FailureMode[] = ['FAIL_OPEN', 'FAIL_CLOSED', 'USE_LAST_VALID_POLICY'];

/** Acceptance reasons (§5) on top of the verification reasons (§4). */
export type RejectReason = VerifyFailure | 'stale_revision' | 'expired_on_arrival';

export interface GuardLogger {
  debug?(message: string, meta?: Record<string, unknown>): void;
  info?(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface EmergencyGuardOptions {
  /** An SDK connection token (`bcsdk.v1…`, carries the API URL) or an ingest key (`bct_…`, needs `apiUrl`). Never logged. */
  credential: string;
  /** BugCapsule API base URL. Overrides the URL inside a connection token. */
  apiUrl?: string;
  /** `bcek.v1.…` from the dashboard. Configure it in code or config, never fetch it. */
  trustAnchor: string;
  /** Environment whose policies apply, e.g. `production`. */
  environment: string;
  /** How often the document is refreshed. Default 5000 ms, minimum 1000 ms. */
  refreshIntervalMs?: number;
  /** Per-feature behaviour when no usable document exists: exact keys or `prefix.*`. Default FAIL_OPEN. */
  failureModes?: Record<string, FailureMode>;
  /** Upper bound on the conditional fetch of `consistency: 'strong'`. Default 1500 ms. */
  strongTimeoutMs?: number;
  /**
   * `consistency: 'strong'` accepts confirmation from a fetch that started at
   * most this long before the check. Default 0: every strong check waits for
   * a fetch that started after it (concurrent checks share one fetch).
   */
  strongMaxStalenessMs?: number;
  /** Whole-request timeout for policy fetches. Default 10000 ms. */
  requestTimeoutMs?: number;
  /** Optional file that keeps the last verified envelope and the highest accepted revision across restarts. Re-verified on load. */
  cacheFile?: string;
  /** This service's version, matched against `version_ranges`. Default null (always targeted). */
  appVersion?: string | null;
  /** Send APPLIED/FAILED receipts (§7.3). Default true. */
  receipts?: boolean;
  fetch?: typeof fetch;
  /** Clock in epoch milliseconds. Default Date.now. */
  now?: () => number;
  /** Random source in [0, 1) for backoff jitter. Default Math.random. */
  random?: () => number;
  /** Default: warnings and errors to the console. `false` silences the guard. */
  logger?: GuardLogger | false;
}

export interface EvaluateOptions {
  /**
   * Rollout subject: the actor or operation id (a pseudonymous id, never an
   * email). Omitted: this process's installation id (§6). `null`: no subject,
   * which keeps partial rollouts applying (fails safe).
   */
  subject?: string | null;
}

export interface EnforceOptions extends EvaluateOptions {
  featureKey: string;
  /** `read` passes READ_ONLY; `write` does not. Default `write`. */
  operation?: Operation;
  /** `cached` (default) decides from memory; `strong` first confirms the document with a conditional fetch. */
  consistency?: Consistency;
  /** Overrides `strongTimeoutMs` for this call. */
  timeoutMs?: number;
}

export interface GuardError {
  code: string;
  message: string;
  at: number;
}

export interface GuardStatus {
  /** `none`: no document; `usable`: within expires_at + 300 s; `expired`: older. */
  state: 'none' | 'usable' | 'expired';
  revision: number | null;
  highestRevision: number | null;
  issuedAt: string | null;
  expiresAt: string | null;
  receivedAt: number | null;
  lastFetchAt: number | null;
  lastSuccessAt: number | null;
  lastError: GuardError | null;
  credentialRejected: boolean;
  anchorValid: boolean;
  consecutiveFailures: number;
  nextFetchAt: number | null;
  running: boolean;
  installationId: string;
}

export interface GuardChange {
  reason: 'fetched' | 'loaded' | 'expired';
  revision: number | null;
  previousRevision: number | null;
  status: GuardStatus;
}

export type FetchOutcome =
  | { kind: 'updated'; revision: number }
  | { kind: 'unchanged'; revision: number }
  | { kind: 'not_modified' }
  | { kind: 'rejected'; reason: RejectReason }
  | { kind: 'failed'; code: string }
  | { kind: 'credential_rejected'; status: number }
  | { kind: 'disabled' };

interface Snapshot {
  document: PolicyDocument;
  envelope: Record<string, unknown>;
  etag: string | null;
  receivedAt: number;
  expiresAtMs: number;
}

interface CacheFile {
  format: typeof CACHE_FORMAT;
  app: string;
  environment: string;
  envelope: unknown;
  etag: string | null;
  receivedAt: number;
  highestRevision: number | null;
}

const CACHE_FORMAT = 'bugcapsule.emergency-guard.cache.v1';
/** A document stays usable this long after expires_at (§7.4), and may arrive this late (§5). */
const CLOCK_SKEW_MS = 300_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_TIMER_MS = 2 ** 31 - 1;

const consoleLogger: GuardLogger = {
  warn: (m, meta) => console.warn(`[bugcapsule/emergency-guard] ${m}`, ...(meta ? [meta] : [])),
  error: (m, meta) => console.error(`[bugcapsule/emergency-guard] ${m}`, ...(meta ? [meta] : [])),
};
const silentLogger: GuardLogger = { warn: () => {}, error: () => {} };

/** Creates a guard. Call `start()` once at boot; evaluation works before it (failure modes apply). */
export function createEmergencyGuard(options: EmergencyGuardOptions): EmergencyGuard {
  return new EmergencyGuard(options);
}

export class EmergencyGuard {
  readonly environment: string;
  readonly installationId: string;
  readonly refreshIntervalMs: number;

  private readonly credential: ResolvedCredential;
  private readonly anchor: TrustAnchor | null;
  private readonly failureModes: [string, FailureMode][];
  private readonly strongTimeoutMs: number;
  private readonly strongMaxStalenessMs: number;
  private readonly requestTimeoutMs: number;
  private readonly cacheFile: string | null;
  private readonly appVersion: string | null;
  private readonly receiptsEnabled: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly logger: GuardLogger;

  private snapshot: Snapshot | null = null;
  private highestRevision: number | null = null;
  private lastFetchAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private lastError: GuardError | null = null;
  private credentialRejected = false;
  private failures = 0;
  private retryAfterMs = 0;
  private nextFetchAt: number | null = null;
  private running = false;
  private startPromise: Promise<void> | null = null;
  private cacheLoaded = false;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private inflight: { promise: Promise<FetchOutcome>; startedAt: number } | null = null;
  private queued: Promise<FetchOutcome> | null = null;
  /** Start time of the most recent fetch that confirmed the current document. */
  private confirmedStartedAt: number | null = null;
  private readonly listeners = new Set<(change: GuardChange) => void>();
  private readonly sentReceipts = new Set<string>();
  private persistChain: Promise<void> = Promise.resolve();

  constructor(options: EmergencyGuardOptions) {
    if (!options || typeof options !== 'object') throw new TypeError('createEmergencyGuard: options are required');
    if (!isEnvironment(options.environment)) throw new TypeError('environment must match ^[a-z0-9][a-z0-9_-]{0,39}$ (for example "production")');
    this.environment = options.environment;
    this.credential = resolveCredential(options.credential, options.apiUrl);
    this.refreshIntervalMs = intOption('refreshIntervalMs', options.refreshIntervalMs, 5000, 1000);
    this.strongTimeoutMs = intOption('strongTimeoutMs', options.strongTimeoutMs, 1500, 1);
    this.strongMaxStalenessMs = intOption('strongMaxStalenessMs', options.strongMaxStalenessMs, 0, 0);
    this.requestTimeoutMs = intOption('requestTimeoutMs', options.requestTimeoutMs, 10_000, 1);
    this.failureModes = Object.entries(options.failureModes ?? {}).map(([key, mode]) => {
      if (!isFeaturePattern(key)) throw new TypeError(`failureModes: "${key}" is not a feature key or a prefix.* pattern`);
      if (!FAILURE_MODES.includes(mode)) throw new TypeError(`failureModes["${key}"] must be one of ${FAILURE_MODES.join(', ')}`);
      return [key, mode];
    });
    const appVersion = options.appVersion ?? null;
    if (appVersion !== null && (typeof appVersion !== 'string' || appVersion.length === 0 || appVersion.length > 64)) {
      throw new TypeError('appVersion must be a non-empty string of at most 64 characters, or null');
    }
    this.appVersion = appVersion;
    this.cacheFile = options.cacheFile ?? null;
    this.receiptsEnabled = options.receipts ?? true;
    const f = options.fetch ?? globalThis.fetch;
    if (typeof f !== 'function') throw new TypeError('no fetch implementation: use Node.js 20+ or pass options.fetch');
    this.fetchImpl = f;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.logger = options.logger === false ? silentLogger : (options.logger ?? consoleLogger);
    this.installationId = randomBytes(16).toString('base64url');
    let anchor: TrustAnchor | null = null;
    try {
      anchor = parseTrustAnchor(options.trustAnchor);
    } catch (e) {
      // §2: an invalid anchor turns emergency policies off; every decision uses its failure mode.
      const message = e instanceof InvalidTrustAnchorError ? e.message : 'invalid emergency trust anchor';
      this.lastError = { code: 'invalid_anchor', message, at: this.now() };
      this.logger.warn(`${message}. Emergency policies are off; every feature uses its failure mode.`);
    }
    this.anchor = anchor;
  }

  // ------------------------------------------------------------ lifecycle

  /**
   * Loads the cache file (if configured), performs the first fetch and
   * schedules refreshes. Resolves when the first fetch finishes, whether or
   * not it succeeded; failure modes cover the gap. Idempotent.
   */
  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.running = true;
    this.startPromise = (async () => {
      if (!this.anchor) return;
      await this.loadCache();
      if (!this.running) return;
      this.armExpiryTimer();
      await this.fetchShared();
    })();
    return this.startPromise;
  }

  /** Stops scheduled refreshes. The cached document stays in memory and evaluation keeps working. */
  stop(): void {
    this.running = false;
    this.startPromise = null;
    this.nextFetchAt = null;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.refreshTimer = null;
    this.expiryTimer = null;
  }

  /** Fetches now, joining a fetch already in flight. Also resumes scheduling after a credential refusal if it succeeds. */
  async refresh(): Promise<FetchOutcome> {
    if (!this.anchor) return { kind: 'disabled' };
    await this.loadCache();
    return this.fetchShared();
  }

  /** Waits for pending cache-file writes (useful before exit and in tests). */
  async flush(): Promise<void> {
    await this.persistChain;
  }

  // ----------------------------------------------------------- evaluation

  /** Synchronous, in-memory decision for platform SERVER. Throws TypeError for an invalid feature key. */
  evaluate(featureKey: string, options: EvaluateOptions = {}): Decision {
    if (!isFeatureKey(featureKey)) throw new TypeError(`"${String(featureKey)}" is not a feature key (lower-case dotted, e.g. checkout.confirm_order)`);
    const subject = options.subject === undefined ? this.installationId : options.subject;
    if (subject !== null && typeof subject !== 'string') throw new TypeError('subject must be a string or null');
    const now = this.now();
    const ctx = { platform: 'SERVER' as const, appVersion: this.appVersion, subject, now };
    const snap = this.snapshot;
    if (snap && now <= snap.expiresAtMs + CLOCK_SKEW_MS) return evaluateDocument(snap.document, featureKey, ctx, 'policy');
    const mode = this.failureModeFor(featureKey);
    if (mode === 'USE_LAST_VALID_POLICY' && snap) return evaluateDocument(snap.document, featureKey, ctx, 'stale_policy');
    return failureDecision(featureKey, mode === 'FAIL_CLOSED' ? 'BLOCK' : 'ALLOW', snap?.document.revision ?? null);
  }

  /**
   * Checks the policy right before an irreversible step. Returns the decision
   * (log its `documentRevision`/`policyRevision` with the operation) or
   * throws EmergencyBlockedError. Call it inside the request, after
   * validation and immediately before the commit.
   */
  async enforce(options: EnforceOptions): Promise<Decision> {
    const operation = options.operation ?? 'write';
    if (operation !== 'read' && operation !== 'write') throw new TypeError('operation must be "read" or "write"');
    const consistency = options.consistency ?? 'cached';
    if (consistency !== 'cached' && consistency !== 'strong') throw new TypeError('consistency must be "cached" or "strong"');
    const evalOptions: EvaluateOptions = options.subject === undefined ? {} : { subject: options.subject };
    // Validates the key before any network work.
    let decision = this.evaluate(options.featureKey, evalOptions);
    if (consistency === 'strong') {
      const timeoutMs = options.timeoutMs === undefined ? this.strongTimeoutMs : intOption('timeoutMs', options.timeoutMs, this.strongTimeoutMs, 1);
      const confirmed = await this.confirmFresh(timeoutMs);
      decision = this.evaluate(options.featureKey, evalOptions);
      if (!confirmed && this.failureModeFor(options.featureKey) === 'FAIL_CLOSED' && permits(decision, operation)) {
        decision = failureDecision(options.featureKey, 'BLOCK', this.snapshot?.document.revision ?? null);
      }
    }
    if (!permits(decision, operation)) throw new EmergencyBlockedError(decision, operation);
    return decision;
  }

  /** The configured failure mode for a key: exact entry, then the longest matching `prefix.*`, else FAIL_OPEN. */
  failureModeFor(featureKey: string): FailureMode {
    let best: [string, FailureMode] | null = null;
    for (const entry of this.failureModes) {
      const [pattern] = entry;
      if (pattern === featureKey) return entry[1];
      if (pattern.endsWith('.*') && keyMatches(pattern, featureKey) && (!best || pattern.length > best[0].length)) best = entry;
    }
    return best ? best[1] : 'FAIL_OPEN';
  }

  // ---------------------------------------------------------- observation

  status(): GuardStatus {
    const snap = this.snapshot;
    const now = this.now();
    return {
      state: !snap ? 'none' : now <= snap.expiresAtMs + CLOCK_SKEW_MS ? 'usable' : 'expired',
      revision: snap?.document.revision ?? null,
      highestRevision: this.highestRevision,
      issuedAt: snap?.document.issued_at ?? null,
      expiresAt: snap?.document.expires_at ?? null,
      receivedAt: snap?.receivedAt ?? null,
      lastFetchAt: this.lastFetchAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      credentialRejected: this.credentialRejected,
      anchorValid: this.anchor !== null,
      consecutiveFailures: this.failures,
      nextFetchAt: this.nextFetchAt,
      running: this.running,
      installationId: this.installationId,
    };
  }

  /** Called after a new document is in place or the current one stops being usable. Returns an unsubscribe function. */
  onChange(listener: (change: GuardChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // -------------------------------------------------------------- fetching

  /** Joins the fetch in flight, or starts one. */
  private fetchShared(): Promise<FetchOutcome> {
    return this.inflight ? this.inflight.promise : this.startFetch();
  }

  /** A fetch that started no earlier than `notBefore`: joins one in flight if it qualifies, else queues one shared follow-up. */
  private fetchStartedAfter(notBefore: number): Promise<FetchOutcome> {
    if (!this.inflight) return this.startFetch();
    if (this.strongMaxStalenessMs > 0 && this.inflight.startedAt >= notBefore) return this.inflight.promise;
    if (!this.queued) {
      const next = this.inflight.promise.then(() => {
        this.queued = null;
        return this.inflight ? this.inflight.promise : this.startFetch();
      });
      this.queued = next;
    }
    return this.queued;
  }

  private startFetch(): Promise<FetchOutcome> {
    const startedAt = this.now();
    const promise = this.fetchOnce(startedAt)
      .catch((e: unknown): FetchOutcome => {
        this.recordError('internal', e instanceof Error ? e.message : String(e));
        return { kind: 'failed', code: 'internal' };
      })
      .then((outcome) => {
        this.inflight = null;
        this.afterFetch(outcome, startedAt);
        return outcome;
      });
    this.inflight = { promise, startedAt };
    return promise;
  }

  private async confirmFresh(timeoutMs: number): Promise<boolean> {
    if (!this.anchor || this.credentialRejected) return false;
    const callAt = this.now();
    const notBefore = callAt - this.strongMaxStalenessMs;
    if (this.strongMaxStalenessMs > 0 && this.confirmedStartedAt !== null && this.confirmedStartedAt >= notBefore) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
      timer.unref?.();
    });
    try {
      const outcome = await Promise.race([this.fetchStartedAfter(notBefore), timeout]);
      return outcome !== null && (outcome.kind === 'updated' || outcome.kind === 'unchanged' || outcome.kind === 'not_modified');
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchOnce(startedAt: number): Promise<FetchOutcome> {
    const anchor = this.anchor!;
    this.lastFetchAt = startedAt;
    this.retryAfterMs = 0;
    const q = new URLSearchParams({ environment: this.environment, platform: 'SERVER', sdk_version: SDK_VERSION });
    if (this.appVersion) q.set('app_version', this.appVersion);
    const url = `${this.credential.apiUrl}/v1/apps/${encodeURIComponent(anchor.app)}/emergency/policies?${q.toString()}`;
    const headers: Record<string, string> = { authorization: `Bearer ${this.credential.key}`, accept: 'application/json' };
    const etag = this.snapshot?.etag;
    if (etag) headers['if-none-match'] = etag;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timer.unref?.();
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(url, { method: 'GET', headers, signal: controller.signal });
      } catch (e) {
        return this.failed(controller.signal.aborted ? 'timeout' : 'network_error', controller.signal.aborted ? 'policy fetch timed out' : `policy fetch failed: ${errorMessage(e)}`);
      }
      const status = res.status;
      if (status === 304) {
        await discardBody(res);
        if (!this.snapshot) return this.failed('unexpected_304', 'the API answered 304 but no document is cached');
        return { kind: 'not_modified' };
      }
      if (status === 401 || status === 403 || status === 404) {
        await discardBody(res);
        return { kind: 'credential_rejected', status };
      }
      if (status !== 200) {
        const body = await readLimited(res, 16 * 1024).catch(() => null);
        this.retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), this.now());
        if (status === 409 && body && problemReason(body) === 'emergency_not_configured') {
          return this.failed('emergency_not_configured', 'emergency recovery is not set up for this project (no signing key)');
        }
        return this.failed(`http_${status}`, `policy fetch answered HTTP ${status}`);
      }
      const text = await readLimited(res, MAX_BODY_BYTES).catch(() => undefined);
      if (text === undefined) return this.failed(controller.signal.aborted ? 'timeout' : 'network_error', 'policy response body could not be read');
      if (text === null) return this.failed('body_too_large', 'policy response is larger than 1 MiB');
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      return this.consider(body, res.headers.get('etag'));
    } finally {
      clearTimeout(timer);
    }
  }

  /** Verify (§4) then accept or reject (§5) a 200 body. */
  private consider(body: unknown, etag: string | null): FetchOutcome {
    const anchor = this.anchor!;
    const verified = verifyEnvelope(body, anchor, this.environment);
    if (!verified.ok) return this.reject(verified.reason, null);
    const doc = verified.document;
    const now = this.now();
    if (this.highestRevision !== null && doc.revision < this.highestRevision) return this.reject('stale_revision', doc.revision);
    const cur = this.snapshot;
    if (cur && doc.revision === cur.document.revision && Date.parse(doc.issued_at) <= Date.parse(cur.document.issued_at)) {
      return { kind: 'unchanged', revision: cur.document.revision };
    }
    const expiresAtMs = Date.parse(doc.expires_at);
    if (expiresAtMs < now - CLOCK_SKEW_MS) return this.reject('expired_on_arrival', doc.revision);
    this.install({ document: doc, envelope: body as Record<string, unknown>, etag, receivedAt: now, expiresAtMs }, 'fetched');
    this.persist();
    this.sendReceipt(doc.revision, 'APPLIED', null);
    return { kind: 'updated', revision: doc.revision };
  }

  private reject(reason: RejectReason, revision: number | null): FetchOutcome {
    this.recordError(reason, `policy document rejected: ${reason}`);
    this.logger.warn(`emergency policy document rejected (${reason}); keeping the current document`, revision !== null ? { revision } : undefined);
    this.sendReceipt(revision ?? this.highestRevision ?? 0, 'FAILED', reason);
    return { kind: 'rejected', reason };
  }

  private failed(code: string, message: string): FetchOutcome {
    this.recordError(code, message);
    return { kind: 'failed', code };
  }

  private recordError(code: string, message: string): void {
    this.lastError = { code, message: this.redact(message), at: this.now() };
  }

  private afterFetch(outcome: FetchOutcome, startedAt: number): void {
    switch (outcome.kind) {
      case 'updated':
      case 'unchanged':
      case 'not_modified':
        this.failures = 0;
        this.retryAfterMs = 0;
        this.lastSuccessAt = this.now();
        this.confirmedStartedAt = Math.max(this.confirmedStartedAt ?? startedAt, startedAt);
        if (this.credentialRejected) this.logger.warn('the credential is accepted again; resuming scheduled policy fetches');
        this.credentialRejected = false;
        this.lastError = null;
        break;
      case 'credential_rejected':
        if (!this.credentialRejected) {
          this.logger.error(
            `the credential was refused (HTTP ${outcome.status}); scheduled policy fetches stop for this process. The cached document stays in use until it expires.`,
          );
        }
        this.credentialRejected = true;
        this.recordError('credential_rejected', `credential refused (HTTP ${outcome.status})`);
        break;
      case 'failed':
        this.failures += 1;
        this.logger.debug?.(`policy fetch failed (${outcome.code})`, { failures: this.failures });
        if (this.failures === 3) this.logger.warn(`policy fetch failing repeatedly (${outcome.code}); failure modes apply once the cached document expires`);
        break;
      case 'rejected':
        this.failures += 1;
        break;
      case 'disabled':
        break;
    }
    this.scheduleNext();
  }

  private scheduleNext(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.nextFetchAt = null;
    if (!this.running || this.credentialRejected || !this.anchor) return;
    const delay = this.nextDelay();
    this.nextFetchAt = this.now() + delay;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.fetchShared();
    }, delay);
    this.refreshTimer.unref?.();
  }

  /** Normal interval, or after failures min(interval × 2^(n−1), 15 min) ±20% jitter, never below Retry-After (§7.2). */
  private nextDelay(): number {
    if (this.failures === 0) return this.refreshIntervalMs;
    const base = Math.min(this.refreshIntervalMs * 2 ** Math.min(this.failures - 1, 30), MAX_BACKOFF_MS);
    const jittered = base * (0.8 + 0.4 * this.random());
    return Math.min(Math.round(Math.max(jittered, this.retryAfterMs)), MAX_TIMER_MS);
  }

  // -------------------------------------------------------------- snapshot

  private install(snap: Snapshot, reason: GuardChange['reason']): void {
    const previous = this.snapshot;
    this.snapshot = snap;
    this.highestRevision = Math.max(this.highestRevision ?? snap.document.revision, snap.document.revision);
    this.armExpiryTimer();
    const changed = !previous || previous.document.revision !== snap.document.revision || previous.envelope.payload !== snap.envelope.payload || reason === 'loaded';
    if (changed) this.emit(reason, previous?.document.revision ?? null);
  }

  private armExpiryTimer(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    const snap = this.snapshot;
    if (!snap || !this.running) return;
    const delay = snap.expiresAtMs + CLOCK_SKEW_MS - this.now() + 1;
    if (delay <= 0) return;
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      if (this.snapshot !== snap) return;
      if (this.now() <= snap.expiresAtMs + CLOCK_SKEW_MS) return this.armExpiryTimer();
      this.logger.warn('the emergency policy document expired without a refresh; failure modes now apply');
      this.emit('expired', snap.document.revision);
    }, Math.min(delay, MAX_TIMER_MS));
    this.expiryTimer.unref?.();
  }

  private emit(reason: GuardChange['reason'], previousRevision: number | null): void {
    if (this.listeners.size === 0) return;
    const change: GuardChange = { reason, revision: this.snapshot?.document.revision ?? null, previousRevision, status: this.status() };
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch (e) {
        this.logger.error(`an onChange listener threw: ${errorMessage(e)}`);
      }
    }
  }

  // ----------------------------------------------------------------- cache

  private async loadCache(): Promise<void> {
    if (this.cacheLoaded || !this.cacheFile || !this.anchor) return;
    this.cacheLoaded = true;
    let text: string;
    try {
      text = await readFile(this.cacheFile, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.logger.warn(`could not read the policy cache file: ${errorMessage(e)}`);
      return;
    }
    let file: Partial<CacheFile>;
    try {
      file = JSON.parse(text) as Partial<CacheFile>;
    } catch {
      this.logger.warn('the policy cache file is not JSON; ignoring it');
      return;
    }
    if (file.format !== CACHE_FORMAT || file.app !== this.anchor.app || file.environment !== this.environment) return;
    if (Number.isSafeInteger(file.highestRevision) && (file.highestRevision as number) >= 0) {
      this.highestRevision = Math.max(this.highestRevision ?? 0, file.highestRevision as number);
    }
    // §7.1: verify again against the current anchor; a rotated key or a changed anchor discards it.
    const verified = verifyEnvelope(file.envelope, this.anchor, this.environment);
    if (!verified.ok) {
      this.logger.info?.(`discarding the cached policy document (${verified.reason})`);
      return;
    }
    if (this.snapshot && this.snapshot.document.revision >= verified.document.revision) return;
    const receivedAt = typeof file.receivedAt === 'number' && Number.isFinite(file.receivedAt) ? file.receivedAt : this.now();
    this.install(
      {
        document: verified.document,
        envelope: file.envelope as Record<string, unknown>,
        etag: typeof file.etag === 'string' ? file.etag : null,
        receivedAt,
        expiresAtMs: Date.parse(verified.document.expires_at),
      },
      'loaded',
    );
  }

  /** Writes the current envelope atomically (temp file, then rename). Writes are serialized. */
  private persist(): void {
    const path = this.cacheFile;
    const snap = this.snapshot;
    if (!path || !snap || !this.anchor) return;
    const file: CacheFile = {
      format: CACHE_FORMAT,
      app: this.anchor.app,
      environment: this.environment,
      envelope: snap.envelope,
      etag: snap.etag,
      receivedAt: snap.receivedAt,
      highestRevision: this.highestRevision,
    };
    this.persistChain = this.persistChain.then(async () => {
      const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(tmp, JSON.stringify(file), { mode: 0o600 });
        await rename(tmp, path);
      } catch (e) {
        this.logger.warn(`could not write the policy cache file: ${errorMessage(e)}`);
        await unlink(tmp).catch(() => {});
      }
    });
  }

  // -------------------------------------------------------------- receipts

  /** Fire-and-forget receipt, at most once per (revision, status, errorCode) per process (§7.3). */
  private sendReceipt(revision: number, status: 'APPLIED' | 'FAILED', errorCode: string | null): void {
    if (!this.receiptsEnabled || !this.anchor) return;
    const id = `${revision}:${status}:${errorCode ?? ''}`;
    if (this.sentReceipts.has(id)) return;
    this.sentReceipts.add(id);
    const body = {
      environment: this.environment,
      platform: 'SERVER',
      installationId: this.installationId,
      appVersion: this.appVersion,
      sdkVersion: SDK_VERSION,
      revision,
      status,
      errorCode,
    };
    const url = `${this.credential.apiUrl}/v1/apps/${encodeURIComponent(this.anchor.app)}/emergency/receipts`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timer.unref?.();
    void (async () => {
      try {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.credential.key}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        await discardBody(res);
        if (res.status >= 300) this.logger.debug?.(`receipt answered HTTP ${res.status}`);
      } catch (e) {
        this.logger.debug?.(`receipt failed: ${this.redact(errorMessage(e))}`);
      } finally {
        clearTimeout(timer);
      }
    })();
  }

  private redact(message: string): string {
    return message.split(this.credential.key).join('[credential]');
  }
}

// ------------------------------------------------------------------ helpers

/** Whether a decision lets the operation run: ALLOW always, READ_ONLY for reads only. */
export function permits(decision: Decision, operation: Operation): boolean {
  return decision.allowed || (decision.action === 'READ_ONLY' && operation === 'read');
}

function failureDecision(featureKey: string, action: Extract<Action, 'ALLOW' | 'BLOCK'>, documentRevision: number | null): Decision {
  return {
    featureKey,
    allowed: action === 'ALLOW',
    action,
    reasonCode: 'POLICY_UNAVAILABLE',
    policyId: null,
    policyRevision: null,
    documentRevision,
    publicUserMessage: null,
    requiredVersion: null,
    fallback: null,
    fallbackAvailable: false,
    source: 'failure_mode',
  };
}

function intOption(name: string, value: number | undefined, fallback: number, min: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) throw new RangeError(`${name} must be a number >= ${min}`);
  return Math.min(Math.floor(value), MAX_TIMER_MS);
}

/** `Retry-After` in seconds (clamped to 0–86400) or as an HTTP date; 0 when absent or invalid. */
export function parseRetryAfter(value: string | null, now: number): number {
  if (!value) return 0;
  const v = value.trim();
  let seconds: number;
  if (/^\d+$/.test(v)) seconds = Number(v);
  else {
    const at = Date.parse(v);
    if (!Number.isFinite(at)) return 0;
    seconds = Math.ceil((at - now) / 1000);
  }
  return Math.min(Math.max(seconds, 0), 86_400) * 1000;
}

/** Body text, or null when it exceeds `limit` bytes. */
async function readLimited(res: Response, limit: number): Promise<string | null> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // ignore
  }
}

function problemReason(text: string): string | null {
  try {
    const body = JSON.parse(text) as { reason?: unknown; error?: { reason?: unknown } };
    if (typeof body.reason === 'string') return body.reason;
    if (body.error && typeof body.error.reason === 'string') return body.error.reason;
  } catch {
    // not JSON
  }
  return null;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
