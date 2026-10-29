/**
 * Idempotency keys: a retried or duplicated request with the same key never
 * runs the irreversible operation twice and gets the first result back.
 *
 * The in-memory store protects one process only and forgets everything on
 * restart. In production, keep idempotency records in a durable store,
 * ideally a unique-keyed row written in the same database transaction as
 * the order or charge, so the record and the effect commit together.
 */

export type IdempotencyRecord<T> = { state: 'in_progress'; leaseExpiresAt: number } | { state: 'completed'; result: T; completedAt: number };

export type IdempotencyClaim<T> = { claimed: true } | { claimed: false; record: IdempotencyRecord<T> };

/**
 * Storage for idempotency records. `claim` must be atomic: of any number of
 * concurrent calls with the same key, exactly one gets `{ claimed: true }`
 * (for SQL: INSERT … ON CONFLICT DO NOTHING on a unique key).
 */
export interface IdempotencyStore<T = unknown> {
  /** Claims `key` for `leaseMs`, or returns the existing record. An expired in-progress lease may be taken over. */
  claim(key: string, leaseMs: number): Promise<IdempotencyClaim<T>>;
  /** Stores the result of the claimed operation. */
  complete(key: string, result: T): Promise<void>;
  /** Drops an in-progress claim whose operation did not commit, so a retry may run it. */
  release(key: string): Promise<void>;
  get(key: string): Promise<IdempotencyRecord<T> | null>;
}

export interface MemoryIdempotencyStoreOptions {
  /** How long completed results are kept. Default 24 h. */
  ttlMs?: number;
  /** Upper bound on stored keys; the oldest completed records are evicted first. Default 100 000. */
  maxEntries?: number;
  now?: () => number;
}

/** Single-process store for tests, demos and single-instance services. Not durable. */
export class MemoryIdempotencyStore<T = unknown> implements IdempotencyStore<T> {
  private readonly records = new Map<string, IdempotencyRecord<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: MemoryIdempotencyStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? 24 * 3600_000;
    this.maxEntries = options.maxEntries ?? 100_000;
    this.now = options.now ?? Date.now;
  }

  async claim(key: string, leaseMs: number): Promise<IdempotencyClaim<T>> {
    const now = this.now();
    const existing = this.live(key, now);
    if (existing && !(existing.state === 'in_progress' && existing.leaseExpiresAt <= now)) return { claimed: false, record: existing };
    this.records.delete(key);
    this.records.set(key, { state: 'in_progress', leaseExpiresAt: now + leaseMs });
    this.evict();
    return { claimed: true };
  }

  async complete(key: string, result: T): Promise<void> {
    this.records.delete(key);
    this.records.set(key, { state: 'completed', result, completedAt: this.now() });
    this.evict();
  }

  async release(key: string): Promise<void> {
    if (this.records.get(key)?.state === 'in_progress') this.records.delete(key);
  }

  async get(key: string): Promise<IdempotencyRecord<T> | null> {
    return this.live(key, this.now());
  }

  get size(): number {
    return this.records.size;
  }

  private live(key: string, now: number): IdempotencyRecord<T> | null {
    const r = this.records.get(key);
    if (!r) return null;
    if (r.state === 'completed' && r.completedAt + this.ttlMs <= now) {
      this.records.delete(key);
      return null;
    }
    return r;
  }

  private evict(): void {
    if (this.records.size <= this.maxEntries) return;
    for (const [k, r] of this.records) {
      if (this.records.size <= this.maxEntries) return;
      if (r.state === 'completed') this.records.delete(k);
    }
  }
}

/** Another request with the same key is still running and did not finish within `waitMs`. Answer 409 and let the client retry. */
export class IdempotencyConflictError extends Error {
  override readonly name = 'IdempotencyConflictError';
  readonly code = 'idempotency_in_progress' as const;
  readonly status = 409 as const;
  readonly key: string;
  constructor(key: string) {
    super('a request with this idempotency key is still in progress');
    this.key = key;
  }
}

export interface WithIdempotencyOptions {
  /** How long a claim protects the key; must exceed the operation's longest run. Default 60 s. */
  leaseMs?: number;
  /** How long a duplicate waits for the first request before IdempotencyConflictError. Default 10 s; 0 fails at once. */
  waitMs?: number;
  /** Poll interval while waiting. Default 25 ms. */
  pollMs?: number;
}

export interface IdempotentResult<T> {
  result: T;
  /** True when this call returned a stored result instead of running `fn`. */
  replayed: boolean;
}

const KEY_MAX = 255;

/**
 * Runs `fn` at most once per `key`. A duplicate gets the stored result
 * (`replayed: true`); a concurrent duplicate waits for the first call. If
 * `fn` throws (for example EmergencyBlockedError), the claim is released and
 * nothing is stored, so a later retry can run once the block is lifted.
 */
export async function withIdempotency<T>(store: IdempotencyStore<T>, key: string, fn: () => Promise<T>, options: WithIdempotencyOptions = {}): Promise<IdempotentResult<T>> {
  if (typeof key !== 'string' || key.length === 0 || key.length > KEY_MAX) throw new TypeError(`idempotency key must be a non-empty string of at most ${KEY_MAX} characters`);
  const leaseMs = options.leaseMs ?? 60_000;
  const waitMs = options.waitMs ?? 10_000;
  const pollMs = Math.max(1, options.pollMs ?? 25);
  const deadline = Date.now() + waitMs;
  for (;;) {
    const claim = await store.claim(key, leaseMs);
    if (claim.claimed) {
      let result: T;
      try {
        result = await fn();
      } catch (e) {
        await store.release(key);
        throw e;
      }
      await store.complete(key, result);
      return { result, replayed: false };
    }
    if (claim.record.state === 'completed') return { result: claim.record.result, replayed: true };
    // Another request holds the key: wait for its result.
    for (;;) {
      if (Date.now() >= deadline) throw new IdempotencyConflictError(key);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      const record = await store.get(key);
      if (record?.state === 'completed') return { result: record.result, replayed: true };
      // Released (the first attempt failed) or lease expired: try to claim it ourselves.
      if (!record || record.leaseExpiresAt <= Date.now()) break;
    }
  }
}
