import type { OutboxLimits, UploadResult } from '../types.js';
import type { SdkStorage, StoredCapsule } from './idb.js';

export const DEFAULT_OUTBOX_LIMITS: Required<OutboxLimits> = Object.freeze({
  maxCount: 10,
  maxBytes: 10 * 1024 * 1024,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
});

export const MAX_SAVED_CAPTURES = 20;

interface RetryState {
  failures: number;
  retryAt: number | null;
  /** The deadline came from the server (`Retry-After`): it survives reloads. */
  fromServer?: boolean;
}

const RETRY_KEY = 'outbox.retry';

/**
 * Capsules waiting for upload (port of the Flutter `UploadOutbox`), stored in
 * IndexedDB so they survive reloads.
 *
 * * Bounds: 10 capsules / 10 MiB / 7 days by default, oldest evicted first; a
 *   capsule larger than `maxBytes` is never queued.
 * * Enqueue and eviction run in one IndexedDB transaction, so concurrent tabs
 *   cannot corrupt the queue; quota and other storage errors drop the capsule.
 * * Upload: oldest first, one at a time. Only one tab flushes at a time (Web
 *   Locks `ifAvailable`, or an expiring lease record in the same database on
 *   insecure origins without Web Locks; a tab finding it held skips). A
 *   retryable failure stops the pass and backs off 30 s → 1 h with ±20 %
 *   jitter (or `Retry-After`), shared by all tabs. A reload retries at once
 *   (like an app restart) unless the server asked for a later time. Permanent
 *   rejections and corrupt records are deleted.
 * * Nothing relies on an upload finishing while the page unloads.
 */
export class UploadOutbox {
  readonly limits: Required<OutboxLimits>;
  private closed = false;
  private readonly attempts = new Map<string, number>();
  private flushing: Promise<UploadResult | null> | null = null;

  constructor(
    private readonly storage: SdkStorage,
    limits: OutboxLimits = {},
    private readonly lockName = 'bugcapsule:outbox',
    private readonly now: () => number = () => Date.now(),
    private readonly random: () => number = Math.random,
  ) {
    this.limits = { ...DEFAULT_OUTBOX_LIMITS, ...limits };
  }

  async open(): Promise<void> {
    await this.storage.update('outbox', (records) => ({ remove: this.evictions(records), result: undefined }));
    // A reload retries at once, like an app restart; only a server deadline is kept.
    const state = await this.retryState();
    if (state.retryAt !== null && !state.fromServer) await this.setRetryState({ failures: 0, retryAt: null });
  }

  entries(): Promise<StoredCapsule[]> {
    return this.storage.list('outbox');
  }

  /** Queues a capsule; false when it was not queued (closed, too large, storage error, evicted at once). */
  async enqueue(capsuleId: string, bytes: Uint8Array): Promise<boolean> {
    if (this.closed || bytes.length > this.limits.maxBytes) return false;
    const enqueuedAt = this.now();
    const record: StoredCapsule = {
      id: `${String(enqueuedAt).padStart(15, '0')}_${capsuleId}`,
      capsuleId,
      enqueuedAt,
      size: bytes.length,
      bytes,
    };
    try {
      return await this.storage.update('outbox', (records) => {
        const all = [...records.filter((r) => r.id !== record.id), record];
        const remove = this.evictions(all);
        return { put: remove.includes(record.id) ? [] : [record], remove, result: !remove.includes(record.id) };
      });
    } catch {
      return false; // quota exceeded, storage unavailable
    }
  }

  /** Ids to delete: expired first, then oldest until within count and size. */
  private evictions(records: StoredCapsule[]): string[] {
    const cutoff = this.now() - this.limits.maxAgeMs;
    let count = records.length;
    let bytes = records.reduce((s, r) => s + r.size, 0);
    const remove: string[] = [];
    for (const r of records) {
      const expired = r.enqueuedAt < cutoff;
      if (!expired && count <= this.limits.maxCount && bytes <= this.limits.maxBytes) continue;
      remove.push(r.id);
      count--;
      bytes -= r.size;
    }
    return remove;
  }

  /** Deletes every queued capsule (kill switch). */
  async purge(): Promise<number> {
    return this.storage.update('outbox', (records) => ({ remove: records.map((r) => r.id), result: records.length }));
  }

  async retryAt(): Promise<number | null> {
    return (await this.retryState()).retryAt;
  }

  private async retryState(): Promise<RetryState> {
    try {
      return (await this.storage.getKv<RetryState>(RETRY_KEY)) ?? { failures: 0, retryAt: null };
    } catch {
      return { failures: 0, retryAt: null };
    }
  }

  private async setRetryState(s: RetryState): Promise<void> {
    try {
      await this.storage.setKv(RETRY_KEY, s);
    } catch {
      /* best effort */
    }
  }

