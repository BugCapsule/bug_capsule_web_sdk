import { describeThrown } from '../core/failure.js';
import { cut } from '../core/json.js';
import type { Redactor } from '../core/redaction.js';
import { framesOf, type InAppOptions } from './stack.js';
import type { Breadcrumb, EnvelopeItem, EventPayload, ExceptionValue, Mechanism, StackFrame } from './types.js';

/** monitoring-v1 §2 limits. */
export const EventLimits = Object.freeze({
  exceptionValues: 10,
  type: 200,
  value: 8192,
  message: 8192,
  fingerprint: 10,
  fingerprintPart: 200,
  tags: 50,
  tagValue: 200,
  breadcrumbs: 100,
  debugImages: 500,
  contextBytes: 64 * 1024,
  extraBytes: 64 * 1024,
  itemBytes: 1024 * 1024,
});

const TAG_KEY = /^[A-Za-z0-9_.:-]{1,32}$/;

/** Plain description of a thrown non-Error (`{code: 1}` → "Object captured as exception with keys: code"). */
function describeValue(error: unknown): { type: string; value: string; stack: string | null } {
  if (typeof error === 'object' && error !== null && !('message' in error)) {
    const ctor = (error as { constructor?: { name?: string } }).constructor?.name;
    const keys = Object.keys(error).slice(0, 10).join(', ');
    const type = ctor && ctor !== 'Object' ? ctor : 'Error';
    return { type, value: `Object captured as exception with keys: ${keys || '[none]'}`, stack: null };
  }
  const { type, message, stack } = describeThrown(error);
  return { type, value: message, stack };
}

/**
 * `exception.values` for a thrown value and its `cause` chain, innermost
 * cause first and the thrown error last (monitoring-v1 §2, Sentry order);
 * the mechanism is on the thrown error.
 */
export function exceptionValues(error: unknown, mechanism: Mechanism, inApp: InAppOptions): ExceptionValue[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (chain.length < EventLimits.exceptionValues && !seen.has(current)) {
    chain.push(current);
    if (typeof current === 'object' && current !== null) seen.add(current);
    const cause = typeof current === 'object' && current !== null ? (current as { cause?: unknown }).cause : undefined;
    if (cause === undefined || cause === null) break;
    current = cause;
  }
  const values = chain.map((e, i): ExceptionValue => {
    const { type, value, stack } = describeValue(e);
    const frames = framesOf(stack, inApp);
    return {
      type: cut(type || 'Error', EventLimits.type),
      value: cut(value, EventLimits.value),
      ...(i === 0 ? { mechanism } : {}),
      ...(frames.length ? { stacktrace: { frames } } : {}),
    };
  });
  return values.reverse();
}

/** Every frame of an event (for debug images). */
export function eventFrames(event: EventPayload): StackFrame[] {
  return (event.exception?.values ?? []).flatMap((v) => v.stacktrace?.frames ?? []);
}

/** `<type>: <value>` or the message: what the dashboard shows as the title. */
export function eventTitle(event: EventPayload): string {
  const last = event.exception?.values[event.exception.values.length - 1];
  const title = last ? (last.value ? `${last.type}: ${last.value}` : last.type) : (event.message?.formatted ?? '');
  return cut(title.split('\n')[0] ?? '', 200);
}

/**
 * A JSON-safe copy: cycles, functions, symbols, DOM nodes, BigInts and
 * errors become strings; depth and breadth are bounded.
 */
