import { cut, utf8Decode, utf8Encode } from '../core/json.js';
import type { CaptureMode } from '../core/model.js';
import type { Redactor } from '../core/redaction.js';
import type { BugCapsuleTransport, RemoteCaptureConfig } from '../remote-config.js';
import type { SdkStorage } from '../storage/idb.js';
import { ENVELOPE_STORE, UploadOutbox } from '../storage/outbox.js';
import type { BugCapsuleConfig, UploadResult } from '../types.js';
import { BrowserMetrics } from './browser-tracing.js';
import { defaultContexts } from './context.js';
import { debugImagesFor } from './debug-ids.js';
import { eventFrames, eventTitle, exceptionValues, fitItem, normalizeEvent, normalizeTags, redactItem, toJsonSafe } from './event.js';
import { iso, traceId as newTraceId, uuid4 } from './ids.js';
import { Scope } from './scope.js';
import { SessionTracker } from './session.js';
import { framesOf, type InAppOptions } from './stack.js';
import {
  baggageFor,
  compileTargets,
  epochNow,
  newPropagationContext,
  parameterizePath,
  parseBaggage,
  parseTraceparent,
  sampleTrace,
  shouldPropagate,
  Span,
  Transaction,
  type PropagationContext,
  type SpanHost,
  type SpanOptions,
  type TransactionOptions,
} from './tracing.js';
import type {
  Breadcrumb,
  CaptureContext,
  EnvelopeItem,
  EventHint,
  EventPayload,
  FeedbackInput,
  FeedbackPayload,
  HttpObservation,
  Mechanism,
  MonitorHooks,
  MonitoringLink,
  SeverityLevel,
  TransactionPayload,
  User,
} from './types.js';

/** What the monitoring client needs from the runtime. */
export interface MonitorDeps {
  config: Readonly<BugCapsuleConfig>;
  mode: CaptureMode;
  redactor(): Redactor;
  storage: SdkStorage;
  transport: BugCapsuleTransport | null;
  remote(): RemoteCaptureConfig | null;
  /** A fresh, enabled remote config allows sending (the capsule rule). */
  uploadsAllowed(): boolean;
  ensureFresh(): Promise<void>;
  refreshRemote(): void;
  random(): number;
  log(message: string): void;
  sdk: { name: string; version: string };
  lockName: string;
  /** Writes a capsule with this id now, when a capsule session is recording; false otherwise. */
  writeCapsule?(capsuleId: string, note: string, link: MonitoringLink | null): boolean;
  /** Epoch ms (tests). */
  now?: () => number;
  /** Timeline (tests); default `globalThis.performance`. */
  performance?: Pick<Performance, 'getEntriesByType' | 'timeOrigin'>;
}

const IDLE_TIMEOUT_MS = 1000;
const FINAL_TIMEOUT_MS = 30_000;
const INSTALL_ID_KEY = 'monitoring.installId';

const CONSOLE_LEVELS: Record<string, SeverityLevel> = { debug: 'debug', info: 'info', log: 'info', warn: 'warning', error: 'error' };

function formatArgs(args: unknown[]): string {
  return cut(
    args
      .map((a) => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return `${a.name}: ${a.message}`;
        try {
          return JSON.stringify(toJsonSafe(a, 3, 20));
        } catch {
          return String(a);
        }
      })
      .join(' '),
    1000,
  );
}

/** `button#go[data-bugcapsule-action="cart.checkout"]`: a click target without its text (privacy). */
export function describeElement(el: Element): string {
  let s = el.tagName.toLowerCase();
  if (el.id) s += `#${el.id}`;
  const action = el.closest('[data-bugcapsule-action]')?.getAttribute('data-bugcapsule-action');
  const testId = el.getAttribute('data-testid');
  if (action) s += `[data-bugcapsule-action="${action}"]`;
  else if (testId) s += `[data-testid="${testId}"]`;
  else if (typeof el.className === 'string' && el.className.trim()) s += `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}`;
  return cut(s, 200);
}

/**
 * The monitoring client (monitoring-v1): scope, breadcrumbs, error events,
 * release-health sessions, tracing and feedback, sent as envelopes through
 * their own IndexedDB outbox. One per page; created by the runtime unless
 * monitoring is off, never during replay.
 */
export class Monitor implements MonitorHooks, SpanHost {
  private readonly scopes: Scope[] = [new Scope()];
  private breadcrumbs: Breadcrumb[] = [];
  private lastId: string | null = null;
  private lastFingerprint: string | null = null;
  readonly outbox: UploadOutbox;
  readonly sessions: SessionTracker;
  readonly metrics: BrowserMetrics;
  private propagation: PropagationContext = newPropagationContext();
  /** Pageload/navigation/interaction transaction currently collecting spans. */
  private idle: Transaction | null = null;
  private idlePath: string | null = null;
  private lastLocation: string | null = null;
  private lastPath: string | null = null;
  private routeName: string | null = null;
  private installId: string = uuid4();
  private readonly contexts: Record<string, Record<string, unknown>>;
  private enabled = true;
  private killed = false;
  private disposed = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly cleanups: (() => void)[] = [];
  private inConsole = false;
  private readonly targetsCache = new WeakMap<object, (string | RegExp)[]>();

