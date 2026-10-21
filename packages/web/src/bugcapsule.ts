import { Runtime, type RuntimeOverrides } from './runtime.js';
import type { StateSerializer } from './integrations/state.js';
import { FeedbackWidget, type FeedbackWidgetOptions } from './monitoring/feedback-widget.js';
import { Scope } from './monitoring/scope.js';
import { detachedTransaction, type Span, type SpanOptions, type Transaction, type TransactionOptions } from './monitoring/tracing.js';
import type { Breadcrumb, CaptureContext, FeedbackInput, SeverityLevel, User } from './monitoring/types.js';
import type { BugCapsuleConfig, BugCapsuleSession, CaptureResult } from './types.js';

let rt: Runtime | null = null;
let testOverrides: RuntimeOverrides | undefined;
const fallbackRandom = Math.random;

export interface TrackOptions {
  /** Record the placeholder instead of the value (password inputs and `data-bugcapsule-sensitive` elements always are). */
  sensitive?: boolean;
}

/**
 * Entry point of the BugCapsule web SDK.
 *
 * ```ts
 * await BugCapsule.init({
 *   appVersion: '1.4.0', appBuild: '52', mode: 'qa',
 *   backend: { url: 'https://bugcapsule.example.com', ingestKey: 'bci_…' },
 *   integrations: [networkIntegration(), historyIntegration(), localStorageIntegration({ allowPrefixes: ['cart.'] })],
 *   allowReplay: import.meta.env.DEV,
 * });
 * renderApp();
 * ```
 *
 * Await `init` before rendering: replay restores state there. The SDK never
 * stops the app from starting: if storage or an integration fails, the app
 * runs without capture.
 */