export function toJsonSafe(value: unknown, depth = 6, breadth = 100): unknown {
  const seen = new WeakSet<object>();
  const walk = (v: unknown, d: number): unknown => {
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
    if (typeof v === 'bigint') return `${v.toString()}n`;
    if (typeof v === 'undefined') return null;
    if (typeof v === 'function') return `[Function${v.name ? `: ${v.name}` : ''}]`;
    if (typeof v === 'symbol') return v.toString();
    if (typeof v !== 'object') return String(v);
    if (seen.has(v)) return '[Circular]';
    if (typeof Node !== 'undefined' && v instanceof Node) return `[${v.nodeName}]`;
    if (v instanceof Error) return `${v.name}: ${v.message}`;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString();
    if (d >= depth) return Array.isArray(v) ? '[Array]' : '[Object]';
    seen.add(v);
    try {
      if (Array.isArray(v)) return v.slice(0, breadth).map((x) => walk(x, d + 1));
      const out: Record<string, unknown> = {};
      let n = 0;
      for (const k of Object.keys(v)) {
        if (n++ >= breadth) break;
        let x: unknown;
        try {
          x = (v as Record<string, unknown>)[k];
        } catch {
          x = '[Unreadable]';
        }
        out[k] = walk(x, d + 1);
      }
      return out;
    } finally {
      seen.delete(v);
    }
  };
  return walk(value, 0);
}

function jsonLength(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** Keeps an object within `maxBytes` of JSON: the largest members become `"[Truncated]"`. */
export function boundObject<T extends Record<string, unknown>>(obj: T, maxBytes: number): T {
  const safe = toJsonSafe(obj) as Record<string, unknown>;
  if (jsonLength(safe) <= maxBytes) return safe as T;
  const sizes = Object.entries(safe)
    .map(([k, v]) => [k, jsonLength(v)] as const)
    .sort((a, b) => b[1] - a[1]);
  const out = { ...safe };
  for (const [k] of sizes) {
    out[k] = '[Truncated]';
    if (jsonLength(out) <= maxBytes) return out as T;
  }
  return {} as T;
}

export function normalizeTags(tags: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(tags ?? {})) {
    if (!TAG_KEY.test(k) || v === undefined || v === null) continue;
    if (n++ >= EventLimits.tags) break;
    out[k] = cut(String(v), EventLimits.tagValue);
  }
  return out;
}

/** Applies the documented maxima to an event (strings are cut, not rejected). */
export function normalizeEvent(event: EventPayload): EventPayload {
  const e: EventPayload = { ...event };
  if (e.exception) {
    e.exception = {
      values: e.exception.values.slice(-EventLimits.exceptionValues).map((v) => ({
        ...v,
        type: cut(String(v.type || 'Error'), EventLimits.type),
        ...(v.value !== undefined ? { value: cut(String(v.value), EventLimits.value) } : {}),
        ...(v.module !== undefined ? { module: cut(String(v.module), 200) } : {}),
        ...(v.stacktrace ? { stacktrace: { frames: v.stacktrace.frames.slice(-250) } } : {}),
      })),
    };
  }
  if (e.message) e.message = { ...e.message, formatted: cut(String(e.message.formatted), EventLimits.message) };
  if (e.fingerprint) {
    e.fingerprint = e.fingerprint.slice(0, EventLimits.fingerprint).map((f) => cut(String(f), EventLimits.fingerprintPart));
  }
  if (e.tags) e.tags = normalizeTags(e.tags);
  if (e.breadcrumbs) e.breadcrumbs = e.breadcrumbs.slice(-EventLimits.breadcrumbs).map((b) => ({ ...b, ...(b.data ? { data: toJsonSafe(b.data, 4) as Record<string, unknown> } : {}) }));
  if (e.debugImages) e.debugImages = e.debugImages.slice(0, EventLimits.debugImages);
  if (e.contexts) e.contexts = boundObject(e.contexts, EventLimits.contextBytes);
  if (e.extra) e.extra = boundObject(e.extra, EventLimits.extraBytes);
  if (e.user?.data) e.user = { ...e.user, data: boundObject(e.user.data, 16 * 1024) };
  if (e.release) e.release = cut(e.release, 200);
  e.environment = cut(e.environment || 'production', 64);
  return e;
}

