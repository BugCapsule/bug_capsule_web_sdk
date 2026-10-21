import type { BugCapsuleBackendConfig, UploadResult } from './types.js';
import type { SdkStorage } from './storage/idb.js';

/** Capture config the backend can change at runtime (kill switch, sampling, bodies, redaction). */
export interface RemoteCaptureConfig {
  enabled: boolean;
  sampleRate: number;
  maxCapsuleBytes: number;
  captureNetworkBodies: boolean;
  redactKeys: string[];
  configTtlSeconds: number;
  /** Wall clock (epoch ms) of the successful fetch. */
  fetchedAtMs: number;
}

/** Parses `/v1/sdk/config` (or the cache); throws on wrong types, clamps values. */
export function parseRemoteConfig(j: Record<string, unknown>, fetchedAtMs?: number): RemoteCaptureConfig {
  const field = <T>(key: string, type: string): T | undefined => {
    const v = j[key];
    if (v === undefined || v === null) return undefined;
    if (type === 'array' ? !Array.isArray(v) : typeof v !== type) {
      throw new TypeError(`remote config "${key}" has type ${typeof v}`);
    }
    return v as T;
  };
  const rate = field<number>('sampleRate', 'number') ?? 1;
  const ttl = field<number>('configTtlSeconds', 'number') ?? 300;
  const maxBytes = field<number>('maxCapsuleBytes', 'number') ?? 5 * 1024 * 1024;
  return {
    enabled: field<boolean>('enabled', 'boolean') ?? true,
    sampleRate: Number.isNaN(rate) ? 0 : Math.min(1, Math.max(0, rate)),
    maxCapsuleBytes: maxBytes < 1 ? 1 : Math.floor(maxBytes),
    captureNetworkBodies: field<boolean>('captureNetworkBodies', 'boolean') ?? true,
    redactKeys: (field<unknown[]>('redactKeys', 'array') ?? []).map(String),
    configTtlSeconds: Math.min(86_400, Math.max(0, Math.floor(ttl))),
    fetchedAtMs: fetchedAtMs ?? field<number>('fetchedAtMs', 'number') ?? 0,
  };
}

export type ConfigFetchResult =
  | { ok: true; config: RemoteCaptureConfig }
  | { ok: false; message: string; status?: number; retryAfterMs?: number };

/** How the SDK talks to the backend; tests substitute a fake. */
export interface BugCapsuleTransport {
  fetchConfig(): Promise<ConfigFetchResult>;
  upload(bytes: Uint8Array): Promise<UploadResult>;
}

function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number.parseInt(raw.trim(), 10);
  if (Number.isFinite(seconds)) return Math.min(86_400, Math.max(0, seconds)) * 1000;
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * The real transport. Uses the `fetch` captured before any integration
 * wrapped it, so SDK traffic is never recorded or replayed. CORS: the
 * backend must list the app's origin in `CORS_ALLOWED_ORIGINS`.
 */
export class BackendTransport implements BugCapsuleTransport {
  constructor(
    private readonly backend: BugCapsuleBackendConfig,
    private readonly nativeFetch: typeof fetch,
    private readonly timeoutMs = 20_000,
  ) {}

  private url(path: string): string {
    return `${this.backend.url.replace(/\/+$/, '')}${path}`;
  }

  private signal(ms: number): AbortSignal | undefined {
    return typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(ms) : undefined;
  }

  async fetchConfig(): Promise<ConfigFetchResult> {
    try {
      const res = await this.nativeFetch.call(globalThis, this.url('/v1/sdk/config'), {
        headers: { Authorization: `Bearer ${this.backend.ingestKey}` },
        cache: 'no-store',
        credentials: 'omit',
        signal: this.signal(this.timeoutMs),
      });
      const text = await res.text();
      if (res.status !== 200) {
        return { ok: false, message: `HTTP ${res.status}`, status: res.status, ...opt(retryAfterMs(res)) };
      }
      const json: unknown = JSON.parse(text);
      if (typeof json !== 'object' || json === null || Array.isArray(json)) {
        return { ok: false, message: 'config is not a JSON object' };
      }
      return { ok: true, config: parseRemoteConfig(json as Record<string, unknown>, Date.now()) };
    } catch (e) {
      return { ok: false, message: String(e) };
    }
  }