  constructor(private readonly deps: MonitorDeps) {
    const c = deps.config;
    this.outbox = new UploadOutbox(deps.storage, c.envelopeOutboxLimits ?? {}, deps.lockName, () => this.now(), deps.random, ENVELOPE_STORE);
    this.sessions = new SessionTracker({
      now: () => this.now(),
      did: () => this.scope.user?.id ?? this.installId,
      release: this.release,
      environment: this.environment,
    });
    this.metrics = new BrowserMetrics(() => deps.redactor(), deps.performance ?? globalThis.performance, c.enableWebVitals !== false);
    this.contexts = defaultContexts();
    const app: Record<string, unknown> = { appVersion: c.appVersion, appBuild: c.appBuild };
    if (c.appId) app.appId = c.appId;
    if (c.appName) app.appName = c.appName;
    if (c.flavor) app.flavor = c.flavor;
    this.contexts.app = app;
    this.applyRemote(deps.remote());
  }

  // ------------------------------------------------------------- settings

  now(): number {
    return this.deps.now ? this.deps.now() : epochNow();
  }

  get release(): string | undefined {
    return this.deps.config.release ? cut(this.deps.config.release, 200) : undefined;
  }

  get environment(): string {
    const e = this.deps.config.environment;
    if (e) return cut(e, 64);
    return this.deps.mode === 'qa' ? 'qa' : this.deps.mode === 'debug' ? 'development' : 'production';
  }

  /** Envelopes are being produced (not off remotely, not killed, not disposed). */
  get active(): boolean {
    return this.enabled && !this.killed && !this.disposed;
  }

  private get maxBreadcrumbs(): number {
    return Math.max(0, Math.min(100, this.deps.config.maxBreadcrumbs ?? 100, this.deps.remote()?.maxBreadcrumbs ?? 100));
  }

  private get errorSampleRate(): number {
    return Math.max(0, Math.min(1, this.deps.config.errorSampleRate ?? 1, this.deps.remote()?.errorSampleRate ?? 1));
  }

  private get tracesRate(): number {
    const remote = this.deps.remote()?.tracesSampleRate;
    return remote ?? this.deps.config.tracesSampleRate ?? 0;
  }

  private get sessionsEnabled(): boolean {
    return this.deps.config.enableAutoSessionTracking !== false && this.deps.remote()?.sessionTracking !== false;
  }

  private get targets(): (string | RegExp)[] | null {
    const remote = this.deps.remote()?.tracePropagationTargets;
    const list = remote ?? this.deps.config.tracePropagationTargets ?? null;
    if (list === null) return null;
    let compiled = this.targetsCache.get(list);
    if (!compiled) {
      compiled = compileTargets(list);
      this.targetsCache.set(list, compiled);
    }
    return compiled;
  }

  private get inAppOptions(): InAppOptions {
    return {
      origin: globalThis.location?.origin ?? null,
      ...(this.deps.config.inAppIncludes ? { inAppIncludes: this.deps.config.inAppIncludes } : {}),
      ...(this.deps.config.inAppExcludes ? { inAppExcludes: this.deps.config.inAppExcludes } : {}),
    };
  }

  /** Remote config changed: `enabled: false` stops everything, `monitoringEnabled: false` stops envelopes. */
  applyRemote(next: RemoteCaptureConfig | null): void {
    if (!next) return;
    if (!next.enabled) {
      this.kill();
      return;
    }
    const wasEnabled = this.enabled;
    this.enabled = next.monitoringEnabled;
    if (wasEnabled && !this.enabled) void this.outbox.purge().catch(() => 0);
    if (!next.sessionTracking && this.sessions.active) this.sessions.end();
  }

  /** Kill switch: nothing more is sent this page session; queued envelopes are deleted. */
  kill(): void {
    this.killed = true;
    void this.outbox.purge().catch(() => 0);
  }

  // ---------------------------------------------------------------- start

  async start(): Promise<void> {
    await this.outbox.open().catch(() => {});
    try {
      const stored = await this.deps.storage.getKv<string>(INSTALL_ID_KEY);
      if (typeof stored === 'string' && stored) this.installId = stored;
      else await this.deps.storage.setKv(INSTALL_ID_KEY, this.installId);
    } catch {
      // a per-page id then
    }
    if (this.disposed) return;
    this.readMetaTrace();
    this.metrics.start();
    this.installGlobalListeners();
    if (this.deps.config.consoleBreadcrumbs !== false || this.deps.config.captureConsoleErrors) this.installConsole();
    const loc = globalThis.location;
    if (loc) {
      this.lastLocation = this.deps.redactor().redactUrl(loc.href);
      this.lastPath = loc.pathname;
    }
    this.startPageload();
    if (this.sessionsEnabled && this.active) this.startSession();
  }