/** Shrinks an item over 1 MiB of JSON: breadcrumbs, then extra, then spans go first. Null when it still does not fit. */
export function fitItem(item: EnvelopeItem, maxBytes = EventLimits.itemBytes): EnvelopeItem | null {
  if (jsonLength(item.payload) <= maxBytes) return item;
  const p = { ...(item.payload as unknown as Record<string, unknown>) };
  for (const key of ['breadcrumbs', 'extra', 'spans', 'debugImages', 'contexts']) {
    if (!(key in p)) continue;
    p[key] = Array.isArray(p[key]) ? [] : {};
    if (jsonLength(p) <= maxBytes) return { type: item.type, payload: p } as unknown as EnvelopeItem;
  }
  return null;
}

/** Fields that are ids or timestamps: redaction must never change them (they are validated by the server). */
const STRUCTURAL = ['eventId', 'sid', 'feedbackId', 'traceId', 'spanId', 'parentSpanId', 'capsuleId', 'timestamp', 'started', 'startTimestamp'];

function restore(target: Record<string, unknown> | undefined, source: Record<string, unknown> | undefined, keys: string[]): void {
  if (!target || !source) return;
  for (const k of keys) if (k in source) target[k] = source[k];
}

function redactUrlField(r: Redactor, obj: Record<string, unknown> | undefined, key: string): void {
  if (obj && typeof obj[key] === 'string') obj[key] = r.redactUrl(obj[key] as string);
}

/**
 * monitoring-v1 §1: the capsule redaction rules applied to every string of
 * an item before it is persisted (sensitive keys, URL parameters, free-text
 * credentials); URLs go through `redactUrl` first. Ids and timestamps are
 * restored afterwards so a value that merely looks like a card number
 * cannot invalidate the item.
 */
export function redactItem(redactor: Redactor, item: EnvelopeItem): EnvelopeItem {
  const original = item.payload as unknown as Record<string, unknown>;
  const pre = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
  const ev = pre as Partial<EventPayload> & Record<string, unknown>;
  if (ev.request && typeof ev.request === 'object') {
    redactUrlField(redactor, ev.request as unknown as Record<string, unknown>, 'url');
    if (ev.request.headers) ev.request.headers = redactor.redactHeaders(ev.request.headers);
  }
  redactUrlField(redactor, pre, 'url');
  for (const v of ev.exception?.values ?? []) {
    for (const f of v.stacktrace?.frames ?? []) redactUrlField(redactor, f as Record<string, unknown>, 'absPath');
  }
  for (const d of ev.debugImages ?? []) redactUrlField(redactor, d as unknown as Record<string, unknown>, 'codeFile');
  for (const b of (ev.breadcrumbs ?? []) as Breadcrumb[]) {
    for (const k of ['url', 'from', 'to']) redactUrlField(redactor, b.data, k);
  }
  for (const s of (pre.spans as Record<string, unknown>[] | undefined) ?? []) redactUrlField(redactor, s.data as Record<string, unknown> | undefined, 'url');

  const out = redactor.redactJson(pre);
  restore(out, original, STRUCTURAL);
  const outContexts = out.contexts as Record<string, Record<string, unknown>> | undefined;
  const inContexts = original.contexts as Record<string, Record<string, unknown>> | undefined;
  restore(outContexts?.trace, inContexts?.trace, ['traceId', 'spanId', 'parentSpanId']);
  const outSpans = out.spans as Record<string, unknown>[] | undefined;
  const inSpans = original.spans as Record<string, unknown>[] | undefined;
  outSpans?.forEach((s, i) => restore(s, inSpans?.[i], ['spanId', 'parentSpanId', 'startTimestamp', 'timestamp']));
  const outImages = out.debugImages as Record<string, unknown>[] | undefined;
  const inImages = original.debugImages as Record<string, unknown>[] | undefined;
  outImages?.forEach((d, i) => restore(d, inImages?.[i], ['debugId']));
  const outCrumbs = out.breadcrumbs as Record<string, unknown>[] | undefined;
  const inCrumbs = original.breadcrumbs as Record<string, unknown>[] | undefined;
  outCrumbs?.forEach((b, i) => restore(b, inCrumbs?.[i], ['timestamp']));
  return { type: item.type, payload: out } as unknown as EnvelopeItem;
}