  /**
   * Uploads queued capsules oldest first while `allowed()` holds. Returns the
   * result for `onlyId` when given. Calls in one tab are serialized; another
   * tab already flushing makes this a no-op (`retryLater`, "queued").
   */
  flush(opts: {
    upload: (bytes: Uint8Array) => Promise<UploadResult>;
    allowed: () => boolean;
    onlyId?: string;
  }): Promise<UploadResult | null> {
    const run = async (): Promise<UploadResult | null> => {
      const previous = this.flushing;
      if (previous) await previous.catch(() => null);
      return this.withLock(() => this.flushOnce(opts));
    };
    const p = run();
    this.flushing = p;
    void p.finally(() => {
      if (this.flushing === p) this.flushing = null;
    });
    return p;
  }

  private readonly owner = Math.random().toString(36).slice(2) + Date.now().toString(36);

  private async withLock(fn: () => Promise<UploadResult | null>): Promise<UploadResult | null> {
    const locks = (globalThis.navigator as Navigator | undefined)?.locks;
    if (!locks?.request) {
      // Insecure origins have no Web Locks: a lease in the same database.
      let leased = false;
      try {
        leased = await this.storage.tryLease(this.lockName, this.owner, 5 * 60_000, this.now());
      } catch {
        leased = true; // storage cannot arbitrate; the backend deduplicates by capsule id
      }
      if (!leased) return { status: 'retryLater', message: 'queued (another tab is uploading)' };
      try {
        return await fn();
      } finally {
        await this.storage.releaseLease(this.lockName, this.owner).catch(() => {});
      }
    }
    let ran = false;
    const result = await locks.request(this.lockName, { ifAvailable: true }, async (lock) => {
      if (!lock) return null;
      ran = true;
      return fn();
    });
    return ran ? result : { status: 'retryLater', message: 'queued (another tab is uploading)' };
  }

  private async flushOnce(opts: {
    upload: (bytes: Uint8Array) => Promise<UploadResult>;
    allowed: () => boolean;
    onlyId?: string;
  }): Promise<UploadResult | null> {
    let mine: UploadResult | null = null;
    const state = await this.retryState();
    if (state.retryAt !== null && this.now() < state.retryAt) {
      return opts.onlyId ? { status: 'retryLater', message: 'queued' } : null;
    }
    let queue: StoredCapsule[];
    try {
      queue = await this.entries();
    } catch {
      return opts.onlyId ? { status: 'retryLater', message: 'storage unavailable' } : null;
    }
    // Stable: oldest first among entries with the same number of failures.
    queue = [...queue].sort((a, b) => (this.attempts.get(a.capsuleId) ?? 0) - (this.attempts.get(b.capsuleId) ?? 0));
    let failures = state.failures;
    for (const entry of queue) {
      if (this.closed || !opts.allowed()) break;
      const bytes = entry.bytes;
      if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
        await this.storage.remove('outbox', [entry.id]).catch(() => {});
        continue;
      }
      const result = await opts.upload(bytes);
      if (entry.capsuleId === opts.onlyId) mine = result;
      if (result.status === 'retryLater') {
        this.attempts.set(entry.capsuleId, (this.attempts.get(entry.capsuleId) ?? 0) + 1);
        failures++;
        const base = 30_000 * 2 ** Math.min(failures - 1, 7);
        let delay = Math.min(base, 60 * 60 * 1000);
        const fromServer = result.retryAfterMs !== undefined && result.retryAfterMs > delay;
        if (fromServer) delay = result.retryAfterMs!;
        const jittered = Math.round(delay * (0.8 + this.random() * 0.4));
        await this.setRetryState({ failures, retryAt: this.now() + jittered, fromServer });
        break;
      }
      failures = 0;
      await this.setRetryState({ failures: 0, retryAt: null });
      this.attempts.delete(entry.capsuleId);
      await this.storage.remove('outbox', [entry.id]).catch(() => {});
    }
    if (opts.onlyId && mine === null) mine = { status: 'retryLater', message: 'queued' };
    return mine;
  }

  /** Stops uploading after the current capsule; later enqueues are refused. */
  async close(): Promise<void> {
    this.closed = true;
    await this.flushing?.catch(() => null);
  }
}

/** Saved captures (newest {@link MAX_SAVED_CAPTURES} kept) for in-app QA tooling. */
export async function saveCapture(storage: SdkStorage, capsuleId: string, bytes: Uint8Array, now = Date.now()): Promise<void> {
  const record: StoredCapsule = { id: `${String(now).padStart(15, '0')}_${capsuleId}`, capsuleId, enqueuedAt: now, size: bytes.length, bytes };
  await storage.update('captures', (records) => {
    const all = [...records, record];
    const excess = all.length - MAX_SAVED_CAPTURES;
    return { put: [record], remove: excess > 0 ? all.slice(0, excess).map((r) => r.id) : [], result: undefined };
  });
}