export const BugCapsule = {
  async init(config: BugCapsuleConfig): Promise<void> {
    if (rt) throw new Error('BugCapsule.init called twice');
    rt = new Runtime(config, testOverrides);
    await rt.start();
  },

  get isInitialized(): boolean {
    return rt !== null;
  },
  get isRecording(): boolean {
    return rt?.isRecording ?? false;
  },
  get isReplaying(): boolean {
    return rt?.isReplaying ?? false;
  },
  get mode() {
    return rt?.mode ?? null;
  },
  get session(): BugCapsuleSession | null {
    return rt;
  },

  /**
   * Wraps a UI callback as a named semantic action: records it and lets
   * semantic replay invoke it by id. Elements can also declare
   * `data-bugcapsule-action="<id>"` (used as a stable selector for clicks).
   */
  action<A extends unknown[], R>(id: string, handler: (...args: A) => R): (...args: A) => R {
    if (rt) rt.actions.register(id, () => void (handler as () => R)());
    return (...args: A) => {
      rt?.record('action', { id });
      return handler(...args);
    };
  },

  /** Like {@link action} with a JSON payload passed to the handler (and replayed). */
  actionWithPayload<P extends Record<string, unknown>>(id: string, handler: (payload: P) => void): (payload: P) => void {
    if (rt) rt.actions.register(id, (p) => handler((p ?? {}) as P));
    return (payload: P) => {
      rt?.record('action', { id, payload });
      handler(payload);
    };
  },

  /**
   * Records edits of an input under `id` and restores them in replay.
   * Values are redacted for password inputs, `data-bugcapsule-sensitive`
   * elements, `sensitive: true`, or ids that look sensitive. Returns a disposer.
   */
  trackInput(id: string, element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, options: TrackOptions = {}): () => void {
    const runtime = rt;
    if (!runtime) return () => {};
    const untrack = runtime.actions.trackInput(id, { element });
    let last = element.value;
    const onInput = () => {
      if (element.value === last) return;
      last = element.value;
      this.recordText(id, last, options.sensitive === true || isSensitiveElement(element, runtime.config.sensitiveSelector));
    };
    element.addEventListener('input', onInput);
    element.addEventListener('change', onInput);
    return () => {
      untrack();
      element.removeEventListener('input', onInput);
      element.removeEventListener('change', onInput);
    };
  },

  /**
   * For values that are not DOM inputs (controlled components, custom
   * widgets): register a setter for replay and call the returned function
   * with every new value.
   */
  trackValue(id: string, set: (value: string) => void, options: TrackOptions = {}): { changed(value: string): void; dispose(): void } {
    const runtime = rt;
    const untrack = runtime?.actions.trackInput(id, { element: null, set }) ?? (() => {});
    let last: string | null = null;
    return {
      changed: (value: string) => {
        if (value === last) return;
        last = value;
        this.recordText(id, value, options.sensitive === true);
      },
      dispose: untrack,
    };
  },

  /** @internal */
  recordText(id: string, value: string, sensitive: boolean): void {
    const runtime = rt;
    if (!runtime?.isRecording) return;
    const v = runtime.redactor.redactText(id, value, sensitive);
    runtime.record('text', { id: id.length <= 200 ? id : id.substring(0, 200), value: v.length <= 100_000 ? v : v.substring(0, 100_000) });
  },

  /** Raises a named failure assertion; replay is judged against `assertionId`. */
  fail(assertionId: string, message = ''): void {
    rt?.fail(assertionId, message);
  },

  /** Raises `assertionId` when `condition` is false. */
  check(assertionId: string, condition: boolean, message = ''): void {
    if (!condition) rt?.fail(assertionId, message);
  },

  /**
   * Reports a caught error as a failure (error boundaries, framework
   * handlers): it can trigger a capsule and is sent as an error event
   * (mechanism `manual`, handled, unless `context.mechanism` says otherwise).
   */
  reportError(error: unknown, context?: CaptureContext): void {
    rt?.reportError(error, context);
  },

  log(message: string, level: 'debug' | 'info' | 'warn' | 'error' = 'info'): void {
    rt?.record('log', { level, message });
  },

  /**
   * Records navigation (router integrations call this with their own
   * source). `routeName` is the route pattern (`/product/:id`) used as the
   * navigation transaction name.
   */
  route(location: string, source?: string, action?: string, routeName?: string): void {
    rt?.route(location, source, action, routeName);
  },

  /** Registers app-owned state for checkpoints and replay restoration. Returns a disposer. */
  registerState<T>(key: string, serializer: StateSerializer<T>): () => void {
    return rt?.state.register(key, serializer) ?? (() => {});
  },

  /** Records a diagnostic `state` event for a registered state. */
  stateChanged(key: string): void {
    rt?.state.changed(key);
  },

  /** Writes a capsule now (QA capture button); uses the latest failure as the assertion. */
  async capture(options: { note?: string } = {}): Promise<CaptureResult | null> {
    return rt?.writeCapsule(rt.lastFailure, options.note ? { note: options.note } : {}) ?? null;
  },

  /** Wall clock in epoch ms. Use instead of `Date.now()` where replay must see the recorded time. */
  now(): number {
    return rt?.wallClock() ?? Date.now();
  },

  date(): Date {
    return new Date(this.now());
  },

  /** Seeded per session and restored in replay. Use instead of `Math.random()` where it matters. */
  random(): number {
    return rt ? rt.random() : fallbackRandom();
  },

  async refreshRemoteConfig(): Promise<void> {
    await rt?.remote?.refresh();
  },

  async flushUploads(): Promise<void> {
    await rt?.flushOutbox();
  },

  async pendingUploads(): Promise<number> {
    return rt?.pendingUploads() ?? 0;
  },

  async savedCaptures(): Promise<{ capsuleId: string; savedAt: number; bytes: Uint8Array }[]> {
    return rt?.savedCaptures() ?? [];
  },

  // ------------------------------------------------------------ monitoring

  /**
   * Sends an error event (monitoring only: no capsule; use
   * {@link reportError} for failures that should be replayable). Returns
   * the event id.
   */
  captureException(error: unknown, context?: CaptureContext): string {
    return rt?.monitorClient?.captureException(error, context) ?? '';
  },

  /** Sends a message event (default level `info`). Returns the event id. */
  captureMessage(message: string, levelOrContext?: SeverityLevel | CaptureContext): string {
    const stack = rt?.config.attachStacktrace ? new Error(message).stack : null;
    return rt?.monitorClient?.captureMessage(message, levelOrContext ?? 'info', stack) ?? '';
  },

  /** Sends user feedback (optionally with a capsule, see `captureCapsuleWithFeedback`). Returns the feedback id. */
  captureFeedback(feedback: FeedbackInput): string {
    return rt?.monitorClient?.captureFeedback(feedback) ?? '';
  },

  /** Id of the last error event sent (null before any). */
  lastEventId(): string | null {
    return rt?.monitorClient?.lastEventId() ?? null;
  },

  setUser(user: User | null): void {
    rt?.monitorClient?.setUser(user);
  },
  setTag(key: string, value: string | number | boolean): void {
    rt?.monitorClient?.scope.setTag(key, value);
  },
  setTags(tags: Record<string, string | number | boolean>): void {
    rt?.monitorClient?.scope.setTags(tags);
  },
  setExtra(key: string, value: unknown): void {
    rt?.monitorClient?.scope.setExtra(key, value);
  },
  setExtras(extras: Record<string, unknown>): void {
    rt?.monitorClient?.scope.setExtras(extras);
  },
  /** `null` removes the context. */
  setContext(name: string, context: Record<string, unknown> | null): void {
    rt?.monitorClient?.scope.setContext(name, context);
  },
  setLevel(level: SeverityLevel | null): void {
    rt?.monitorClient?.scope.setLevel(level);
  },
  /** Custom grouping for later events (`['{{ default }}', 'checkout']` keeps the default grouping and refines it). */
  setFingerprint(fingerprint: string[] | null): void {
    rt?.monitorClient?.scope.setFingerprint(fingerprint);
  },
  addBreadcrumb(breadcrumb: Breadcrumb): void {
    rt?.monitorClient?.addBreadcrumb(breadcrumb);
  },
  clearBreadcrumbs(): void {
    rt?.monitorClient?.clearBreadcrumbs();
  },

  /** Runs `fn` with a temporary copy of the current scope; events captured inside use it. */
  withScope<T>(fn: (scope: Scope) => T): T {
    const monitor = rt?.monitorClient;
    return monitor ? monitor.withScope(fn) : fn(new Scope());
  },

  /** Changes the current scope. */
  configureScope(fn: (scope: Scope) => void): void {
    fn(rt?.monitorClient?.scope ?? new Scope());
  },

  /**
   * Starts a transaction (a new trace, or the one passed to
   * {@link continueTrace}); it is the active span until it finishes.
   */
  startTransaction(options: TransactionOptions): Transaction {
    return rt?.monitorClient?.startTransaction(options) ?? detachedTransaction(options);
  },

  /**
   * Runs `fn` in a span (child of the active span, else a new transaction),
   * finished when `fn` returns or its promise settles.
   */
  startSpan<T>(options: SpanOptions & { name?: string }, fn: (span: Span) => T): T {
    const monitor = rt?.monitorClient;
    if (monitor) return monitor.startSpan(options, fn);
    return fn(detachedTransaction({ ...options, name: options.name ?? options.op }));
  },

  getActiveSpan(): Span | null {
    return rt?.monitorClient?.activeSpan() ?? null;
  },

  /** `traceparent` for custom clients (WebSocket, workers). */
  getTraceparent(): string | null {
    return rt?.monitorClient?.getTraceparent() ?? null;
  },

  getBaggage(): string | null {
    return rt?.monitorClient?.getBaggage() ?? null;
  },

  /** Continues a trace started elsewhere (a server-rendered page: `<meta name="traceparent">` is read automatically). */
  continueTrace(traceparent: string | null, baggage?: string | null): void {
    rt?.monitorClient?.continueTrace(traceparent, baggage ?? null);
  },

  /** Ends the current release-health session (if any) and starts a new one. */
  startSession(): void {
    rt?.monitorClient?.startSession();
  },

  endSession(): void {
    rt?.monitorClient?.endSession();
  },

  /**
   * Shows the feedback widget (a floating button opening a form; opt-in).
   * Returns a handle to open, close or remove it.
   */
  showFeedbackWidget(options: FeedbackWidgetOptions = {}): FeedbackWidget {
    const widget = new FeedbackWidget((input) => this.captureFeedback(input), () => this.lastEventId(), options);
    widget.mount();
    return widget;
  },

  /** Sends queued envelopes and capsules; false when `timeoutMs` passed first. */
  async flush(timeoutMs = 2000): Promise<boolean> {
    const runtime = rt;
    if (!runtime) return true;
    const [sent] = await Promise.all([runtime.monitorClient?.flush(timeoutMs) ?? Promise.resolve(true), runtime.flushOutbox()]);
    return sent;
  },

  /** Flushes, ends the session and shuts the SDK down. */
  async close(timeoutMs = 2000): Promise<boolean> {
    const runtime = rt;
    if (!runtime) return true;
    runtime.monitorClient?.endSession();
    const sent = await this.flush(timeoutMs);
    await runtime.dispose();
    if (rt === runtime) rt = null;
    return sent;
  },

  /** Envelopes waiting in the monitoring outbox. */
  async pendingEnvelopes(): Promise<number> {
    return rt?.monitorClient?.pendingEnvelopes() ?? 0;
  },

  /** @internal Framework helpers declare themselves (`runtime.frameworks`). */
  useFramework(name: string): void {
    rt?.addFramework(name);
  },

  /** Tests only: replaces storage/transport/randomness for the next init. */
  setTestOverrides(overrides: RuntimeOverrides | undefined): void {
    testOverrides = overrides;
  },

  /** Tests only. */
  async resetForTest(): Promise<void> {
    await rt?.dispose();
    rt = null;
  },
};

function isSensitiveElement(el: Element, selector = '[data-bugcapsule-sensitive]'): boolean {
  if (el instanceof HTMLInputElement && el.type === 'password') return true;
  try {
    return el.closest(selector) !== null;
  } catch {
    return false;
  }
}