  async upload(bytes: Uint8Array): Promise<UploadResult> {
    // Room for a slow uplink: 20 s plus 1 s per 16 KB.
    const timeout = this.timeoutMs + Math.floor(bytes.length / (16 * 1024)) * 1000;
    try {
      const res = await this.nativeFetch.call(globalThis, this.url('/v1/capsules'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.backend.ingestKey}`, 'Content-Type': 'application/octet-stream' },
        body: bytes as BodyInit,
        credentials: 'omit',
        signal: this.signal(timeout),
      });
      let json: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(await res.text());
        json = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
      } catch {
        json = null;
      }
      if (res.status === 200 || res.status === 201) {
        return { status: 'uploaded', ...(typeof json?.id === 'string' ? { serverId: json.id } : {}) };
      }
      const code = typeof json?.code === 'string' ? json.code : `HTTP ${res.status}`;
      // 4xx other than 401/408/429 will never succeed: drop instead of retrying.
      const retry = res.status >= 500 || res.status === 401 || res.status === 408 || res.status === 429;
      return { status: retry ? 'retryLater' : 'rejected', message: code, ...optRetry(retryAfterMs(res)) };
    } catch (e) {
      return { status: 'retryLater', message: String(e) };
    }
  }
}

function opt(ms: number | undefined): { retryAfterMs?: number } {
  return ms === undefined ? {} : { retryAfterMs: ms };
}
const optRetry = opt;

/** Cache scope: one per backend URL and ingest key (a staging config never applies to production). */
export function configScope(backend: BugCapsuleBackendConfig | undefined): string {
  const input = new TextEncoder().encode(`${backend?.url ?? ''}|${backend?.ingestKey ?? ''}`);
  let h = 0xcbf29ce484222325n;
  for (const b of input) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16);
}

const CACHE_KEY = 'remoteConfig';

/**
 * Keeps the remote capture config current (port of the Flutter
 * `RemoteConfigController`): cached per scope, refreshed on its TTL (min
 * 30 s), exponential backoff 30 s → 30 min with ±20 % jitter honouring
 * `Retry-After`, refreshed when the page becomes visible. Uploads need an
 * enabled config fetched within `maxStaleMs`. A 401/403 acts as a kill switch
 * for the rest of the page session.
 */
export class RemoteConfigController {
  private currentConfig: RemoteCaptureConfig | null = null;
  private keyRejected = false;
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private paused = false;
  private disposed = false;

  constructor(
    private readonly opts: {
      fetch: () => Promise<ConfigFetchResult>;
      storage: SdkStorage;
      scope: string;
      onChange: (previous: RemoteCaptureConfig | null, next: RemoteCaptureConfig) => void;
      maxStaleMs?: number;
      minIntervalMs?: number;
      maxBackoffMs?: number;
      now?: () => number;
      random?: () => number;
      log?: (m: string) => void;
    },
  ) {}

  get current(): RemoteCaptureConfig | null {
    return this.currentConfig;
  }
  private get now(): number {
    return (this.opts.now ?? Date.now)();
  }
  private get minInterval(): number {
    return this.opts.minIntervalMs ?? 30_000;
  }
  private get ttlMs(): number {
    return Math.max(this.minInterval, (this.currentConfig?.configTtlSeconds ?? 0) * 1000);
  }
  get ageMs(): number | null {
    return this.currentConfig === null ? null : this.now - this.currentConfig.fetchedAtMs;
  }
  get isFresh(): boolean {
    const age = this.ageMs;
    return age !== null && age < this.ttlMs;
  }
  get captureAllowed(): boolean {
    return !this.keyRejected && (this.currentConfig?.enabled ?? true);
  }
  get uploadsAllowed(): boolean {
    const age = this.ageMs;
    return !this.keyRejected && this.currentConfig !== null && this.currentConfig.enabled && age !== null && age <= (this.opts.maxStaleMs ?? 7 * 86_400_000);
  }

  async loadCached(): Promise<void> {
    try {
      const cached = await this.opts.storage.getKv<{ scope: string; config: Record<string, unknown> }>(CACHE_KEY);
      if (cached && cached.scope === this.opts.scope) this.currentConfig = parseRemoteConfig(cached.config);
    } catch {
      this.currentConfig = null;
    }
  }

  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.inFlight ??= this.doRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  ensureFresh(): Promise<void> {
    return this.isFresh ? Promise.resolve() : this.refresh();
  }

  private async doRefresh(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    let result: ConfigFetchResult;
    try {
      result = await this.opts.fetch();
    } catch (e) {
      result = { ok: false, message: String(e) };
    }
    if (this.disposed) return;
    if (result.ok) {
      this.failures = 0;
      const previous = this.currentConfig;
      this.currentConfig = result.config;
      this.keyRejected = false;
      try {
        await this.opts.storage.setKv(CACHE_KEY, { scope: this.opts.scope, config: result.config });
      } catch {
        this.opts.log?.('could not cache remote config');
      }
      if (this.disposed) return;
      this.notify(previous, result.config);
      this.schedule(this.ttlMs);
      return;
    }
    this.failures++;
    if ((result.status === 401 || result.status === 403) && !this.keyRejected) {
      this.keyRejected = true;
      this.opts.log?.(`ingest key rejected (HTTP ${result.status}); capture stopped`);
      const prev = this.currentConfig;
      this.notify(prev, { ...(prev ?? parseRemoteConfig({})), enabled: false, captureNetworkBodies: false });
    }
    const exp = this.minInterval * 2 ** Math.min(this.failures - 1, 16);
    let delay = Math.min(exp, this.opts.maxBackoffMs ?? 30 * 60_000);
    if (result.retryAfterMs !== undefined && result.retryAfterMs > delay) delay = result.retryAfterMs;
    this.schedule(Math.round(delay * (0.8 + (this.opts.random ?? Math.random)() * 0.4)));
  }

  private notify(previous: RemoteCaptureConfig | null, next: RemoteCaptureConfig): void {
    try {
      this.opts.onChange(previous, next);
    } catch (e) {
      this.opts.log?.(`applying remote config failed: ${String(e)}`);
    }
  }

  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.disposed || this.paused) return;
    this.timer = setTimeout(() => void this.refresh(), delayMs);
  }

  onHidden(): void {
    this.paused = true;
    if (this.timer) clearTimeout(this.timer);
  }

  onVisible(): void {
    if (!this.paused || this.disposed) return;
    this.paused = false;
    if (this.inFlight) return;
    if (this.isFresh) this.schedule(this.ttlMs - (this.ageMs ?? 0));
    else void this.refresh();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
