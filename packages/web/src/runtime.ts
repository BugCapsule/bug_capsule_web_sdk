import { ActionRegistry } from './actions.js';
import { capsuleFromJson, capsuleToJson, CapsuleFormatError, encodeCapsule } from './core/codec.js';
import { cut } from './core/json.js';
import { assertionFailure, exceptionFailure, shiftFailure } from './core/failure.js';
import { EligibilityBuilder, runtimeOf, type Capsule, type CapsuleEvent, type Checkpoint, type CheckpointKind, type FailureRecord, type SentryLink } from './core/model.js';
import { replaySettingsFromJson, type ReplayReport, type ReplaySettings } from './core/protocol.js';
import { FlightRecorder } from './core/recorder.js';
import { Redactor } from './core/redaction.js';
import { validateCapsuleDocument } from './core/validator.js';
import { HistoryIntegration } from './integrations/history.js';
import { NetworkIntegration } from './integrations/network.js';
import { StateIntegration } from './integrations/state.js';
import { Monitor } from './monitoring/client.js';
import type { CaptureContext, Mechanism, MonitorHooks, MonitoringLink } from './monitoring/types.js';
import { BackendTransport, configScope, RemoteConfigController, type BugCapsuleTransport, type RemoteCaptureConfig } from './remote-config.js';
import { detectReplayBridge, ReplayEngine, type ReplayBridge } from './replay/engine.js';
import { openStorage, type SdkStorage } from './storage/idb.js';
import { saveCapture, UploadOutbox } from './storage/outbox.js';
import type { BugCapsuleConfig, BugCapsuleIntegration, BugCapsuleSession, CaptureResult, ReplayContext, UploadResult } from './types.js';

export const SDK_NAME = '@bugcapsule/web';
export const SDK_VERSION = '0.4.0-beta.1';

/**
 * What happened to a failure's capsule (the Sentry companion reports it as
 * the `bugcapsule.capture` tag):
 * `scheduled` a capsule was scheduled for it; `not_recording` this session
 * does not record (capture setup failed or timed out, or `init` has not
 * finished); `sampled_out` a production session not selected by
 * `productionSampleRate` / the backend's `sampleRate`; `limit`
 * `maxCapsulesPerSession` reached; `duplicate` the same failure (signature
 * or thrown value) already had its chance this session; `replaying` the
 * app runs under the replay runner; `disabled` BugCapsule is not
 * initialized, `enabled: false`, the backend kill switch, or
 * `autoCaptureOnFailure: false`; `not_a_failure` `ignoreError` returned true,
 * or the event carries no exception.
 */
export type CaptureDecision = 'scheduled' | 'not_recording' | 'sampled_out' | 'limit' | 'duplicate' | 'replaying' | 'disabled' | 'not_a_failure';

export interface FailureOutcome {
  /** The capsule scheduled for this failure, if any. */
  readonly capsuleId: string | null;
  readonly capture: CaptureDecision;
}

/** @internal What the Sentry companion passes for one Sentry error event. */
export interface ExternalFailure {
  /** `hint.originalException`. */
  error: unknown;
  /** The hint has an `originalException` key (its value may be a thrown `undefined`). */
  hasError: boolean;
  /** The event carries `exception.values`. */
  hasException: boolean;
  /** Last exception type/value, used without `originalException`. */
  fallback: { type?: string; value?: string } | null;
  /** Written to `manifest.links.sentry` of the capsule; null when the event id is unusable. */
  link: SentryLink | null;
}

/** One thrown value the runtime handled (either path). */
interface HandledFailure {
  failure: FailureRecord | null;
  capsuleId: string | null;
  capture: CaptureDecision;
  /** A BugCapsule monitoring event was sent for it. */
  monitored: boolean;
  /** A Sentry event was linked to its capsule. */
  sentryLinked: boolean;
}

/** How long a primitive thrown value (keyed by signature) counts as the same failure. */
const PRIMITIVE_WINDOW_MS = 5000;

/** Replaces storage, transport and randomness in tests. */
export interface RuntimeOverrides {
  storage?: SdkStorage;
  transport?: BugCapsuleTransport;
  random?: () => number;
  bridge?: ReplayBridge | null;
}

const perfNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function uuidV4(): string {
  const c = globalThis.crypto as Crypto & { randomUUID?: () => string };
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function newSeed(): number {
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return b[0]!;
}

function browserVersion(): string {
  const nav = globalThis.navigator as (Navigator & { userAgentData?: { brands?: { brand: string; version: string }[] } }) | undefined;
  const brands = nav?.userAgentData?.brands?.filter((b) => !/not.?a.?brand/i.test(b.brand) && b.brand !== 'Chromium');
  if (brands && brands.length > 0) return `${brands[0]!.brand} ${brands[0]!.version}`;
  const ua = nav?.userAgent ?? '';
  const m = /(Edg|Firefox|Chrome|Version)\/(\d+)/.exec(ua);
  if (!m) return 'unknown';
  const name = m[1] === 'Edg' ? 'Edge' : m[1] === 'Version' ? 'Safari' : m[1];
  return `${name} ${m[2]}`;
}

/** The SDK runtime behind the `BugCapsule` facade. */
export class Runtime implements BugCapsuleSession {
  readonly actions = new ActionRegistry();
  readonly state = new StateIntegration();
  readonly integrations: BugCapsuleIntegration[];
  readonly nativeFetch: typeof fetch;
  private readonly startedAt = new Date();
  private readonly start0 = perfNow();
  private readonly sessionId = uuidV4();
  private readonly seed = newSeed();
  private seededRandom = mulberry32(this.seed);
  private readonly sampleRandom: () => number;
  private recorder: FlightRecorder | null = null;
  engine: ReplayEngine | null = null;
  private currentRedactor: Redactor;
  private recording = false;
  /** Why `recording` is false. */
  private notRecording: 'not_recording' | 'sampled_out' | 'disabled' = 'not_recording';
  private captureBodies: boolean;
  private maxCapsuleBytes = 5 * 1024 * 1024;
  private sessionRate = 1;
  private captureEpoch = 0;
  private killed = false;
  private anchor: number | null = null;
  private wallAtAnchor: number | null = null;
  private checkpointTimer: ReturnType<typeof setInterval> | null = null;
  private checkpointBusy = false;
  lastFailure: FailureRecord | null = null;
  private readonly capturedSignatures = new Set<string>();
  private readonly seenSignatures = new Set<string>();
  private capsulesWritten = 0;
  private storagePromise: Promise<SdkStorage> | null = null;
  private transport: BugCapsuleTransport | null = null;
  private outbox: UploadOutbox | null = null;
  remote: RemoteConfigController | null = null;
  private disposed = false;
  private readonly cleanups: (() => void)[] = [];
  private readonly warned = new Set<string>();
  private readonly frameworks = new Set<string>();
  private pressed = new Set<number>();
  /** monitoring-v1 client; null when monitoring is off, without a backend, and in replay. */
  monitorClient: Monitor | null = null;
  /** Integrations monitoring installed because the app did not configure them (never recorded). */
  private readonly monitoringIntegrations: BugCapsuleIntegration[] = [];
  /** `manifest.monitoring` for capsules about to be written, by capsule id. */
  private readonly capsuleLinks = new Map<string, MonitoringLink>();
  /** The latest event sent for each failure signature (manual captures link to it). */
  private readonly failureLinks = new Map<string, MonitoringLink>();
  /** `manifest.links.sentry` for capsules about to be written, by capsule id. */
  private readonly sentryLinks = new Map<string, SentryLink>();
  /** Capsule ids writeCapsule already ran for (a late Sentry link cannot reach them). */
  private readonly writtenCapsules = new Set<string>();
  /** Thrown objects already handled, so one error is one failure whichever handler runs first. */
  private readonly handledErrors = new WeakMap<object, HandledFailure>();
  /** Primitive (or synthesized) thrown values, by failure signature, for a short window. */
  private readonly handledValues = new Map<string, { entry: HandledFailure; at: number }>();

  constructor(
    readonly config: Readonly<BugCapsuleConfig>,
    private readonly overrides: RuntimeOverrides = {},
  ) {
    this.nativeFetch = typeof fetch === 'function' ? fetch.bind(globalThis) : ((() => Promise.reject(new Error('fetch unavailable'))) as unknown as typeof fetch);
    this.sampleRandom = overrides.random ?? Math.random;
    this.integrations = [...(config.integrations ?? []), this.state];
    this.currentRedactor = this.baseRedactor();
    this.captureBodies = config.captureNetworkBodies ?? true;
    if (config.enabled === false) this.notRecording = 'disabled';
  }

  // ------------------------------------------------------------ session API

  get mode() {
    return this.config.mode ?? 'production';
  }
  get isRecording(): boolean {
    return this.recording;
  }
  get isReplaying(): boolean {
    return this.engine !== null;
  }
  get redactor(): Redactor {
    return this.currentRedactor;
  }
  get captureNetworkBodies(): boolean {
    return this.captureBodies;
  }
  get maxBodyBytes(): number {
    return this.config.maxBodyBytes ?? 256 * 1024;
  }
  get replay(): ReplayContext | null {
    return this.engine;
  }
  get monitor(): MonitorHooks | null {
    return this.engine ? null : this.monitorClient;
  }

  now(): number {
    return Math.round(perfNow() - this.start0);
  }

  /** Wall clock (epoch ms): the recorded clock during replay. */
  wallClock(): number {
    return this.engine ? Math.round(this.engine.wallClock()) : Date.now();
  }

  random(): number {
    return this.seededRandom();
  }

  addFramework(name: string): void {
    this.frameworks.add(name);
  }

  private warnOnce(message: string): void {
    if (this.warned.has(message)) return;
    this.warned.add(message);
    console.debug(`[bugcapsule] ${message}`);
  }

  record(type: string, data: Record<string, unknown> = {}): void {
    const monitor = this.monitorClient;
    if (monitor && !this.engine) this.guard(() => monitor.onRecord(type, data));
    if (!this.recording) return;
    const recorder = this.recorder;
    if (!recorder) return;
    const clean = this.sanitizeEvent(type, data);
    if (clean) recorder.add(this.now(), type, clean);
  }

  /**
   * Defense in depth: whatever an integration records goes through the
   * redactor again, then the app's `beforeRecord`. Derived fields (request
   * key, failure signature, base64 bodies) stay byte-identical.
   */
  private sanitizeEvent(type: string, data: Record<string, unknown>, hook = true): Record<string, unknown> | null {
    try {
      let out = data;
      if (type === 'http' && !this.captureBodies) out = withoutBodies(out);
      if (type !== 'pointer' && type !== 'lifecycle') {
        out = this.currentRedactor.redactJson(out);
        if (type === 'http') {
          if ('key' in data) out.key = data.key;
          if (out.bodyEncoding === 'base64') out.responseBody = data.responseBody;
          if (out.requestEncoding === 'base64') out.requestBody = data.requestBody;
        }
        if (type === 'failure' && typeof data.signature === 'string') out.signature = data.signature;
      }
      const before = this.config.beforeRecord;
      return before && hook ? before(type, out) : out;
    } catch (e) {
      this.warnOnce(`dropping a ${type} event: sanitizer failed (${String(e)})`);
      return null;
    }
  }

  reportError(error: unknown, context: CaptureContext = {}): void {
    this.onError(error, context.mechanism ?? { type: 'manual', handled: true }, context);
  }

  // ---------------------------------------------------------------- startup

  async start(): Promise<void> {
    const bridge = this.overrides.bridge !== undefined ? this.overrides.bridge : detectReplayBridge();
    if (bridge) {
      if (this.config.allowReplay === true) {
        await this.startReplay(bridge);
        return;
      }
      this.warnOnce('replay runner detected but allowReplay is false; ignoring it');
    }
    try {
      await withTimeout(this.prepareCapture(), this.config.setupTimeoutMs ?? 5000);
    } catch (e) {
      this.warnOnce(`capture setup failed; the app runs without capture: ${String(e)}`);
      this.stopRecording('not_recording');
    }
    this.scheduleAnchor();
    this.afterStarted();
  }

  private scheduleAnchor(): void {
    const set = () => {
      if (this.anchor !== null) return;
      this.anchor = this.now();
      this.wallAtAnchor = Date.now();
    };
    if (typeof requestAnimationFrame === 'function' && globalThis.document?.visibilityState !== 'hidden') {
      requestAnimationFrame(() => set());
      setTimeout(set, 1000); // background tabs never paint
    } else {
      setTimeout(set, 0);
    }
  }

  private baseRedactor(remoteKeys: readonly string[] = []): Redactor {
    return new Redactor({
      extraKeys: [...(this.config.redactKeys ?? []), ...remoteKeys],
      extraHeaders: this.config.redactHeaders ?? [],
      patterns: this.config.redactPatterns ?? [],
    });
  }

  private storage(): Promise<SdkStorage> {
    this.storagePromise ??= this.overrides.storage ? Promise.resolve(this.overrides.storage) : openStorage(this.config.storageName ?? 'bugcapsule');
    return this.storagePromise;
  }

  private async prepareCapture(): Promise<void> {
    if (this.config.enabled === false) return;
    const storage = await this.storage();
    const transport =
      this.overrides.transport ?? (this.config.backend ? new BackendTransport(this.config.backend, this.nativeFetch) : null);
    if (transport) {
      this.transport = transport;
      this.outbox = new UploadOutbox(storage, this.config.outboxLimits ?? {}, `bugcapsule:${this.config.storageName ?? 'bugcapsule'}:outbox`);
      await this.outbox.open().catch(() => {});
      this.remote = new RemoteConfigController({
        fetch: () => transport.fetchConfig(),
        storage,
        scope: configScope(this.config.backend),
        onChange: (prev, next) => this.applyRemote(prev, next),
        maxStaleMs: this.config.maxStaleConfigMs ?? 7 * 86_400_000,
        log: (m) => this.warnOnce(m),
      });
      await this.remote.loadCached();
    }
    const cached = this.remote?.current ?? null;
    if (transport && this.config.monitoring !== false && cached?.enabled !== false) this.monitorClient = this.createMonitor(storage, transport);
    this.currentRedactor = this.baseRedactor(cached?.redactKeys ?? []);
    this.captureBodies = (this.config.captureNetworkBodies ?? true) && (cached?.captureNetworkBodies ?? true);
    this.maxCapsuleBytes = cached?.maxCapsuleBytes ?? this.maxCapsuleBytes;
    this.recording = this.decideRecording(cached);

    for (const integration of this.integrations) {
      try {
        await integration.setUp?.(this);
      } catch (e) {
        this.warnOnce(`${integration.name} setup failed: ${String(e)}`);
      }
    }
    this.installLifecycle();
    if (this.monitorClient) {
      this.installMonitoringIntegrations();
      await this.monitorClient.start();
    }
    if (this.recording || this.monitorClient) this.installErrorHandlers();
    if (this.recording) {
      const launch: Checkpoint = {
        kind: 'launch',
        t: this.now(),
        wallClockMs: Date.now(),
        afterSeq: 0,
        data: await this.snapshot('launch'),
      };
      this.recorder = new FlightRecorder(launch, this.config.maxEvents ?? 20_000, this.config.windowMs ?? 300_000);
      this.installCapture();
    }
  }

  private afterStarted(): void {
    if (this.disposed || !this.remote) return;
    void this.remote
      .refresh()
      .then(() => Promise.all([this.flushOutbox(), this.monitorClient?.flushNow()]))
      .catch((e) => this.warnOnce(`startup sync failed: ${String(e)}`));
  }

  private createMonitor(storage: SdkStorage, transport: BugCapsuleTransport): Monitor {
    return new Monitor({
      config: this.config,
      mode: this.mode,
      redactor: () => this.currentRedactor,
      storage,
      transport,
      remote: () => this.remote?.current ?? null,
      uploadsAllowed: () => this.uploadsAllowed,
      ensureFresh: () => this.remote?.ensureFresh() ?? Promise.resolve(),
      refreshRemote: () => void this.remote?.refresh(),
      random: this.sampleRandom,
      log: (m) => this.warnOnce(m),
      sdk: { name: SDK_NAME, version: SDK_VERSION },
      lockName: `bugcapsule:${this.config.storageName ?? 'bugcapsule'}:envelopes`,
      writeCapsule: (capsuleId, note, link) => {
        if (!this.recording || !this.recorder) return false;
        if (link) this.capsuleLinks.set(capsuleId, link);
        this.writeCapsule(this.lastFailure, { note }, capsuleId).catch((e) => this.warnOnce(`capture failed: ${String(e)}`));
        return true;
      },
    });
  }

  /**
   * Monitoring observes fetch/XHR and the History API through the network
   * and history integrations. When the app did not configure them, it sets
   * up its own instances on a session view that never records.
   */
  private installMonitoringIntegrations(): void {
    const networks = this.integrations.filter((i): i is NetworkIntegration => i instanceof NetworkIntegration);
    const fetchCovered = networks.some((n) => n.coversFetch);
    const xhrCovered = networks.some((n) => n.coversXhr);
    const view = this.monitoringView();
    const extra: BugCapsuleIntegration[] = [];
    if (!fetchCovered || !xhrCovered) extra.push(new NetworkIntegration({ fetch: !fetchCovered, xhr: !xhrCovered }, 'monitoring.network'));
    if (!this.integrations.some((i) => i instanceof HistoryIntegration)) extra.push(new HistoryIntegration());
    for (const integration of extra) {
      try {
        void integration.setUp?.(view);
        this.monitoringIntegrations.push(integration);
      } catch (e) {
        this.warnOnce(`monitoring ${integration.name} setup failed: ${String(e)}`);
      }
    }
  }

  private monitoringView(): BugCapsuleSession {
    const rt = this;
    return {
      get config() {
        return rt.config;
      },
      get mode() {
        return rt.mode;
      },
      isRecording: false,
      isReplaying: false,
      get redactor() {
        return rt.redactor;
      },
      captureNetworkBodies: false,
      get maxBodyBytes() {
        return rt.maxBodyBytes;
      },
      now: () => rt.now(),
      record: () => {},
      replay: null,
      reportError: (e) => rt.reportError(e),
      nativeFetch: rt.nativeFetch,
      get monitor() {
        return rt.monitor;
      },
    };
  }

  private effectiveRate(remote: RemoteCaptureConfig | null): number {
    const cap = Math.min(1, Math.max(0, this.config.productionSampleRate ?? 0.1));
    const remoteRate = remote?.sampleRate ?? 1;
    return remoteRate < cap ? remoteRate : cap;
  }

  private decideRecording(remote: RemoteCaptureConfig | null): boolean {
    if (this.config.enabled === false || (remote && !remote.enabled)) {
      this.notRecording = 'disabled';
      return false;
    }
    if (this.mode !== 'production') return true;
    this.sessionRate = this.effectiveRate(remote);
    const sampled = this.sampleRandom() < this.sessionRate;
    if (!sampled) this.notRecording = 'sampled_out';
    return sampled;
  }

  private installCapture(): void {
    if (this.config.capturePointers !== false) this.installPointers();
    this.checkpointTimer = setInterval(() => void this.periodicCheckpoint(), this.config.checkpointIntervalMs ?? 30_000);
  }

  private installErrorHandlers(): void {
    if (typeof addEventListener !== 'function') return;
    const onError = (e: ErrorEvent) =>
      this.guard(() =>
        e.error !== undefined && e.error !== null
          ? this.onError(e.error, { type: 'onerror', handled: false })
          : this.onError(new ErrorLike(e.message || 'Script error.'), { type: 'onerror', handled: false }, {}, true),
      );
    const onRejection = (e: PromiseRejectionEvent) => this.guard(() => this.onError(e.reason, { type: 'unhandledrejection', handled: false }));
    addEventListener('error', onError);
    addEventListener('unhandledrejection', onRejection);
    this.cleanups.push(() => {
      removeEventListener('error', onError);
      removeEventListener('unhandledrejection', onRejection);
    });
  }

  private installLifecycle(): void {
    if (typeof document === 'undefined') return;
    const onVisibility = () =>
      this.guard(() => {
        const visible = document.visibilityState === 'visible';
        this.record('lifecycle', { state: visible ? 'resumed' : 'hidden' });
        if (visible) {
          this.remote?.onVisible();
          void this.flushOutbox();
        } else {
          this.remote?.onHidden();
        }
      });
    const onPageHide = () => this.guard(() => this.record('lifecycle', { state: 'paused' }));
    const onPageShow = (e: PageTransitionEvent) => this.guard(() => e.persisted && this.record('lifecycle', { state: 'resumed' }));
    document.addEventListener('visibilitychange', onVisibility);
    addEventListener('pagehide', onPageHide);
    addEventListener('pageshow', onPageShow);
    this.cleanups.push(() => {
      document.removeEventListener('visibilitychange', onVisibility);
      removeEventListener('pagehide', onPageHide);
      removeEventListener('pageshow', onPageShow);
    });
  }

  private sensitive(el: Element | null): boolean {
    if (!el) return false;
    if (el instanceof HTMLInputElement && el.type === 'password') return true;
    const selector = this.config.sensitiveSelector ?? '[data-bugcapsule-sensitive]';
    try {
      return el.closest(selector) !== null;
    } catch {
      return false;
    }
  }

  private targetOf(el: Element | null): Record<string, unknown> | undefined {
    if (!el) return undefined;
    const target: Record<string, unknown> = { tag: el.tagName.toLowerCase() };
    const actionEl = el.closest('[data-bugcapsule-action]');
    const action = actionEl?.getAttribute('data-bugcapsule-action');
    if (action) {
      target.action = action;
      target.selector = `[data-bugcapsule-action="${action.replace(/["\\]/g, '\\$&')}"]`;
    } else {
      const withId = el.closest('[data-testid],[id]');
      const testId = withId?.getAttribute('data-testid');
      if (testId) target.selector = `[data-testid="${testId.replace(/["\\]/g, '\\$&')}"]`;
      else if (withId?.id) target.selector = `#${typeof CSS !== 'undefined' ? CSS.escape(withId.id) : withId.id}`;
    }
    if (!this.sensitive(el) && !(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) {
      const text = ((actionEl ?? el) as HTMLElement).innerText?.trim().replace(/\s+/g, ' ');
      if (text) target.text = this.currentRedactor.scrubText(cut(text, 40));
    }
    return target;
  }

  private installPointers(): void {
    if (typeof addEventListener !== 'function') return;
    const handler = (e: PointerEvent) =>
      this.guard(() => {
        const phase = e.type === 'pointerdown' ? 'down' : e.type === 'pointerup' ? 'up' : e.type === 'pointercancel' ? 'cancel' : 'move';
        if (phase === 'move' && !this.pressed.has(e.pointerId)) return; // hover is not recorded
        if (phase === 'down') this.pressed.add(e.pointerId);
        if (phase === 'up' || phase === 'cancel') this.pressed.delete(e.pointerId);
        this.record('pointer', {
          phase,
          pointer: e.pointerId,
          x: Math.round(e.clientX * 100) / 100,
          y: Math.round(e.clientY * 100) / 100,
          kind: e.pointerType || 'mouse',
          ...(e.buttons !== 1 && phase !== 'up' ? { buttons: e.buttons } : {}),
          ...(phase === 'down' ? { target: this.targetOf(e.target instanceof Element ? e.target : null) } : {}),
        });
      });
    const opts = { capture: true, passive: true } as const;
    for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'] as const) addEventListener(t, handler, opts);
    this.cleanups.push(() => {
      for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'] as const) removeEventListener(t, handler, opts);
    });
  }

  /** SDK work triggered from the app's own callbacks must never throw into them. */
  private guard(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.warnOnce(`internal error ignored: ${String(e)}`);
    }
  }

  private async snapshot(kind: CheckpointKind): Promise<Record<string, unknown>> {
    const data: Record<string, unknown> = {};
    for (const integration of this.integrations) {
      try {
        const value = await integration.snapshot?.(kind);
        if (value === null || value === undefined) continue;
        let clean: unknown = this.currentRedactor.redactJson(value);
        const hook = this.config.beforeCheckpoint;
        if (hook) clean = hook(integration.name, clean);
        if (clean !== null && clean !== undefined) data[integration.name] = clean;
      } catch (e) {
        this.warnOnce(`${integration.name} snapshot failed: ${String(e)}`);
      }
    }
    return data;
  }

  private async periodicCheckpoint(): Promise<void> {
    const recorder = this.recorder;
    if (!this.recording || !recorder || this.checkpointBusy) return;
    this.checkpointBusy = true;
    const epoch = this.captureEpoch;
    try {
      const t = this.now();
      const afterSeq = recorder.lastSeq;
      const data = await this.snapshot('periodic');
      if (epoch !== this.captureEpoch || recorder !== this.recorder) return;
      recorder.addCheckpoint({ kind: 'periodic', t, wallClockMs: Date.now(), afterSeq, data });
    } catch (e) {
      this.warnOnce(`periodic checkpoint failed: ${String(e)}`);
    } finally {
      this.checkpointBusy = false;
    }
  }

  // --------------------------------------------------------------- failures

  /**
   * A failure: recorded (and maybe captured) for capsules, and sent as an
   * error event; when a capsule is written for it, the event carries its
   * `capsuleId` and the capsule `manifest.monitoring` (monitoring-v1 §4.3).
   * A thrown value seen before (this path or the Sentry companion) is not
   * recorded again. `synthetic`: `error` was made up from an ErrorEvent
   * without `error`, so it is matched by signature.
   */
  private onError(error: unknown, mechanism: Mechanism = { type: 'manual', handled: true }, context: CaptureContext = {}, synthetic = false): void {
    const prior = this.handledFor(error, synthetic);
    if (prior) {
      this.monitorFailure(prior, error, mechanism, context);
      return;
    }
    if (this.config.ignoreError?.(error)) return;
    const failure = this.failureOf(error);
    const entry = this.remember(error, synthetic, failure, this.decideFailure(failure));
    this.monitorFailure(entry, error, mechanism, context);
  }

  private failureOf(error: unknown): FailureRecord {
    return exceptionFailure(error, this.now(), (s) => this.currentRedactor.scrubText(s));
  }

  private monitorFailure(entry: HandledFailure, error: unknown, mechanism: Mechanism, context: CaptureContext): void {
    const monitor = this.monitorClient;
    if (!monitor || this.engine || entry.monitored || !entry.failure) return;
    entry.monitored = true;
    const eventId = monitor.captureError(error, { ...context, mechanism }, { capsuleId: entry.capsuleId });
    this.linkFailure(entry.failure, entry.capsuleId, eventId);
  }

  private isObjectKey(error: unknown, synthetic: boolean): error is object {
    return !synthetic && (typeof error === 'object' || typeof error === 'function') && error !== null;
  }

  private handledFor(error: unknown, synthetic: boolean, signature?: string): HandledFailure | undefined {
    if (this.isObjectKey(error, synthetic)) return this.handledErrors.get(error);
    const key = signature ?? this.failureOf(error).signature;
    const hit = this.handledValues.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > PRIMITIVE_WINDOW_MS) {
      this.handledValues.delete(key);
      return undefined;
    }
    return hit.entry;
  }

  private remember(error: unknown, synthetic: boolean, failure: FailureRecord | null, outcome: FailureOutcome, signature?: string): HandledFailure {
    const entry: HandledFailure = { failure, capsuleId: outcome.capsuleId, capture: outcome.capture, monitored: false, sentryLinked: false };
    if (this.isObjectKey(error, synthetic)) {
      this.handledErrors.set(error, entry);
    } else {
      const key = signature ?? failure?.signature ?? this.failureOf(error).signature;
      if (this.handledValues.size >= 50) this.handledValues.delete(this.handledValues.keys().next().value!);
      this.handledValues.set(key, { entry, at: Date.now() });
    }
    return entry;
  }

  /**
   * @internal Sentry companion: the outcome for the failure behind a Sentry
   * error event. A failure BugCapsule has not seen is handled here like
   * `reportError` but without a BugCapsule monitoring event. `link` goes to
   * the capsule's `manifest.links.sentry` (one Sentry event per capsule).
   */
  sentryEvent(input: ExternalFailure): FailureOutcome {
    if (!input.hasException) return { capsuleId: null, capture: this.engine ? 'replaying' : 'not_a_failure' };
    const fromValue = input.hasError;
    const synthetic = !fromValue;
    const failure = fromValue
      ? this.failureOf(input.error)
      : this.failureOf(new ErrorLike(input.fallback?.value ?? '', input.fallback?.type));
    let entry = this.handledFor(input.error, synthetic, failure.signature);
    if (!entry) {
      if (this.config.ignoreError?.(input.error)) {
        entry = this.remember(input.error, synthetic, null, { capsuleId: null, capture: 'not_a_failure' }, failure.signature);
      } else {
        entry = this.remember(input.error, synthetic, failure, this.decideFailure(failure), failure.signature);
      }
    }
    if (this.engine) return { capsuleId: null, capture: 'replaying' };
    if (!entry.capsuleId) return { capsuleId: null, capture: entry.capture };
    if (entry.sentryLinked) return { capsuleId: null, capture: 'duplicate' };
    entry.sentryLinked = true;
    if (input.link && !this.writtenCapsules.has(entry.capsuleId)) this.sentryLinks.set(entry.capsuleId, input.link);
    return { capsuleId: entry.capsuleId, capture: 'scheduled' };
  }

  fail(assertionId: string, message = ''): void {
    const failure = assertionFailure(assertionId, message, this.now(), (s) => this.currentRedactor.scrubText(s));
    const capsuleId = this.handleFailure(failure);
    const monitor = this.monitorClient;
    if (!monitor || this.engine) return;
    this.linkFailure(failure, capsuleId, monitor.captureAssertion(assertionId, failure.message, capsuleId));
  }

  private linkFailure(failure: FailureRecord, capsuleId: string | null, eventId: string | null): void {
    if (!eventId || !this.monitorClient) return;
    const link = this.monitorClient.linkFor(eventId);
    this.failureLinks.set(failure.signature, link);
    if (capsuleId) this.capsuleLinks.set(capsuleId, link);
  }

  /** Returns the id of the capsule it scheduled for this failure, if any. */
  handleFailure(failure: FailureRecord): string | null {
    return this.decideFailure(failure).capsuleId;
  }

  private decideFailure(failure: FailureRecord): FailureOutcome {
    if (this.engine) {
      this.engine.onFailure(failure);
      return { capsuleId: null, capture: 'replaying' };
    }
    if (!this.recording) return { capsuleId: null, capture: this.notRecording };
    const { stack: _stack, ...withoutStack } = failure;
    this.record('failure', withoutStack as unknown as Record<string, unknown>);
    this.lastFailure = failure;
    if (this.seenSignatures.has(failure.signature)) return { capsuleId: null, capture: 'duplicate' };
    this.seenSignatures.add(failure.signature);
    if (this.config.autoCaptureOnFailure === false) return { capsuleId: null, capture: 'disabled' };
    if (this.capsulesWritten >= (this.config.maxCapsulesPerSession ?? 3)) return { capsuleId: null, capture: 'limit' };
    if (this.capturedSignatures.has(failure.signature)) return { capsuleId: null, capture: 'duplicate' };
    this.capturedSignatures.add(failure.signature);
    const capsuleId = uuidV4();
    // Let the failure settle (follow-up events) before writing.
    setTimeout(() => {
      this.writeCapsule(failure, {}, capsuleId).then(
        (r) => r && console.debug(`[bugcapsule] captured ${r.capsuleId} (${r.eligibility.status})`),
        (e) => this.warnOnce(`capture failed: ${String(e)}`),
      );
    }, 300);
    return { capsuleId, capture: 'scheduled' };
  }

  // ---------------------------------------------------------------- capsule

  async writeCapsule(failure: FailureRecord | null, labels: Record<string, string> = {}, capsuleId: string = uuidV4()): Promise<CaptureResult | null> {
    const recorder = this.recorder;
    const link = this.capsuleLinks.get(capsuleId) ?? (failure ? this.failureLinks.get(failure.signature) : undefined);
    const sentry = this.sentryLinks.get(capsuleId);
    this.capsuleLinks.delete(capsuleId);
    this.sentryLinks.delete(capsuleId);
    this.writtenCapsules.add(capsuleId);
    if (!this.recording || !recorder) return null;
    this.capsulesWritten++;
    const window = recorder.window();
    const anchor = this.anchor ?? this.now();
    const wallAtAnchor = this.wallAtAnchor ?? window.checkpoint.wallClockMs + anchor - window.checkpoint.t;

    const eligibility = new EligibilityBuilder();
    if (!this.config.gitSha) eligibility.missing('build.gitSha', 'gitSha was not set at build time (inject BUGCAPSULE_GIT_SHA)');
    else if (this.config.gitDirty === true) eligibility.missing('build.gitSha', 'built from a tree with uncommitted changes');
    if (!failure) eligibility.missing('failure.assertion', 'manual capture without a failure assertion', true);
    if (recorder.rewriteDropped > 0) {
      eligibility.missing('events.redaction', `${recorder.rewriteDropped} buffered events were dropped when redaction rules changed`);
    }
    if (window.hasGap) {
      eligibility.missing('events.window', 'events between the checkpoint and the window were evicted; raise windowMs or maxEvents');
    }
    for (const integration of this.integrations) {
      try {
        integration.describeEligibility?.(eligibility, window);
      } catch (e) {
        eligibility.missing(`integration.${integration.name}`, `eligibility check failed: ${String(e)}`);
      }
    }

    const events: CapsuleEvent[] = window.events.map((e) => ({ ...e, t: e.t - anchor }));
    const capabilities: Record<string, string> = {
      'input.pointer.capture': this.config.capturePointers === false ? 'unsupported' : 'supported',
      'input.pointer.replay': 'supported',
      'input.semantic.replay': 'supported',
      'text.replay': 'supported',
      'lifecycle.replay': 'partial',
      'errors.uncaught': 'supported',
      'clock.virtual': 'explicit',
      'random.seeded': 'explicit',
    };
    for (const i of this.integrations) Object.assign(capabilities, i.capabilities ?? {});
    const nav = globalThis.navigator;
    const capsule: Capsule = {
      format: 'bugcapsule.capsule',
      specVersion: 1,
      manifest: {
        capsuleId,
        createdAt: new Date().toISOString(),
        mode: this.mode,
        app: {
          id: this.config.appId ? cut(this.config.appId, 200) : null,
          name: this.config.appName ? cut(this.config.appName, 200) : null,
          version: cut(this.config.appVersion, 200),
          build: cut(this.config.appBuild, 200),
          flavor: this.config.flavor ? cut(this.config.flavor, 200) : null,
        },
        source: { gitSha: this.config.gitSha ?? null, dirty: this.config.gitDirty ?? null },
        sdk: { name: SDK_NAME, version: SDK_VERSION },
        stateSchemaVersion: this.config.stateSchemaVersion ?? 1,
        platform: {
          os: 'web',
          osVersion: cut(browserVersion(), 200),
          locale: cut(nav?.language ?? '', 100),
          screen: {
            width: globalThis.innerWidth ?? 0,
            height: globalThis.innerHeight ?? 0,
            pixelRatio: globalThis.devicePixelRatio ?? 1,
          },
          userAgent: cut(this.currentRedactor.scrubText(nav?.userAgent ?? ''), 500),
        },
        session: {
          id: this.sessionId,
          startedAt: this.startedAt.toISOString(),
          wallClockAtAnchorMs: Math.round(wallAtAnchor),
          seed: this.seed,
          durationMs: this.now() - anchor,
        },
        failure: failure ? stripUndefined(shiftFailure(failure, anchor)) : null,
        eligibility: eligibility.build(),
        integrations: this.integrations.map((i) => i.name),
        stats: { eventCount: events.length, droppedEvents: window.droppedEvents, checkpointKind: window.checkpoint.kind },
        labels: this.sanitizeLabels({ ...(this.config.labels ?? {}), ...labels }),
        ...(this.currentRedactor.extraKeys.length || this.currentRedactor.extraHeaders.length
          ? { redaction: { extraKeys: [...this.currentRedactor.extraKeys], extraHeaders: [...this.currentRedactor.extraHeaders] } }
          : {}),
        runtime: { name: 'web', version: cut(browserVersion(), 200), language: 'javascript', ...(this.frameworks.size ? { frameworks: [...this.frameworks] } : {}) },
        capabilities,
        ...(link ? { monitoring: { ...link } } : {}),
        ...(sentry ? { links: { sentry: { ...sentry } } } : {}),
      },
      checkpoint: { ...window.checkpoint, t: window.checkpoint.t - anchor },
      events,
    };

    // Never queue what a reader would reject; keep it locally for inspection.
    const problem = validateCapsuleDocument(capsuleToJson(capsule));
    const bytes = await encodeCapsule(capsule);
    if (this.killed) return null;
    const storage = await this.storage();
    await saveCapture(storage, capsule.manifest.capsuleId, bytes).catch((e) => this.warnOnce(`could not save capture: ${String(e)}`));
    if (this.killed) return null;

    let upload: UploadResult | null = null;
    const outbox = this.outbox;
    if (problem !== null) {
      this.warnOnce(`capsule ${capsule.manifest.capsuleId} failed validation, not uploaded: ${problem}`);
      if (outbox) upload = { status: 'rejected', message: `invalid capsule: ${problem}` };
    } else if (outbox) {
      if (bytes.length > this.maxCapsuleBytes) {
        upload = { status: 'rejected', message: `capsule is ${bytes.length} bytes, limit ${this.maxCapsuleBytes}` };
      } else if (!(await outbox.enqueue(capsule.manifest.capsuleId, bytes))) {
        upload = { status: 'rejected', message: 'not queued (outbox limit or storage error)' };
      } else if (this.killed) {
        await outbox.purge().catch(() => 0);
        return null;
      } else {
        upload = await this.flushOutbox(capsule.manifest.capsuleId);
      }
    }
    return { capsuleId: capsule.manifest.capsuleId, eligibility: capsule.manifest.eligibility, failureSignature: failure?.signature ?? null, upload, bytes };
  }

  private sanitizeLabels(labels: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(labels).slice(0, 100)) {
      out[cut(k, 100)] = this.currentRedactor.isSensitiveKey(k) ? Redactor.placeholder : cut(this.currentRedactor.scrubText(String(v)), 2000);
    }
    return out;
  }

  private get uploadsAllowed(): boolean {
    return !this.disposed && (this.remote?.uploadsAllowed ?? false);
  }

  /** Uploads queued capsules; refreshes a stale remote config first so a kill switch is seen before sending. */
  async flushOutbox(onlyId?: string): Promise<UploadResult | null> {
    const outbox = this.outbox;
    const transport = this.transport;
    const controller = this.remote;
    if (!outbox || !transport || !controller || this.disposed) return null;
    try {
      await controller.ensureFresh();
      if (!this.uploadsAllowed) return onlyId ? { status: 'retryLater', message: 'waiting for remote config' } : null;
      return await outbox.flush({
        upload: async (bytes) => {
          const result = await transport.upload(bytes);
          if (result.message === 'capture_disabled') void controller.refresh();
          return result;
        },
        allowed: () => this.uploadsAllowed,
        ...(onlyId ? { onlyId } : {}),
      });
    } catch (e) {
      this.warnOnce(`outbox flush failed: ${String(e)}`);
      return null;
    }
  }

  async pendingUploads(): Promise<number> {
    return this.outbox ? (await this.outbox.entries().catch(() => [])).length : 0;
  }

  async savedCaptures(): Promise<{ capsuleId: string; savedAt: number; bytes: Uint8Array }[]> {
    const storage = await this.storage();
    const list = await storage.list('captures').catch(() => []);
    return list.reverse().map((r) => ({ capsuleId: r.capsuleId, savedAt: r.enqueuedAt, bytes: r.bytes }));
  }

  // ---------------------------------------------------------- remote config

  private applyRemote(_previous: RemoteCaptureConfig | null, next: RemoteCaptureConfig): void {
    this.monitorClient?.applyRemote(next);
    this.maxCapsuleBytes = next.maxCapsuleBytes;
    if (!next.enabled) {
      this.disableCapture();
      return;
    }
    if (this.mode === 'production' && this.recording) {
      const rate = this.effectiveRate(next);
      if (rate < this.sessionRate) {
        const keep = this.sessionRate <= 0 ? 0 : rate / this.sessionRate;
        this.sessionRate = rate;
        if (this.sampleRandom() >= keep) this.stopRecording('sampled_out');
      }
    }
    const bodies = (this.config.captureNetworkBodies ?? true) && next.captureNetworkBodies;
    if (this.captureBodies && !bodies) this.recorder?.rewrite({ event: (e) => (e.type === 'http' ? { ...e, data: withoutBodies(e.data) } : e) });
    this.captureBodies = bodies;
    const wanted = [...(this.config.redactKeys ?? []), ...next.redactKeys];
    if (wanted.join('\u0000') !== this.currentRedactor.extraKeys.join('\u0000')) {
      this.currentRedactor = this.baseRedactor(next.redactKeys);
      try {
        this.recorder?.rewrite({
          // Request keys were computed with the old rules; drop buffered exchanges.
          event: (e) => {
            if (e.type === 'http') return null;
            const data = this.sanitizeEvent(e.type, e.data, false);
            return data ? { ...e, data } : null;
          },
          checkpoint: (c) => ({ ...c, data: this.currentRedactor.redactJson(c.data) }),
        });
      } catch {
        this.stopRecording('not_recording');
      }
    }
  }

  private stopRecording(reason: 'not_recording' | 'sampled_out' | 'disabled'): void {
    this.captureEpoch++;
    this.recording = false;
    this.notRecording = reason;
    this.recorder = null;
    if (this.checkpointTimer) clearInterval(this.checkpointTimer);
    this.checkpointTimer = null;
  }

  /** Kill switch: stop, drop the buffer, delete queued and saved captures. */
  private disableCapture(): void {
    this.killed = true;
    this.stopRecording('disabled');
    void this.outbox?.purge().catch(() => 0);
    void this.storage()
      .then((s) => s.update('captures', (records) => ({ remove: records.map((r) => r.id), result: undefined })))
      .catch(() => {});
  }

  // ----------------------------------------------------------------- replay

  private async startReplay(bridge: ReplayBridge): Promise<void> {
    const errorReport = (outcome: ReplayReport['outcome'], message: string, settings?: ReplaySettings): ReplayReport => ({
      outcome,
      attempt: settings?.attempt ?? 1,
      durationMs: 0,
      strategy: settings?.strategy ?? 'auto',
      expectedSignature: null,
      observed: null,
      otherFailures: [],
      divergences: [],
      eventsDispatched: 0,
      eventsExpected: null,
      fixturesServed: 0,
      compressedMs: 0,
      gapsCompressed: 0,
      buildGitSha: this.config.gitSha ?? null,
      message,
      ...(settings?.attemptId ? { attemptId: settings.attemptId } : {}),
      runtime: 'web',
    });
    let capsule: Capsule;
    let settings: ReplaySettings;
    try {
      const loaded = await bridge.load();
      settings = replaySettingsFromJson(loaded.settings);
      try {
        capsule = capsuleFromJson(loaded.capsule);
      } catch (e) {
        await bridge.report(errorReport(e instanceof CapsuleFormatError ? 'incompatible' : 'error', `could not load capsule: ${String(e)}`, settings));
        return;
      }
    } catch (e) {
      await bridge.report(errorReport('error', `could not load replay request: ${String(e)}`)).catch(() => {});
      return;
    }
    const runtime = runtimeOf(capsule.manifest);
    if (runtime !== 'web') {
      await bridge.report({ ...errorReport('incompatible', `capsule was captured by the ${runtime} runtime`, settings), divergences: [{ type: 'runtime.mismatch', detail: runtime }] });
      return;
    }
    if ((capsule.manifest.stateSchemaVersion ?? 1) !== (this.config.stateSchemaVersion ?? 1) && capsule.checkpoint.kind === 'periodic') {
      await bridge.report({
        ...errorReport('incompatible', `state schema v${capsule.manifest.stateSchemaVersion} captured, app is v${this.config.stateSchemaVersion ?? 1}`, settings),
        expectedSignature: capsule.manifest.failure?.signature ?? null,
      });
      return;
    }

    const engine = (this.engine = new ReplayEngine(capsule, settings, this.actions, bridge, this.config.gitSha ?? null));
    this.seededRandom = mulberry32(capsule.manifest.session.seed);
    this.currentRedactor = new Redactor({
      extraKeys: new Set([...(this.config.redactKeys ?? []), ...(capsule.manifest.redaction?.extraKeys ?? [])]),
      extraHeaders: new Set([...(this.config.redactHeaders ?? []), ...(capsule.manifest.redaction?.extraHeaders ?? [])]),
      patterns: this.config.redactPatterns ?? [],
    });
    engine.precheck();
    this.installErrorHandlers();

    const names = new Set(this.integrations.map((i) => i.name));
    for (const name of capsule.manifest.integrations ?? []) {
      if (!names.has(name)) engine.diverge('integration.missing', `${name} was used when capturing but is not set up`);
    }
    for (const integration of this.integrations) {
      try {
        await integration.setUp?.(this);
      } catch (e) {
        engine.diverge(`restore.${integration.name}`, `setup failed: ${String(e)}`);
      }
    }
    for (const name of Object.keys(capsule.checkpoint.data)) {
      if (!names.has(name)) engine.diverge('restore.missingIntegration', name);
    }
    for (const integration of this.integrations) {
      const data = capsule.checkpoint.data[integration.name];
      if (data === undefined && !(integration instanceof HistoryIntegration)) continue;
      try {
        await integration.restore?.(data, this);
      } catch (e) {
        engine.diverge(`restore.${integration.name}`, String(e));
      }
    }

    engine.beforeReport = () => this.state.reportUnrestored();
    const go = () => {
      engine
        .run()
        .then((report) => bridge.report(report))
        .catch((e) => bridge.report({ ...errorReport('error', `replay crashed: ${String(e)}`, settings), expectedSignature: capsule.manifest.failure?.signature ?? null }));
    };
    // Start after the app's first frame, like capture's anchor.
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(go, 0));
    else setTimeout(go, 0);
  }

  // ---------------------------------------------------------------- history

  route(location: string, source?: string, action?: string, routeName?: string): void {
    if (!this.engine) this.monitorClient?.navigation(location, source ?? 'app', action, routeName);
    const history = this.integrations.find((i): i is HistoryIntegration => i instanceof HistoryIntegration);
    if (history) history.route(location, source, action);
    else this.record('route', { location: this.currentRedactor.redactUrl(location), ...(source ? { source } : {}), ...(action ? { action } : {}) });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.stopRecording('disabled');
    this.remote?.dispose();
    this.monitorClient?.dispose();
    for (const c of this.cleanups.reverse()) c();
    for (const i of [...this.monitoringIntegrations.reverse(), ...this.integrations]) i.dispose?.();
    await this.outbox?.close();
  }
}

class ErrorLike extends Error {
  override name: string;
  constructor(message: string, name?: string) {
    super(message);
    this.name = name || 'Error';
  }
}

function withoutBodies(data: Record<string, unknown>): Record<string, unknown> {
  const d: Record<string, unknown> = { ...data, requestBody: null, responseBody: null, bodyEncoding: 'omitted' };
  if (d.requestEncoding !== undefined && d.requestEncoding !== null && d.requestEncoding !== 'json') d.requestEncoding = 'omitted';
  return d;
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
