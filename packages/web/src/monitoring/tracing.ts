import { iso, isSpanId, isTraceId, spanId as newSpanId, traceId as newTraceId, uuid4 } from './ids.js';
import type { Measurement, SpanPayload, SpanStatus, TracesSamplingContext } from './types.js';

/** monitoring-v1 §8: at most 1000 spans per transaction. */
export const MAX_SPANS = 1000;

/** Epoch milliseconds with sub-millisecond precision where the platform has it. */
export function epochNow(): number {
  const p = globalThis.performance;
  return p && typeof p.timeOrigin === 'number' ? p.timeOrigin + p.now() : Date.now();
}

export interface SpanOptions {
  op: string;
  /** Shown as the span description (`name` is accepted as an alias). */
  description?: string;
  name?: string;
  data?: Record<string, unknown>;
  /** Epoch ms (default now). */
  startTimestamp?: number;
}

/** What spans need from the client (time, finishing transactions). */
export interface SpanHost {
  now(): number;
  onTransactionFinish(t: Transaction): void;
}

/**
 * A timed operation inside a trace. Children are created with
 * {@link startChild}; `finish()` ends it. Spans of an unsampled trace are
 * kept for propagation but never sent.
 */
export class Span {
  readonly spanId: string;
  op: string;
  description: string | undefined;
  readonly startTimestamp: number;
  endTimestamp: number | null = null;
  status: SpanStatus | null = null;
  readonly data: Record<string, unknown> = {};
  readonly tags: Record<string, string> = {};

  constructor(
    readonly traceId: string,
    readonly parentSpanId: string | null,
    readonly sampled: boolean,
    options: SpanOptions,
    protected readonly host: SpanHost,
    /** The transaction this span belongs to (itself for a transaction). */
    readonly transaction: Transaction | null,
    spanId?: string,
  ) {
    this.spanId = spanId ?? newSpanId();
    this.op = options.op;
    this.description = options.description ?? options.name;
    this.startTimestamp = options.startTimestamp ?? host.now();
    if (options.data) Object.assign(this.data, options.data);
  }

  get finished(): boolean {
    return this.endTimestamp !== null;
  }

  startChild(options: SpanOptions): Span {
    const child = new Span(this.traceId, this.spanId, this.sampled, options, this.host, this.transaction);
    this.transaction?.addChild(child);
    return child;
  }

  setData(key: string, value: unknown): this {
    this.data[key] = value;
    return this;
  }
  setTag(key: string, value: string): this {
    this.tags[key] = value;
    return this;
  }
  setStatus(status: SpanStatus): this {
    this.status = status;
    return this;
  }
  /** Sets `http.response.status_code` and the status mapped like OpenTelemetry. */
  setHttpStatus(code: number): this {
    this.data['http.response.status_code'] = code;
    this.status = statusFromHttp(code);
    return this;
  }

  /** Ends the span (epoch ms, default now). Finishing twice keeps the first end. */
  finish(endTimestamp?: number): void {
    if (this.endTimestamp !== null) return;
    this.endTimestamp = Math.max(this.startTimestamp, endTimestamp ?? this.host.now());
    this.transaction?.childFinished(this);
  }

  /** `00-<traceId>-<spanId>-<01|00>` (W3C trace context). */
  toTraceparent(): string {
    return `00-${this.traceId}-${this.spanId}-${this.sampled ? '01' : '00'}`;
  }

  toPayload(): SpanPayload {
    return {
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      op: this.op,
      ...(this.description ? { description: this.description } : {}),
      startTimestamp: iso(this.startTimestamp),
      timestamp: iso(this.endTimestamp ?? this.host.now()),
      status: this.status ?? 'ok',
      ...(Object.keys(this.data).length ? { data: { ...this.data } } : {}),
      ...(Object.keys(this.tags).length ? { tags: { ...this.tags } } : {}),
    };
  }
}

export interface TransactionOptions extends SpanOptions {
  name: string;
  /** Finish after this long without open child spans (pageload/navigation: 1 s). */
  idleTimeoutMs?: number;
  /** Finish no later than this after the start (idle transactions: 30 s). */
  finalTimeoutMs?: number;
}

/**
 * The root span of a trace segment, sent as a `transaction` item when it
 * finishes and the trace is sampled.
 */
export class Transaction extends Span {
  name: string;
  readonly eventId = uuid4();
  readonly spans: Span[] = [];
  readonly measurements: Record<string, Measurement> = {};
  readonly contexts: Record<string, Record<string, unknown>> = {};
  /** Rate the sampling decision was made with (for `baggage`). */
  sampleRate: number;
  /** Runs right before the transaction is handed to the client (browser metrics, vitals). */
  beforeFinish: ((t: Transaction) => void)[] = [];
  private readonly open = new Set<Span>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private finalTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly idleTimeoutMs: number | null;
  private lastChildEnd: number | null = null;
  /** Spans dropped over {@link MAX_SPANS}. */
  droppedSpans = 0;