  private readMetaTrace(): void {
    if (typeof document === 'undefined') return;
    const traceparent = document.querySelector('meta[name="traceparent"]')?.getAttribute('content');
    if (traceparent) this.continueTrace(traceparent, document.querySelector('meta[name="baggage"]')?.getAttribute('content') ?? null);
  }

  private installGlobalListeners(): void {
    if (typeof addEventListener !== 'function') return;
    const onClick = (e: MouseEvent) =>
      this.guard(() => {
        const el = e.target instanceof Element ? e.target : null;
        if (!el || el.closest('[data-bugcapsule-ignore]')) return;
        const target = describeElement(el);
        this.addBreadcrumb({ type: 'user', category: 'ui.click', message: target }, { event: e });
        if (this.deps.config.enableUserInteractionTracing && !this.idle) {
          const t = this.startIdle('ui.action.click', this.currentRouteName());
          t.setData('ui.target', target);
        }
      });
    const onVisibility = () =>
      this.guard(() => {
        if (document.visibilityState !== 'hidden') return;
        this.metrics.vitals.hidden();
        this.reportLateVitals();
        void this.flushNow();
      });
    const onPageHide = () =>
      this.guard(() => {
        this.idle?.finish();
        if (this.sessions.active) {
          const update = this.sessions.end();
          if (update) this.enqueue([{ type: 'session', payload: update }], { keepalive: true });
        }
      });
    const onPageShow = (e: PageTransitionEvent) =>
      this.guard(() => {
        if (e.persisted && this.sessionsEnabled && this.active && !this.sessions.active) this.startSession();
      });
    addEventListener('click', onClick, { capture: true, passive: true });
    addEventListener('pagehide', onPageHide);
    addEventListener('pageshow', onPageShow);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    this.cleanups.push(() => {
      removeEventListener('click', onClick, { capture: true });
      removeEventListener('pagehide', onPageHide);
      removeEventListener('pageshow', onPageShow);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    });
  }

  private installConsole(): void {
    const c = globalThis.console as unknown as Record<string, (...args: unknown[]) => void> | undefined;
    if (!c) return;
    for (const method of Object.keys(CONSOLE_LEVELS)) {
      const original = c[method];
      if (typeof original !== 'function') continue;
      const self = this;
      const wrapped = function (this: unknown, ...args: unknown[]) {
        if (!self.inConsole) {
          self.inConsole = true;
          try {
            self.onConsole(method, args);
          } catch {
            // never break logging
          } finally {
            self.inConsole = false;
          }
        }
        return original.apply(this, args);
      };
      c[method] = wrapped;
      this.cleanups.push(() => {
        if (c[method] === wrapped) c[method] = original;
      });
    }
  }

  private onConsole(method: string, args: unknown[]): void {
    const message = formatArgs(args);
    if (message.startsWith('[bugcapsule]')) return;
    const level = CONSOLE_LEVELS[method] ?? 'info';
    if (this.deps.config.consoleBreadcrumbs !== false) {
      this.addBreadcrumb({ type: 'debug', category: 'console', level, message }, { arguments: args });
    }
    if (method === 'error' && this.deps.config.captureConsoleErrors) {
      const error = args.find((a) => a instanceof Error);
      const mechanism: Mechanism = { type: 'logging', handled: true };
      if (error) this.captureException(error, { mechanism });
      else this.captureMessage(message, { level: 'error' });
    }
  }

