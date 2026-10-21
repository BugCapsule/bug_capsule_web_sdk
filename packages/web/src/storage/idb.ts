/**
 * Persistence for the SDK: IndexedDB when available, an in-memory fallback
 * otherwise (private windows that block IndexedDB, sandboxed iframes, tests).
 * Every operation rejects instead of throwing synchronously so callers can
 * catch quota and corruption errors without ever affecting the app.
 */
export interface StoredCapsule {
  /** `<enqueuedAtMs>_<capsuleId>`: oldest first when sorted. */
  id: string;
  capsuleId: string;
  enqueuedAt: number;
  size: number;
  bytes: Uint8Array;
}

export type StoreName = 'outbox' | 'captures';

export interface SdkStorage {
  readonly persistent: boolean;
  /** Atomic read-modify-write of one object store (serialized across tabs by IndexedDB). */
  update<T>(store: StoreName, fn: (records: StoredCapsule[]) => { put?: StoredCapsule[]; remove?: string[]; result: T }): Promise<T>;
  list(store: StoreName): Promise<StoredCapsule[]>;
  remove(store: StoreName, ids: string[]): Promise<void>;
  getKv<T>(key: string): Promise<T | undefined>;
  setKv(key: string, value: unknown): Promise<void>;
  /**
   * Takes the named lease for `owner` until `now + ttlMs` when it is free or
   * expired (one atomic transaction, so only one tab wins). Cross-tab mutual
   * exclusion where Web Locks are unavailable (insecure origins).
   */
  tryLease(name: string, owner: string, ttlMs: number, now: number): Promise<boolean>;
  releaseLease(name: string, owner: string): Promise<void>;
  close(): void;
}

interface Lease {
  owner: string;
  until: number;
}

const VERSION = 1;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function isRecord(v: unknown): v is StoredCapsule {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.id === 'string' && typeof r.capsuleId === 'string' && typeof r.enqueuedAt === 'number' && r.bytes instanceof Uint8Array;
}

class IdbStorage implements SdkStorage {
  readonly persistent = true;
  constructor(private readonly db: IDBDatabase) {
    db.onversionchange = () => db.close();
  }

  async update<T>(
    store: StoreName,
    fn: (records: StoredCapsule[]) => { put?: StoredCapsule[]; remove?: string[]; result: T },
  ): Promise<T> {
    const tx = this.db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    const completed = done(tx);
    const raw = await request(os.getAll());
    const corrupt: string[] = [];
    const records: StoredCapsule[] = [];
    for (const r of raw) {
      if (isRecord(r)) records.push(r);
      else if (typeof (r as { id?: unknown })?.id === 'string') corrupt.push((r as { id: string }).id);
    }
    records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const { put = [], remove = [], result } = fn(records);
    for (const id of [...corrupt, ...remove]) os.delete(id);
    for (const r of put) os.put(r);
    await completed;
    return result;
  }

  async list(store: StoreName): Promise<StoredCapsule[]> {
    return this.update(store, (records) => ({ result: records }));
  }

  async remove(store: StoreName, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const tx = this.db.transaction(store, 'readwrite');
    const completed = done(tx);
    for (const id of ids) tx.objectStore(store).delete(id);
    await completed;
  }

  async getKv<T>(key: string): Promise<T | undefined> {
    const tx = this.db.transaction('kv', 'readonly');
    return (await request(tx.objectStore('kv').get(key))) as T | undefined;
  }

  async setKv(key: string, value: unknown): Promise<void> {
    const tx = this.db.transaction('kv', 'readwrite');
    const completed = done(tx);
    tx.objectStore('kv').put(value, key);
    await completed;
  }

  async tryLease(name: string, owner: string, ttlMs: number, now: number): Promise<boolean> {
    const tx = this.db.transaction('kv', 'readwrite');
    const kv = tx.objectStore('kv');
    const completed = done(tx);
    const current = (await request(kv.get(`lease:${name}`))) as Lease | undefined;
    const free = !current || current.until <= now || current.owner === owner;
    if (free) kv.put({ owner, until: now + ttlMs } satisfies Lease, `lease:${name}`);
    await completed;
    return free;
  }

  async releaseLease(name: string, owner: string): Promise<void> {
    const tx = this.db.transaction('kv', 'readwrite');
    const kv = tx.objectStore('kv');
    const completed = done(tx);
    const current = (await request(kv.get(`lease:${name}`))) as Lease | undefined;
    if (current?.owner === owner) kv.delete(`lease:${name}`);
    await completed;
  }

  close(): void {
    this.db.close();
  }
}

/** Used when IndexedDB is unavailable: nothing survives a reload. */
export class MemoryStorage implements SdkStorage {
  readonly persistent = false;
  private readonly stores: Record<StoreName, Map<string, StoredCapsule>> = { outbox: new Map(), captures: new Map() };
  private readonly kv = new Map<string, unknown>();

  async update<T>(
    store: StoreName,
    fn: (records: StoredCapsule[]) => { put?: StoredCapsule[]; remove?: string[]; result: T },
  ): Promise<T> {
    const s = this.stores[store];
    const records = [...s.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const { put = [], remove = [], result } = fn(records);
    for (const id of remove) s.delete(id);
    for (const r of put) s.set(r.id, r);
    return result;
  }
  async list(store: StoreName): Promise<StoredCapsule[]> {
    return this.update(store, (records) => ({ result: records }));
  }
  async remove(store: StoreName, ids: string[]): Promise<void> {
    for (const id of ids) this.stores[store].delete(id);
  }
  async getKv<T>(key: string): Promise<T | undefined> {
    return structuredCloneSafe(this.kv.get(key)) as T | undefined;
  }
  async setKv(key: string, value: unknown): Promise<void> {
    this.kv.set(key, structuredCloneSafe(value));
  }
  async tryLease(name: string, owner: string, ttlMs: number, now: number): Promise<boolean> {
    const current = this.kv.get(`lease:${name}`) as Lease | undefined;
    if (current && current.until > now && current.owner !== owner) return false;
    this.kv.set(`lease:${name}`, { owner, until: now + ttlMs });
    return true;
  }
  async releaseLease(name: string, owner: string): Promise<void> {
    if ((this.kv.get(`lease:${name}`) as Lease | undefined)?.owner === owner) this.kv.delete(`lease:${name}`);
  }
  close(): void {}
}

function structuredCloneSafe<T>(v: T): T {
  return v === undefined ? v : typeof structuredClone === 'function' ? structuredClone(v) : (JSON.parse(JSON.stringify(v)) as T);
}

/** Opens (or creates) the SDK database; falls back to memory when IndexedDB is unusable. */
export async function openStorage(name: string, timeoutMs = 3000): Promise<SdkStorage> {
  if (typeof indexedDB === 'undefined') return new MemoryStorage();
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('IndexedDB open timed out')), timeoutMs);
      const req = indexedDB.open(name, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const store of ['outbox', 'captures']) {
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      req.onsuccess = () => {
        clearTimeout(timer);
        resolve(req.result);
      };
      req.onerror = () => {
        clearTimeout(timer);
        reject(req.error ?? new Error('IndexedDB open failed'));
      };
      req.onblocked = () => {
        clearTimeout(timer);
        reject(new Error('IndexedDB open blocked by another tab'));
      };
    });
    return new IdbStorage(db);
  } catch {
    return new MemoryStorage();
  }
}