  constructor(
    traceId: string,
    parentSpanId: string | null,
    sampled: boolean,
    sampleRate: number,
    options: TransactionOptions,
    host: SpanHost,
  ) {
    super(traceId, parentSpanId, sampled, { ...options, description: options.description ?? options.name }, host, null);
    (this as { transaction: Transaction | null }).transaction = this;
    this.name = options.name;
    this.sampleRate = sampleRate;
    this.idleTimeoutMs = options.idleTimeoutMs ?? null;
    if (this.idleTimeoutMs !== null) this.scheduleIdle();
    if (options.finalTimeoutMs !== undefined) {
      this.finalTimer = setTimeout(() => {
        this.status ??= 'deadline_exceeded';
        this.finish();
      }, options.finalTimeoutMs);
    }
  }

  setName(name: string): this {
    this.name = name;
    this.description = name;
    return this;
  }

  setMeasurement(name: string, value: number, unit: string): this {
    if (Number.isFinite(value)) this.measurements[name] = { value, unit };
    return this;
  }

  /** @internal */
  addChild(span: Span): void {
    if (this.finished) return;
    if (this.spans.length >= MAX_SPANS) {
      this.droppedSpans++;
      return;
    }
    this.spans.push(span);
    if (!span.finished) {
      this.open.add(span);
      this.cancelIdle();
    }
  }

  /** @internal */
  childFinished(span: Span): void {
    if (span === this) return;
    this.open.delete(span);
    this.lastChildEnd = Math.max(this.lastChildEnd ?? 0, span.endTimestamp ?? 0);
    if (this.idleTimeoutMs !== null && this.open.size === 0 && !this.finished) this.scheduleIdle();
  }

  /** Keeps an idle transaction open until the returned function runs (e.g. until `load`). */
  hold(): () => void {
    const marker = new Span(this.traceId, this.spanId, this.sampled, { op: 'internal.hold' }, this.host, null);
    if (this.finished) return () => {};
    this.open.add(marker);
    this.cancelIdle();
    return () => {
      this.open.delete(marker);
      if (this.idleTimeoutMs !== null && this.open.size === 0 && !this.finished) this.scheduleIdle();
    };
  }

  private scheduleIdle(): void {
    this.cancelIdle();
    this.idleTimer = setTimeout(() => {
      // An idle transaction ends when its last child did, not when the timer fired.
      this.finish(this.lastChildEnd !== null ? Math.max(this.lastChildEnd, this.startTimestamp) : undefined);
    }, this.idleTimeoutMs!);
  }

  private cancelIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  override finish(endTimestamp?: number): void {
    if (this.finished) return;
    this.cancelIdle();
    if (this.finalTimer) clearTimeout(this.finalTimer);
    for (const hook of this.beforeFinish) {
      try {
        hook(this);
      } catch {
        // metrics are best effort
      }
    }
    this.cancelIdle();
    const end = endTimestamp ?? this.host.now();
    super.finish(end);
    for (const s of this.open) {
      s.status ??= 'cancelled';
      s.finish(this.endTimestamp!);
    }
    this.open.clear();
    this.host.onTransactionFinish(this);
  }
}

/** OpenTelemetry's HTTP → span status mapping (monitoring-v1 §8). */
export function statusFromHttp(code: number): SpanStatus {
  if (code >= 100 && code < 400) return 'ok';
  switch (code) {
    case 400:
      return 'invalid_argument';
    case 401:
      return 'unauthenticated';
    case 403:
      return 'permission_denied';
    case 404:
      return 'not_found';
    case 409:
      return 'already_exists';
    case 413:
      return 'failed_precondition';
    case 429:
      return 'resource_exhausted';
    case 499:
      return 'cancelled';
    case 501:
      return 'unimplemented';
    case 503:
      return 'unavailable';
    case 504:
      return 'deadline_exceeded';
  }
  if (code >= 400 && code < 500) return 'invalid_argument';
  if (code >= 500 && code < 600) return 'internal_error';
  return 'unknown';
}

export type TracesSampler = (context: TracesSamplingContext) => number | boolean;

/** The sampling decision at a trace's root: sampler, else the parent's decision, else the rate. */
export function sampleTrace(
  context: TracesSamplingContext,
  options: { tracesSampler?: TracesSampler | undefined; rate: number | null | undefined; random: () => number },
): { sampled: boolean; rate: number } {
  let rate: number;
  if (options.tracesSampler) {
    let r: number | boolean;
    try {
      r = options.tracesSampler(context);
    } catch {
      r = 0;
    }
    rate = typeof r === 'boolean' ? (r ? 1 : 0) : Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0;
  } else if (context.parentSampled !== undefined) {
    return { sampled: context.parentSampled, rate: context.parentSampled ? 1 : 0 };
  } else {
    rate = Math.min(1, Math.max(0, options.rate ?? 0));
  }
  return { sampled: rate > 0 && options.random() < rate, rate };
}