  private guard(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.deps.log(`monitoring: internal error ignored: ${String(e)}`);
    }
  }

  // ---------------------------------------------------------------- scope

  get scope(): Scope {
    return this.scopes[this.scopes.length - 1]!;
  }

  /** Runs `fn` with a temporary copy of the current scope (popped when `fn` returns). */
  withScope<T>(fn: (scope: Scope) => T): T {
    this.scopes.push(this.scope.clone());
    try {
      return fn(this.scope);
    } finally {
      this.scopes.pop();
    }
  }

  setUser(user: User | null): void {
    this.scope.setUser(user);
  }

  addBreadcrumb(breadcrumb: Breadcrumb, hint?: Record<string, unknown>): void {
    const max = this.maxBreadcrumbs;
    if (max === 0) return;
    let b: Breadcrumb | null = { timestamp: iso(this.now()), type: 'default', level: 'info', ...breadcrumb };
    const before = this.deps.config.beforeBreadcrumb;
    if (before) {
      try {
        b = before(b, hint);
      } catch (e) {
        this.deps.log(`beforeBreadcrumb threw: ${String(e)}`);
      }
    }
    if (!b) return;
    if (b.message !== undefined && b.message !== null) b.message = cut(String(b.message), 2000);
    this.breadcrumbs.push(b);
    if (this.breadcrumbs.length > max) this.breadcrumbs.splice(0, this.breadcrumbs.length - max);
  }

  clearBreadcrumbs(): void {
    this.breadcrumbs = [];
  }

  lastEventId(): string | null {
    return this.lastId;
  }

  // ----------------------------------------------------- flight recorder feed

  /**
   * Breadcrumbs derived from flight-recorder events (monitoring-v1 §2):
   * every `session.record()` call reaches this, recording or not. HTTP,
   * navigation and pointer events have their own observers.
   */
  onRecord(type: string, data: Record<string, unknown>): void {
    switch (type) {
      case 'action':
        this.addBreadcrumb({ type: 'user', category: 'ui.action', message: String(data.id ?? '') });
        break;
      case 'log': {
        const level = data.level === 'warn' ? 'warning' : data.level === 'error' ? 'error' : data.level === 'debug' ? 'debug' : 'info';
        this.addBreadcrumb({ type: 'debug', category: 'log', level, message: String(data.message ?? '') });
        break;
      }
      case 'lifecycle':
        this.addBreadcrumb({ type: 'navigation', category: 'app.lifecycle', data: { state: data.state } });
        break;
      case 'state':
        this.addBreadcrumb({ type: 'state', category: 'state', data: { key: data.key } });
        break;
    }
  }

  // ------------------------------------------------------------------- HTTP

  httpStart(request: { kind: 'fetch' | 'xhr'; method: string; url: string }): HttpObservation | null {
    if (!this.active || this.disposed) return null;
    const started = this.now();
    const parent = this.activeSpan();
    const r = this.deps.redactor();
    const url = r.redactUrl(request.url);
    const short = url.split(/[?#]/)[0] ?? url;
    const span = parent?.startChild({ op: 'http.client', description: `${request.method} ${short}`, data: { url, 'http.request.method': request.method } }) ?? null;
    let headers: Record<string, string> | null = null;
    if (shouldPropagate(request.url, this.targets, globalThis.location?.origin ?? null)) {
      headers = { traceparent: span ? span.toTraceparent() : this.propagationTraceparent(), baggage: this.baggage() };
    }
    let done = false;
    return {
      headers,
      finish: (result) =>
        this.guard(() => {
          if (done) return;
          done = true;
          const data: Record<string, unknown> = { method: request.method, url };
          let level: SeverityLevel = 'info';
          if (result.status !== undefined && result.status > 0) {
            data.status_code = result.status;
            span?.setHttpStatus(result.status);
            if (result.status >= 500) level = 'error';
            else if (result.status >= 400) level = 'warning';
          } else {
            const name = (result.error as { name?: string } | undefined)?.name;
            span?.setStatus(name === 'AbortError' ? 'cancelled' : name === 'TimeoutError' ? 'deadline_exceeded' : 'internal_error');
            level = 'error';
            if (result.error !== undefined) data.error = String((result.error as { message?: string })?.message ?? result.error);
          }
          span?.finish();
          data.duration = Math.round(this.now() - started);
          this.addBreadcrumb({ type: 'http', category: request.kind, level, data });
        }),
    };
  }

  // ------------------------------------------------------------- navigation

  navigation(location: string, source: string, action?: string, routeName?: string): void {
    this.guard(() => {
      if (this.disposed) return;
      const origin = globalThis.location?.origin ?? 'http://localhost';
      let absolute: URL;
      try {
        absolute = new URL(location, origin);
      } catch {
        return;
      }
      const r = this.deps.redactor();
      const to = r.redactUrl(absolute.href);
      if (to !== this.lastLocation) {
        const rel = (u: string | null) => (u && u.startsWith(origin) ? u.substring(origin.length) || '/' : u);
        this.addBreadcrumb({ type: 'navigation', category: 'navigation', data: { from: rel(this.lastLocation), to: rel(to), source, ...(action ? { action } : {}) } });
        this.lastLocation = to;
      }
      const path = absolute.pathname;
      if (routeName) this.routeName = cut(routeName, 200);
      if (path !== this.lastPath) {
        this.lastPath = path;
        if (!routeName) this.routeName = null;
        this.startIdle('navigation', this.currentRouteName(), { 'navigation.source': source, ...(action ? { 'navigation.action': action } : {}) });
      } else if (routeName && this.idle && this.idlePath === path && (this.idle.op === 'pageload' || this.idle.op === 'navigation')) {
        this.idle.setName(this.routeName!);
      }
    });
  }

  private currentRouteName(): string {
    return this.routeName ?? parameterizePath(globalThis.location?.pathname ?? this.lastPath ?? '/');
  }

  // ---------------------------------------------------------------- tracing

  /** The span errors and HTTP spans attach to: the scope's span, else the running pageload/navigation. */
  activeSpan(): Span | null {
    const s = this.scope.span;
    if (s && !s.finished) return s;
    return this.idle && !this.idle.finished ? this.idle : null;
  }

  private propagationTraceparent(): string {
    const p = this.propagation;
    return `00-${p.traceId}-${p.spanId}-${p.sampled ? '01' : '00'}`;
  }

  getTraceparent(): string {
    return this.activeSpan()?.toTraceparent() ?? this.propagationTraceparent();
  }

  getBaggage(): string {
    return this.baggage();
  }

  private baggage(): string {
    const span = this.activeSpan();
    const tx = span?.transaction ?? null;
    const incoming = this.propagation.baggage;
    if (incoming && (!tx || tx.traceId === this.propagation.traceId)) {
      return Object.entries(incoming)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join(',');
    }
    return baggageFor({
      traceId: span?.traceId ?? this.propagation.traceId,
      release: this.release,
      environment: this.environment,
      sampleRate: tx?.sampleRate ?? (this.propagation.sampled === undefined ? undefined : this.tracesRate),
      sampled: span ? span.sampled : this.propagation.sampled,
    });
  }

  /** Continues an incoming trace: the next root transaction joins it (server-rendered pages, workers). */
  continueTrace(traceparent: string | null, baggage: string | null): void {
    const parsed = parseTraceparent(traceparent);
    if (!parsed) return;
    const entries = parseBaggage(baggage);
    this.propagation = {
      traceId: parsed.traceId,
      parentSpanId: parsed.parentSpanId,
      spanId: this.propagation.spanId,
      sampled: parsed.sampled,
      baggage: Object.keys(entries).length ? entries : null,
    };
  }

  /** A root transaction (or a child of an incoming trace); bound to the current scope until it finishes. */
  startTransaction(options: TransactionOptions, bind = true): Transaction {
    const p = this.propagation;
    const joining = p.parentSpanId !== null;
    const { sampled, rate } = sampleTrace(
      { name: options.name, op: options.op, ...(joining && p.sampled !== undefined ? { parentSampled: p.sampled } : {}), ...(globalThis.location ? { location: globalThis.location.href } : {}) },
      { tracesSampler: this.deps.config.tracesSampler, rate: this.tracesRate, random: this.deps.random },
    );
    const t = new Transaction(joining ? p.traceId : newTraceId(), joining ? p.parentSpanId : null, sampled, rate, options, this);
    // Requests made while no span is active continue this trace.
    this.propagation = { traceId: t.traceId, parentSpanId: null, spanId: p.spanId, sampled, baggage: joining ? p.baggage : null };
    if (bind) this.scope.setSpan(t);
    return t;
  }

  /**
   * Runs `fn` inside a span: a child of the active span, else a new
   * transaction. The span is active while `fn` runs (until its promise
   * settles for async functions) and finishes afterwards.
   */
  startSpan<T>(options: SpanOptions & { name?: string }, fn: (span: Span) => T): T {
    const parent = this.activeSpan();
    const span = parent ? parent.startChild(options) : this.startTransaction({ ...options, name: options.name ?? options.description ?? options.op }, false);
    const scope = this.scope;
    const previous = scope.span;
    scope.setSpan(span);
    let result: T;
    try {
      result = fn(span);
    } catch (e) {
      span.setStatus('internal_error');
      span.finish();
      scope.setSpan(previous);
      throw e;
    }
    if (result instanceof Promise) {
      void result.then(
        () => {
          span.finish();
          if (scope.span === span) scope.setSpan(previous);
        },
        () => {
          span.setStatus('internal_error');
          span.finish();
          if (scope.span === span) scope.setSpan(previous);
        },
      );
      return result;
    }
    span.finish();
    scope.setSpan(previous);
    return result;
  }

  private startPageload(): void {
    const name = this.currentRouteName();
    const timeOrigin = (this.deps.performance ?? globalThis.performance)?.timeOrigin;
    const t = this.startIdle('pageload', name, {}, timeOrigin);
    if (typeof document !== 'undefined' && document.readyState !== 'complete') {
      const release = t.hold();
      const onLoad = () => setTimeout(release, 0);
      addEventListener('load', onLoad, { once: true });
      this.cleanups.push(() => removeEventListener('load', onLoad));
    }
  }

  private startIdle(op: string, name: string, data: Record<string, unknown> = {}, startTimestamp?: number): Transaction {
    if (this.idle && !this.idle.finished) {
      this.idle.status ??= 'cancelled';
      this.idle.finish();
    }
    const t = this.startTransaction(
      { name, op, idleTimeoutMs: IDLE_TIMEOUT_MS, finalTimeoutMs: FINAL_TIMEOUT_MS, data, ...(startTimestamp !== undefined ? { startTimestamp } : {}) },
      false,
    );
    t.beforeFinish.push((tx) => {
      if (tx.sampled) this.metrics.attach(tx, this.now());
    });
    this.idle = t;
    this.idlePath = this.lastPath;
    return t;
  }

  /** INP (and final LCP/CLS) after the pageload already finished: a small `ui.webvital` transaction when the page is hidden. */
  private reportLateVitals(): void {
    if (this.metrics.vitalsSent || this.deps.config.enableWebVitals === false) return;
    const v = this.metrics.vitals.snapshot();
    if (v.inp === undefined) return;
    this.metrics.vitalsSent = true;
    const origin = (this.deps.performance ?? globalThis.performance)?.timeOrigin;
    const startTimestamp = origin !== undefined ? origin + this.metrics.vitals.inp.startTime : this.now();
    const t = this.startTransaction({ name: this.currentRouteName(), op: 'ui.webvital.inp', startTimestamp }, false);
    t.setMeasurement('inp', v.inp, 'millisecond');
    t.finish(t.startTimestamp + v.inp);
  }

  /** @internal SpanHost */
  onTransactionFinish(t: Transaction): void {
    if (this.scope.span === t) this.scope.setSpan(null);
    if (this.idle === t) this.idle = null;
    if (!t.sampled || !this.active) return;
    let payload: TransactionPayload | null = this.transactionPayload(t);
    const before = this.deps.config.beforeSendTransaction;
    if (before) {
      try {
        payload = before(payload);
      } catch (e) {
        this.deps.log(`beforeSendTransaction threw: ${String(e)}`);
      }
    }
    if (payload) this.enqueue([{ type: 'transaction', payload }]);
  }

  private transactionPayload(t: Transaction): TransactionPayload {
    const scope = this.scope;
    const payload: TransactionPayload = {
      eventId: t.eventId,
      traceId: t.traceId,
      spanId: t.spanId,
      parentSpanId: t.parentSpanId,
      name: cut(t.name, 200),
      op: t.op,
      startTimestamp: iso(t.startTimestamp),
      timestamp: iso(t.endTimestamp ?? this.now()),
      status: t.status ?? 'ok',
      environment: this.environment,
      runtime: 'web',
      tags: normalizeTags({ ...scope.tags, ...t.tags }),
      contexts: { ...this.contexts, ...scope.contexts, trace: { traceId: t.traceId, spanId: t.spanId, ...(t.parentSpanId ? { parentSpanId: t.parentSpanId } : {}), op: t.op, status: t.status ?? 'ok', ...(Object.keys(t.data).length ? { data: toJsonSafe(t.data, 3) } : {}) } },
      measurements: { ...t.measurements },
      spans: t.spans.filter((s) => s.finished && !s.op.startsWith('internal.')).map((s) => s.toPayload()),
    };
    if (this.release) payload.release = this.release;
    if (this.deps.config.dist) payload.dist = this.deps.config.dist;
    const user = this.userPayload(scope);
    if (user) payload.user = user;
    if (t.droppedSpans > 0) payload.contexts.trace!.droppedSpans = t.droppedSpans;
    return payload;
  }

  // ----------------------------------------------------------------- events

  private userPayload(scope: Scope): User | undefined {
    const u = scope.user;
    if (!u && !this.deps.config.sendDefaultPii) return undefined;
    const user: User = { ...(u ?? {}) };
    if (this.deps.config.sendDefaultPii) user.ipAddress ??= '{{auto}}';
    else if (user.ipAddress === '{{auto}}') delete user.ipAddress;
    return user;
  }

  private traceContext(): Record<string, unknown> {
    const span = this.activeSpan();
    return span ? { traceId: span.traceId, spanId: span.spanId } : { traceId: this.propagation.traceId, spanId: this.propagation.spanId };
  }

  /** The link written into `manifest.monitoring` for an event. */
  linkFor(eventId: string): MonitoringLink {
    const link: MonitoringLink = { eventId, environment: this.environment };
    const trace = this.traceContext();
    if (typeof trace.traceId === 'string') link.traceId = trace.traceId;
    if (this.release) link.release = this.release;
    return link;
  }

  captureException(error: unknown, context: CaptureContext = {}, extra: { capsuleId?: string | null; hint?: EventHint } = {}): string {
    return this.captureError(error, context, extra) ?? uuid4();
  }

  /** Like {@link captureException}; the event id when the event was queued, else null (sampled out, dropped, inactive). */
  captureError(error: unknown, context: CaptureContext = {}, extra: { capsuleId?: string | null; hint?: EventHint } = {}): string | null {
    const mechanism = context.mechanism ?? { type: 'manual', handled: true };
    const eventId = uuid4();
    let sent = false;
    this.guard(() => {
      const values = exceptionValues(error, mechanism, this.inAppOptions);
      sent = this.send(
        { exception: { values }, level: 'error' },
        context,
        { originalException: error, mechanism, ...(extra.hint ?? {}) },
        eventId,
        extra.capsuleId ?? null,
        !mechanism.handled,
      );
    });
    return sent ? eventId : null;
  }

  captureMessage(message: string, levelOrContext: SeverityLevel | CaptureContext = 'info', syntheticStack?: string | null): string {
    const context: CaptureContext = typeof levelOrContext === 'string' ? { level: levelOrContext } : levelOrContext;
    const eventId = uuid4();
    this.guard(() => {
      const event: Partial<EventPayload> = { message: { formatted: String(message) }, level: 'info' };
      if (this.deps.config.attachStacktrace && syntheticStack) {
        // The newest frame is `BugCapsule.captureMessage` itself.
        const frames = framesOf(syntheticStack, this.inAppOptions).slice(0, -1);
        // Grouping stays by message: the stack goes on the current thread.
        if (frames.length) (event as Record<string, unknown>).threads = [{ id: 0, current: true, crashed: false, stacktrace: { frames } }];
      }
      this.send(event, context, {}, eventId, null, false);
    });
    return eventId;
  }

  /** A failed `BugCapsule.check` / `fail`, grouped by assertion id (no stack trace); the event id when queued. */
  captureAssertion(assertionId: string, message: string, capsuleId: string | null): string | null {
    const eventId = uuid4();
    let sent = false;
    this.guard(() => {
      const mechanism: Mechanism = { type: 'assertion', handled: true };
      sent = this.send(
        { exception: { values: [{ type: cut(assertionId, 200), value: cut(message, 8192), mechanism }] }, level: 'error' },
        { tags: { assertion: cut(assertionId, 200) } },
        { mechanism },
        eventId,
        capsuleId,
        false,
      );
    });
    return sent ? eventId : null;
  }

  private send(base: Partial<EventPayload>, context: CaptureContext, hint: EventHint, eventId: string, capsuleId: string | null, unhandled: boolean): boolean {
    if (!this.active) return false;
    const scope = this.scope;
    const level = context.level ?? scope.level ?? base.level ?? 'error';
    let event: EventPayload = {
      eventId,
      timestamp: iso(this.now()),
      level,
      runtime: 'web',
      environment: this.environment,
      ...base,
    };
    event.level = level;
    if (this.release) event.release = this.release;
    if (this.deps.config.dist) event.dist = this.deps.config.dist;
    const fingerprint = context.fingerprint ?? scope.fingerprint;
    if (fingerprint) event.fingerprint = fingerprint;
    const tags = { ...scope.tags, ...(context.tags ?? {}) };
    if (Object.keys(tags).length) event.tags = normalizeTags(tags);
    const user = this.userPayload(context.user ? new Scope().setUser({ ...(scope.user ?? {}), ...context.user }) : scope);
    if (user) event.user = user;
    event.contexts = { ...this.contexts, ...scope.contexts, ...(context.contexts ?? {}), trace: this.traceContext() };
    const extra = { ...scope.extra, ...(context.extra ?? {}) };
    if (Object.keys(extra).length) event.extra = toJsonSafe(extra) as Record<string, unknown>;
    if (this.breadcrumbs.length) event.breadcrumbs = this.breadcrumbs.slice(-this.maxBreadcrumbs);
    const images = debugImagesFor(eventFrames(event));
    if (images.length) event.debugImages = images;
    const loc = globalThis.location;
    if (loc) {
      const ua = globalThis.navigator?.userAgent;
      event.request = { url: loc.href, method: 'GET', ...(ua ? { headers: { 'User-Agent': ua } } : {}) };
    }
    if (capsuleId) event.capsuleId = capsuleId;

    // Error sampling: fatal and capsule-linked events are always sent.
    if (level !== 'fatal' && !capsuleId && this.deps.random() >= this.errorSampleRate) return false;
    // Consecutive duplicates (an error thrown in a loop) are sent once.
    const fp = this.dedupeKey(event);
    if (fp !== null && fp === this.lastFingerprint && !capsuleId) return false;

    const before = this.deps.config.beforeSend;
    if (before) {
      let result: EventPayload | null;
      try {
        result = before(event, hint);
      } catch (e) {
        this.deps.log(`beforeSend threw; sending the event unchanged: ${String(e)}`);
        result = event;
      }
      if (!result) return false;
      event = result;
    }
    event = normalizeEvent(event);
    this.lastFingerprint = fp;
    this.lastId = event.eventId;

    const items: EnvelopeItem[] = [{ type: 'event', payload: event }];
    if (event.exception && (event.level === 'error' || event.level === 'fatal')) {
      const crashed = unhandled && this.deps.config.crashOnUnhandled !== false;
      const update = this.sessions.error(crashed || event.level === 'fatal');
      if (update) items.push({ type: 'session', payload: update });
    }
    this.enqueue(items);
    this.addBreadcrumb({ type: 'error', category: 'bugcapsule.event', level: event.level, message: eventTitle(event), data: { eventId: event.eventId } });
    return true;
  }

  private dedupeKey(e: EventPayload): string | null {
    const last = e.exception?.values[e.exception.values.length - 1];
    if (last) {
      const frames = last.stacktrace?.frames ?? [];
      return `x|${last.type}|${last.value ?? ''}|${frames.map((f) => `${f.absPath}:${f.lineno}:${f.colno}:${f.function ?? ''}`).join(',')}`;
    }
    return e.message ? `m|${e.message.formatted}` : null;
  }

  // --------------------------------------------------------------- feedback

  /** The feedback id; empty when nothing was sent (no message, monitoring inactive). */
  captureFeedback(input: FeedbackInput): string {
    const feedbackId = uuid4();
    const message = cut(String(input.message ?? '').trim(), 5000);
    if (!message || !this.active) return '';
    this.guard(() => {
      const scope = this.scope;
      let capsuleId: string | null = null;
      const wantCapsule = input.captureCapsule ?? this.deps.config.captureCapsuleWithFeedback ?? this.deps.mode === 'qa';
      if (wantCapsule && this.deps.writeCapsule) {
        const id = uuid4();
        if (this.deps.writeCapsule(id, 'user feedback', input.eventId ? this.linkFor(input.eventId) : null)) capsuleId = id;
      }
      const payload: FeedbackPayload = {
        feedbackId,
        timestamp: iso(this.now()),
        message,
        environment: this.environment,
        runtime: 'web',
        contexts: { ...scope.contexts, trace: this.traceContext() },
        url: input.url ?? globalThis.location?.href ?? null,
        capsuleId,
        eventId: input.eventId ?? null,
      };
      if (input.name) payload.name = cut(input.name, 200);
      if (input.email) payload.email = cut(input.email, 200);
      if (this.release) payload.release = this.release;
      const user = this.userPayload(scope);
      if (user) payload.user = user;
      const tags = normalizeTags({ ...scope.tags, ...(input.tags ?? {}) });
      if (Object.keys(tags).length) payload.tags = tags;
      this.enqueue([{ type: 'feedback', payload }]);
    });
    return feedbackId;
  }

  // --------------------------------------------------------------- sessions

  startSession(): void {
    if (!this.active) return;
    if (this.sessions.active) this.endSession();
    this.enqueue([{ type: 'session', payload: this.sessions.start() }]);
  }

  endSession(): void {
    const update = this.sessions.end();
    if (update) this.enqueue([{ type: 'session', payload: update }]);
  }

  // ------------------------------------------------------------- envelopes

  /** Redacts, bounds and persists the items as one envelope, then schedules a send. */
  private enqueue(items: EnvelopeItem[], options: { keepalive?: boolean } = {}): void {
    if (!this.active) return;
    const redactor = this.deps.redactor();
    const ready: EnvelopeItem[] = [];
    for (const item of items) {
      let clean: EnvelopeItem | null;
      try {
        clean = fitItem(redactItem(redactor, item));
      } catch (e) {
        this.deps.log(`dropping a ${item.type} item: ${String(e)}`);
        clean = null;
      }
      if (clean) ready.push(clean);
    }
    if (ready.length === 0) return;
    const json = JSON.stringify({ sentAt: iso(this.now()), sdk: this.deps.sdk, items: ready.slice(0, 100) });
    const transport = this.deps.transport;
    if (options.keepalive && transport?.sendEnvelope && this.deps.uploadsAllowed()) {
      // The page is going away: try now as well; the queued copy is deduplicated by the server.
      void transport.sendEnvelope(json, { keepalive: true }).catch(() => undefined);
    }
    const p = this.outbox
      .enqueue(uuid4(), utf8Encode(json))
      .then((queued) => {
        if (!queued) this.deps.log('envelope not queued (outbox limit or storage error)');
        else this.scheduleFlush();
      })
      .catch(() => undefined);
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  private scheduleFlush(delayMs = 1000): void {
    if (this.flushTimer || this.disposed) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushNow();
    }, delayMs);
  }

  /** Sends queued envelopes now (when a fresh config allows it). */
  async flushNow(): Promise<UploadResult | null> {
    const transport = this.deps.transport;
    if (!transport?.sendEnvelope || !this.active) return null;
    try {
      await this.deps.ensureFresh();
    } catch {
      // the gate below decides
    }
    if (!this.active || !this.deps.uploadsAllowed()) return null;
    return this.outbox.flush({
      upload: async (bytes) => {
        let json: string;
        try {
          const envelope = JSON.parse(utf8Decode(bytes)) as Record<string, unknown>;
          envelope.sentAt = iso(this.now());
          json = JSON.stringify(envelope);
        } catch {
          return { status: 'rejected', message: 'corrupt envelope' };
        }
        const result = await transport.sendEnvelope!(json);
        if (result.message === 'capture_disabled') this.deps.refreshRemote();
        return result;
      },
      allowed: () => this.active && this.deps.uploadsAllowed(),
    });
  }

  /** Waits for queued items to be sent; false when `timeoutMs` passed first or some are still queued. */
  async flush(timeoutMs = 2000): Promise<boolean> {
    const work = (async () => {
      await Promise.all([...this.pending]);
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      await this.flushNow();
      return this.outbox.entries().then((e) => e.length === 0, () => false);
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async pendingEnvelopes(): Promise<number> {
    await Promise.all([...this.pending]);
    return (await this.outbox.entries().catch(() => [])).length;
  }

  dispose(): void {
    this.disposed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    // Clears its timers; nothing is sent once disposed.
    this.idle?.finish();
    for (const c of this.cleanups.reverse()) c();
    this.cleanups.length = 0;
    this.metrics.stop();
    void this.outbox.close();
  }
}