export interface PropagationContext {
  traceId: string;
  /** Span id of the incoming parent (`continueTrace`), else null. */
  parentSpanId: string | null;
  /** Span id used for `traceparent` when no span is active. */
  spanId: string;
  sampled: boolean | undefined;
  /** Incoming `bugcapsule-*` baggage entries, forwarded unchanged. */
  baggage: Record<string, string> | null;
}

export function newPropagationContext(): PropagationContext {
  return { traceId: newTraceId(), parentSpanId: null, spanId: newSpanId(), sampled: undefined, baggage: null };
}

/** `00-<32 hex>-<16 hex>-<2 hex>`; null when malformed. */
export function parseTraceparent(header: string | null | undefined): { traceId: string; parentSpanId: string; sampled: boolean } | null {
  const m = /^\s*([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})\s*$/.exec(header ?? '');
  if (!m || m[1] === 'ff' || !isTraceId(m[2]!) || !isSpanId(m[3]!)) return null;
  return { traceId: m[2]!, parentSpanId: m[3]!, sampled: (Number.parseInt(m[4]!, 16) & 1) === 1 };
}

/** The `bugcapsule-*` members of a `baggage` header (values decoded). */
export function parseBaggage(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const member of (header ?? '').split(',')) {
    const [kv] = member.split(';');
    const i = kv?.indexOf('=') ?? -1;
    if (!kv || i <= 0) continue;
    const key = kv.substring(0, i).trim();
    if (!key.startsWith('bugcapsule-')) continue;
    try {
      out[key] = decodeURIComponent(kv.substring(i + 1).trim());
    } catch {
      // malformed member
    }
  }
  return out;
}

/** monitoring-v1 §8 `baggage` members for a trace. */
export function baggageFor(entries: { traceId: string; release?: string | undefined; environment: string; sampleRate?: number | undefined; sampled?: boolean | undefined }): string {
  const parts: [string, string][] = [['bugcapsule-trace_id', entries.traceId]];
  if (entries.release) parts.push(['bugcapsule-release', entries.release]);
  parts.push(['bugcapsule-environment', entries.environment]);
  if (entries.sampleRate !== undefined) parts.push(['bugcapsule-sample_rate', String(entries.sampleRate)]);
  if (entries.sampled !== undefined) parts.push(['bugcapsule-sampled', String(entries.sampled)]);
  return parts.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join(',');
}

/** Keeps existing members; adds ours unless the header already carries `bugcapsule-*` members. */
export function mergeBaggage(existing: string | null | undefined, ours: string): string {
  const current = (existing ?? '').trim();
  if (!current) return ours;
  if (/(^|,)\s*bugcapsule-/.test(current)) return current;
  return `${current},${ours}`;
}

/** `"/api/"` substring, `"/^https:\/\/api\./"` pattern string, or a RegExp. */
export type PropagationTarget = string | RegExp;

export function compileTargets(targets: readonly PropagationTarget[]): (string | RegExp)[] {
  return targets.map((t) => {
    if (typeof t !== 'string') return t;
    const m = /^\/(.+)\/([a-z]*)$/.exec(t);
    if (!m) return t;
    try {
      return new RegExp(m[1]!, m[2]);
    } catch {
      return t;
    }
  });
}

/**
 * Whether `url` gets `traceparent`/`baggage`: null targets mean same
 * origin as the page (monitoring-v1 §8 web default).
 */
export function shouldPropagate(url: string, targets: readonly (string | RegExp)[] | null, pageOrigin: string | null): boolean {
  if (targets === null) {
    if (!pageOrigin) return false;
    try {
      return new URL(url, pageOrigin).origin === pageOrigin;
    } catch {
      return false;
    }
  }
  return targets.some((t) => (typeof t === 'string' ? url.includes(t) : t.test(url)));
}

const ID_SEGMENT = [
  /^\d+$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^(?=.*\d)[0-9a-f]{8,}$/i,
  /^(?=.*\d)(?=.*[a-z])[A-Za-z0-9_-]{16,}$/i,
];

/**
 * A transaction name from a path when no route pattern is known: query and
 * hash dropped, id-like segments (numbers, UUIDs, hashes, long tokens)
 * replaced by `:id`, so names never carry ids (monitoring-v1 §8).
 */
export function parameterizePath(location: string): string {
  let path = location;
  try {
    path = new URL(location, 'http://x').pathname;
  } catch {
    path = location.split(/[?#]/)[0] ?? location;
  }
  const out = path
    .split('/')
    .map((seg) => {
      let decoded = seg;
      try {
        decoded = decodeURIComponent(seg);
      } catch {
        // keep as is
      }
      return ID_SEGMENT.some((r) => r.test(decoded)) ? ':id' : seg;
    })
    .join('/');
  return (out || '/').substring(0, 200);
}

const detachedHost: SpanHost = { now: epochNow, onTransactionFinish: () => {} };

/** A span that is never sent (monitoring off or not initialized), so callers need no null checks. */
export function detachedTransaction(options: TransactionOptions): Transaction {
  return new Transaction(newTraceId(), null, false, 0, options, detachedHost);
}
