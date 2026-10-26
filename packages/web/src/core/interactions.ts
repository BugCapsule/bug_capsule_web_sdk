import { canonicalJson, fnvHash, isObject, utf8Encode } from './json.js';
import type { CapsuleEvent, DependencyGap } from './model.js';
import type { Redactor } from './redaction.js';
import { TypedValue } from './typed-value.js';

/**
 * Interaction dependencies (spec capsule-v2; port of `interactions.dart`):
 * payload encoding, interaction keys and the replay scheduler every adapter
 * shares. Checked by spec-fixtures/conformance/interactions.json.
 */

/** Event types of the interaction families (capsule-v2 §4). */
export const InteractionTypes = Object.freeze({
  wsConnect: 'ws.connect',
  wsOpen: 'ws.open',
  wsSend: 'ws.send',
  wsMessage: 'ws.message',
  wsError: 'ws.error',
  wsClose: 'ws.close',

  platformCall: 'platform.call',
  platformResult: 'platform.result',
  platformError: 'platform.error',
  platformListen: 'platform.listen',
  platformEvent: 'platform.event',
  platformCancel: 'platform.cancel',
  platformDone: 'platform.done',

  nativeCall: 'native.call',
  nativeResult: 'native.result',
  nativeError: 'native.error',
  nativeSubscribe: 'native.subscribe',
  nativeEvent: 'native.event',
  nativeCancel: 'native.cancel',
  nativeDone: 'native.done',

  /** Data fields that hold payload objects. */
  payloadFields: Object.freeze(['payload', 'args', 'value', 'details']),
});

export type InteractionFamily = 'ws' | 'platform' | 'native';

/** `ws`, `platform` or `native` for an interaction event type, else null. */
export function interactionFamily(type: string): InteractionFamily | null {
  if (type.startsWith('ws.')) return 'ws';
  if (type.startsWith('platform.')) return 'platform';
  if (type.startsWith('native.')) return 'native';
  return null;
}

export function isInteraction(type: string): boolean {
  return interactionFamily(type) !== null;
}

/** `manifest.dependencies[].kind`. */
export const DependencyKinds = Object.freeze({
  websocket: 'websocket',
  platformChannel: 'platform.channel',
  native: 'native',
});

/** Gap codes of capsule-v2 §7. */
export const DependencyGaps = Object.freeze({
  payloadTruncated: 'payload.truncated',
  payloadDropped: 'payload.dropped',
  payloadBinaryMetadata: 'payload.binaryMetadata',
  payloadRedacted: 'payload.redacted',
  connectionsLimit: 'connections.limit',
  codecUnsupported: 'codec.unsupported',
  channelLate: 'channel.late',
  captureFailed: 'adapter.captureFailed',
  eventsDropped: 'events.dropped',
  /** The app used an operation the adapter does not record (it reached the real dependency while capturing and fails in replay). */
  operationUnsupported: 'operation.unsupported',
});

export type PayloadMode = 'full' | 'redacted' | 'metadata' | 'omitted' | 'truncated';
const PAYLOAD_MODES: readonly string[] = ['full', 'redacted', 'metadata', 'omitted', 'truncated'];

/** A payload object (capsule-v2 §3). `value` is typed-value JSON ({@link TypedValue}). */
export interface InteractionPayload {
  mode: PayloadMode;
  replayable: boolean;
  value?: unknown;
  bytes?: number;
  /** `text`, `binary`, or absent (`value`). */
  kind?: string;
}

/** Null when `json` is not a payload object. */
export function parsePayload(json: unknown): InteractionPayload | null {
  if (!isObject(json)) return null;
  if (typeof json.mode !== 'string' || !PAYLOAD_MODES.includes(json.mode) || typeof json.replayable !== 'boolean') return null;
  const out: InteractionPayload = { mode: json.mode as PayloadMode, replayable: json.replayable };
  if ('value' in json) out.value = json.value;
  if (typeof json.bytes === 'number') out.bytes = json.bytes;
  if (typeof json.kind === 'string') out.kind = json.kind;
  return out;
}

/**
 * Whether two payloads carry the same value (canonical JSON), for mismatch
 * checks. Non-replayable payloads compare by size and kind.
 */
export function samePayload(a: InteractionPayload, b: InteractionPayload): boolean {
  if (!a.replayable || !b.replayable) return a.bytes === b.bytes && a.kind === b.kind;
  return canonicalJson(a.value ?? null) === canonicalJson(b.value ?? null);
}

/** The capsule form of a payload (`value` only when replayable or kept as a preview). */
export function payloadToJson(p: InteractionPayload): Record<string, unknown> {
  return {
    mode: p.mode,
    replayable: p.replayable,
    ...(p.replayable || (p.value !== undefined && p.value !== null) ? { value: p.value ?? null } : {}),
    ...(p.bytes !== undefined ? { bytes: p.bytes } : {}),
    ...(p.kind !== undefined ? { kind: p.kind } : {}),
  };
}

/** Bounds of capsule-v2 §7. */
export interface InteractionLimits {
  /** Per payload (encoded JSON, UTF-16 code units as the Dart reference counts them). Default 64 KiB. */
  maxPayloadBytes: number;
  /** Interaction payloads retained in the recorder window, all adapters. Default 1 MiB. */
  maxWindowPayloadBytes: number;
  /** Captured connections and subscriptions open at the same time. Default 32. */
  maxActive: number;
  /** Matches the flight recorder window: older payloads no longer count. Default 5 min. */
  windowMs: number;
}

export const DEFAULT_INTERACTION_LIMITS: Readonly<InteractionLimits> = Object.freeze({
  maxPayloadBytes: 64 * 1024,
  maxWindowPayloadBytes: 1024 * 1024,
  maxActive: 32,
  windowMs: 5 * 60 * 1000,
});

/** Limits with lower values from `lower` (an SDK or remote config may only lower them). */
export function lowerLimits(base: InteractionLimits, lower: Partial<InteractionLimits>): InteractionLimits {
  const min = (a: number, b: number | undefined) => (b === undefined || !(b < a) ? a : Math.max(0, b));
  return {
    maxPayloadBytes: min(base.maxPayloadBytes, lower.maxPayloadBytes),
    maxWindowPayloadBytes: min(base.maxWindowPayloadBytes, lower.maxWindowPayloadBytes),
    maxActive: min(base.maxActive, lower.maxActive),
    windowMs: base.windowMs,
  };
}

/** Shared payload byte budget of a session: a rolling window so a long session keeps recording recent traffic. */
export class PayloadBudget {
  private readonly spent: [number, number][] = [];
  private head = 0;
  private total = 0;

  constructor(public limits: InteractionLimits = { ...DEFAULT_INTERACTION_LIMITS }) {}

  spend(now: number, bytes: number): boolean {
    while (this.head < this.spent.length && this.spent[this.head]![0] < now - this.limits.windowMs) {
      this.total -= this.spent[this.head]![1];
      this.head++;
    }
    if (this.head > 1024 && this.head * 2 > this.spent.length) {
      this.spent.splice(0, this.head);
      this.head = 0;
    }
    if (this.total + bytes > this.limits.maxWindowPayloadBytes) return false;
    this.spent.push([now, bytes]);
    this.total += bytes;
    return true;
  }
}

/** Per-dependency capture bookkeeping: gaps and stats for the manifest. */
export class DependencyStats {
  events = 0;
  payloadBytes = 0;
  dropped = 0;
  truncated = 0;
  private readonly gapMap = new Map<string, [number, string | undefined]>();

  gap(code: string, detail?: string): void {
    const [n, d] = this.gapMap.get(code) ?? [0, detail];
    this.gapMap.set(code, [n + 1, d ?? detail]);
  }

  get hasGaps(): boolean {
    return this.gapMap.size > 0;
  }

  get gaps(): DependencyGap[] {
    return [...this.gapMap].map(([code, [count, detail]]) => (detail === undefined ? { code, count } : { code, count, detail }));
  }

  toJson(): { events: number; payloadBytes: number; dropped: number; truncated: number } {
    return { events: this.events, payloadBytes: this.payloadBytes, dropped: this.dropped, truncated: this.truncated };
  }
}

function sizeOf(value: unknown, typed: unknown): number {
  if (typeof value === 'string') return utf8Encode(value).length;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return value.size;
  try {
    return JSON.stringify(typed).length;
  } catch {
    return 0;
  }
}

/**
 * Turns live values into payload objects: typed encoding, redaction, binary
 * policy, size limits and the shared budget (capsule-v2 §3, §7).
 */
export class PayloadEncoder {
  /** Binary values (byte frames, typed arrays) are kept only when true; otherwise recorded as metadata. */
  captureBinary: boolean;
  /** Whether a value the redactor changed can still be replayed (the app does not branch on the redacted fields). */
  redactedReplayable: boolean;
  private readonly redactor: () => Redactor;
  private readonly budget: PayloadBudget;
  private readonly stats: DependencyStats;
  private readonly now: () => number;

  constructor(options: {
    redactor: () => Redactor;
    budget: PayloadBudget;
    stats: DependencyStats;
    now: () => number;
    captureBinary?: boolean;
    redactedReplayable?: boolean;
  }) {
    this.redactor = options.redactor;
    this.budget = options.budget;
    this.stats = options.stats;
    this.now = options.now;
    this.captureBinary = options.captureBinary ?? false;
    this.redactedReplayable = options.redactedReplayable ?? false;
  }

  /**
   * Encodes `value`. `kind` is `text`/`binary` for WebSocket frames.
   * `redactedReplayable` overrides the encoder's setting for this payload.
   */
  encode(value: unknown, kind?: string, redactedReplayable?: boolean): InteractionPayload {
    const k = kind === undefined ? {} : { kind };
    let typed: unknown;
    try {
      typed = typeof value === 'string' && kind === 'text' ? value : TypedValue.encode(value);
    } catch {
      this.stats.gap(DependencyGaps.captureFailed, 'value could not be encoded');
      return { mode: 'omitted', replayable: false, ...k };
    }
    const size = sizeOf(value, typed);
    if (!this.captureBinary && (kind === 'binary' || TypedValue.hasBinary(typed))) {
      this.stats.gap(DependencyGaps.payloadBinaryMetadata, 'binary data recorded as metadata; register a serializer to keep it');
      return { mode: 'metadata', replayable: false, bytes: size, ...k };
    }
    const [redacted, changed] = TypedValue.redact(typed, this.redactor());
    const encoded = JSON.stringify(redacted) ?? 'null';
    if (encoded.length > this.budget.limits.maxPayloadBytes) {
      this.stats.truncated += 1;
      this.stats.gap(DependencyGaps.payloadTruncated);
      return { mode: 'truncated', replayable: false, bytes: size, ...k };
    }
    if (!this.budget.spend(this.now(), encoded.length)) {
      this.stats.dropped += 1;
      this.stats.gap(DependencyGaps.payloadDropped, 'capsule payload budget spent');
      return { mode: 'metadata', replayable: false, bytes: size, ...k };
    }
    this.stats.payloadBytes += encoded.length;
    if (changed) this.stats.gap(DependencyGaps.payloadRedacted);
    const replayable = TypedValue.isReplayable(redacted) && (!changed || (redactedReplayable ?? this.redactedReplayable));
    return { mode: changed ? 'redacted' : 'full', replayable, value: redacted, bytes: size, ...k };
  }

  /** The match-key input for `value`: encoded and redacted like a payload, whatever the capture limits. */
  keyInput(value: unknown): unknown {
    try {
      return TypedValue.redact(TypedValue.encode(value), this.redactor())[0];
    } catch {
      return typeof value;
    }
  }
}

/**
 * `<scope>|<method>|<hash of canonical args>` (capsule-v2 §5), with the
 * request-key hash (two 32-bit FNV-1a passes over canonical JSON).
 */
export function interactionKey(scope: string, method: string | null | undefined, argsJson: unknown): string {
  return `${scope}|${method ?? ''}|${fnvHash(canonicalJson(argsJson))}`;
}

/** Counts occurrences per key on the capture side. */
export class OccurrenceCounter {
  private readonly counts = new Map<string, number>();

  next(key: string): number {
    const n = this.counts.get(key) ?? 0;
    this.counts.set(key, n + 1);
    return n;
  }
}

/** A recorded interaction event plus its scheduling metadata. */
export class RecordedInteraction {
  /** For inbound events: the outbound event that releases it. */
  anchor: RecordedInteraction | null = null;
  consumed = false;
  /** Replay-clock time this event was matched (outbound) or delivered. */
  at: number | null = null;
  dueAt: number | null = null;

  constructor(
    readonly event: CapsuleEvent,
    readonly scope: string,
    readonly outbound: boolean,
  ) {}

  get type(): string {
    return this.event.type;
  }
  get family(): InteractionFamily {
    return interactionFamily(this.event.type)!;
  }
  get data(): Record<string, unknown> {
    return this.event.data;
  }
  get dep(): string {
    return this.data.dep as string;
  }

  payload(field: string): InteractionPayload | null {
    return parsePayload(this.data[field]);
  }

  toString(): string {
    return `${this.event.type}#${this.event.seq}`;
  }
}

/**
 * The scheduling scope and direction of an interaction event (§5): the scope
 * orders deliveries and is what an adapter binds a handler to.
 */
export function interactionScope(e: CapsuleEvent, callDirections: ReadonlyMap<string, string>): [string, boolean] | null {
  const d = e.data;
  switch (e.type) {
    case InteractionTypes.wsConnect:
    case InteractionTypes.wsSend:
      return [`ws:${String(d.conn)}`, true];
    case InteractionTypes.wsClose:
      return [`ws:${String(d.conn)}`, d.initiator === 'client'];
    case InteractionTypes.wsOpen:
    case InteractionTypes.wsMessage:
    case InteractionTypes.wsError:
      return [`ws:${String(d.conn)}`, false];
    case InteractionTypes.platformCall:
      return d.dir === 'platform' ? [`platform.in:${String(d.channel)}`, false] : [`platform.call:${String(d.call)}`, true];
    case InteractionTypes.platformResult:
    case InteractionTypes.platformError:
      // The reply to a platform-to-app call is the app's own (outbound).
      return [`platform.call:${String(d.call)}`, callDirections.get(String(d.call)) === 'platform'];
    case InteractionTypes.platformListen:
    case InteractionTypes.platformCancel:
      return [`platform.sub:${String(d.sub)}`, true];
    case InteractionTypes.platformEvent:
    case InteractionTypes.platformDone:
      return [`platform.sub:${String(d.sub)}`, false];
    case InteractionTypes.nativeCall:
      return [`native.op:${String(d.op)}`, true];
    case InteractionTypes.nativeResult:
      return [`native.op:${String(d.op)}`, false];
    case InteractionTypes.nativeError:
      return d.sub !== undefined && d.sub !== null ? [`native.sub:${String(d.sub)}`, false] : [`native.op:${String(d.op)}`, false];
    case InteractionTypes.nativeSubscribe:
    case InteractionTypes.nativeCancel:
      return [`native.sub:${String(d.sub)}`, true];
    case InteractionTypes.nativeEvent:
    case InteractionTypes.nativeDone:
      return [`native.sub:${String(d.sub)}`, false];
  }
  return null;
}

export interface InteractionScriptOptions {
  /** Dependency ids replay serves (required dependencies with an installed adapter). */
  dependencies: ReadonlySet<string>;
  /** Replay clock in milliseconds (monotonic, includes skipped idle time). */
  clock: () => number;
  /** Recorded time replay starts from: 0 for a launch checkpoint, the checkpoint time for a periodic one. */
  base?: number;
  /** How long a due event may wait for its scope's handler (default 5 s). */
  maxHandlerWaitMs?: number;
}

/**
 * Replay of interaction dependencies (capsule-v2 §5), without timers: the
 * runtime calls {@link pump} when {@link nextDueAt} arrives. Same semantics
 * as the Dart `InteractionScript`.
 *
 * Adapters consume outbound expectations with {@link take} (keyed
 * operations: connects, calls, listens) or {@link takeNext} (ordered
 * operations within a scope: sends, cancels, replies), and {@link bind} a
 * handler to a scope to receive its inbound events. Each inbound event is
 * released by its anchor (the latest outbound event of its scope before it)
 * and delivered `t(inbound) - t(anchor)` after the anchor was matched;
 * events without an anchor follow the replay clock once {@link runStarted}.
 *
 * An operation the app performs inside a delivery handler (a send in
 * `onopen`, a reply in `onmessage`) is matched at that delivery's due time
 * rather than whenever the timer actually fired, so chains of recorded
 * reactions keep their recorded spacing. (The Dart driver of the shared
 * conformance cases never matches inside handlers; results are identical.)
 */
export class InteractionScript {
  readonly clock: () => number;
  readonly base: number;
  readonly maxHandlerWaitMs: number;
  private readonly allEvents: RecordedInteraction[] = [];
  private readonly keyed = new Map<string, RecordedInteraction[]>();
  private readonly ordered = new Map<string, RecordedInteraction[]>();
  private readonly released = new Map<RecordedInteraction, RecordedInteraction[]>();
  private readonly unanchored: RecordedInteraction[] = [];
  private pending: RecordedInteraction[] = [];
  private readonly handlers = new Map<string, (r: RecordedInteraction) => void>();
  private readonly lastDue = new Map<string, number>();
  private readonly divergences: [string, string][] = [];
  private runStart: number | null = null;
  /** Due time of the delivery whose handler is running. */
  private delivering: number | null = null;

  constructor(events: Iterable<CapsuleEvent>, options: InteractionScriptOptions) {
    this.clock = options.clock;
    this.base = options.base ?? 0;
    this.maxHandlerWaitMs = options.maxHandlerWaitMs ?? 5000;
    const list = [...events];
    const calls = new Map<string, string>();
    for (const e of list) {
      if (e.type === InteractionTypes.platformCall) calls.set(String(e.data.call), String(e.data.dir));
    }
    const lastOutbound = new Map<string, RecordedInteraction>();
    for (const e of list) {
      if (!isInteraction(e.type)) continue;
      if (!options.dependencies.has(e.data.dep as string)) continue;
      if (e.data.diagnostic === true) continue;
      const scoped = interactionScope(e, calls);
      if (!scoped) continue;
      const [scope, outbound] = scoped;
      const r = new RecordedInteraction(e, scope, outbound);
      this.allEvents.push(r);
      const channelScope = e.type.startsWith('platform.') ? `channel:${String(e.data.channel)}` : null;
      if (outbound) {
        lastOutbound.set(scope, r);
        if (channelScope !== null) lastOutbound.set(channelScope, r);
        const key = e.data.key;
        if (typeof key === 'string') push(this.keyed, `${r.dep}|${e.type}|${key}`, r);
        else push(this.ordered, scope, r);
      } else {
        r.anchor = (e.type === InteractionTypes.platformCall ? (channelScope === null ? undefined : lastOutbound.get(channelScope)) : lastOutbound.get(scope)) ?? null;
        if (r.anchor === null) this.unanchored.push(r);
        else push(this.released, r.anchor, r);
      }
    }
  }

  /** Recorded interactions (for preflight and inspection). */
  get all(): readonly RecordedInteraction[] {
    return this.allEvents;
  }

  get isEmpty(): boolean {
    return this.allEvents.length === 0;
  }

  /** Divergences found while scheduling (undelivered events), drained by the runtime. */
  takeDivergences(): [string, string][] {
    return this.divergences.splice(0, this.divergences.length);
  }

  /**
   * Matches a keyed outbound operation (`ws.connect`, `platform.call`,
   * `platform.listen`, `native.call`, `native.subscribe`) by key and
   * invocation order. Null: nothing recorded (the caller reports
   * `<family>.unrecorded` and fails the operation).
   */
  take(dep: string, type: string, key: string): RecordedInteraction | null {
    const queue = this.keyed.get(`${dep}|${type}|${key}`);
    if (!queue) return null;
    while (queue.length > 0) {
      const r = queue.shift()!;
      if (r.consumed) continue;
      this.consume(r);
      return r;
    }
    return null;
  }

  /** Unmatched keyed operations of `type` in `dep` whose key starts with `prefix`. */
  hasUnconsumed(dep: string, type: string, prefix: string): boolean {
    for (const [k, queue] of this.keyed) {
      if (!k.startsWith(`${dep}|${type}|${prefix}`)) continue;
      if (queue.some((r) => !r.consumed)) return true;
    }
    return false;
  }

  /**
   * Matches the next unconsumed outbound event of `types` in `scope`, in
   * recorded order (sends on a connection, a client close, a cancel, the
   * app's reply to a platform call).
   */
  takeNext(scope: string, types: ReadonlySet<string> | readonly string[]): RecordedInteraction | null {
    const list = this.ordered.get(scope);
    if (!list) return null;
    const wanted = types instanceof Set ? types : new Set(types as readonly string[]);
    for (const r of list) {
      if (r.consumed || !wanted.has(r.type)) continue;
      this.consume(r);
      return r;
    }
    return null;
  }

  private consume(r: RecordedInteraction): void {
    const now = this.delivering ?? this.clock();
    r.consumed = true;
    r.at = now;
    for (const inbound of this.released.get(r) ?? []) this.schedule(inbound, now + (inbound.event.t - r.event.t));
  }

  private schedule(r: RecordedInteraction, due: number): void {
    const last = this.lastDue.get(r.scope);
    const at = last !== undefined && last > due ? last : due;
    this.lastDue.set(r.scope, at);
    r.dueAt = at;
    this.pending.push(r);
  }

  /**
   * Replay of recorded input started at replay time `at`, which corresponds
   * to recorded time {@link base}. Events without an anchor become due on
   * this clock.
   */
  runStarted(at: number): void {
    this.runStart = at;
    for (const r of this.unanchored) {
      if (r.dueAt === null && !r.consumed) this.schedule(r, at + (r.event.t - this.base));
    }
    this.pending.sort(byDue);
  }

  /** Unanchored events recorded before the replayed window are due as soon as their handler exists. */
  private scheduleEarly(scope: string): void {
    if (this.runStart !== null) return;
    for (const r of this.unanchored) {
      if (r.scope !== scope || r.dueAt !== null || r.consumed) continue;
      if (r.event.t < this.base) this.schedule(r, this.clock());
    }
  }

  /** Delivers inbound events of `scope` to `handler` from now on (and any already due). */
  bind(scope: string, handler: (r: RecordedInteraction) => void): void {
    this.handlers.set(scope, handler);
    this.scheduleEarly(scope);
  }

  unbind(scope: string): void {
    this.handlers.delete(scope);
  }

  isBound(scope: string): boolean {
    return this.handlers.has(scope);
  }

  /**
   * Earliest time an event is due whose handler is bound; null when nothing
   * is scheduled. Events waiting for a handler do not count (an open but
   * idle subscription must not hold replay busy).
   */
  get nextDueAt(): number | null {
    let next: number | null = null;
    for (const r of this.pending) {
      if (!this.handlers.has(r.scope)) continue;
      if (next === null || r.dueAt! < next) next = r.dueAt!;
    }
    return next;
  }

  /** Whether any scheduled event waits for a handler. */
  get hasWaiting(): boolean {
    return this.pending.some((r) => !this.handlers.has(r.scope));
  }

  /** Delivers every event due at or before now, in (due, seq) order. Returns how many were delivered. */
  pump(): number {
    const now = this.clock();
    this.pending.sort(byDue);
    let delivered = 0;
    const keep: RecordedInteraction[] = [];
    const due: RecordedInteraction[] = [];
    for (const r of this.pending) {
      if (r.dueAt! > now) {
        keep.push(r);
        continue;
      }
      if (!this.handlers.has(r.scope)) {
        if (now - r.dueAt! > this.maxHandlerWaitMs) {
          r.consumed = true;
          this.divergences.push([`${r.family}.undelivered`, `${describe(r)}: no handler for ${now - r.dueAt!} ms`]);
        } else {
          keep.push(r);
        }
        continue;
      }
      due.push(r);
    }
    this.pending = keep;
    for (const r of due) {
      r.consumed = true;
      r.at = now;
      const handler = this.handlers.get(r.scope);
      if (!handler) {
        // Unbound by an earlier delivery in this batch (a close).
        this.pending.push(r);
        continue;
      }
      this.delivering = r.dueAt;
      try {
        handler(r);
      } finally {
        this.delivering = null;
      }
      delivered++;
    }
    return delivered;
  }

  /**
   * Unmatched and undelivered recorded interactions, grouped by family and
   * scope: `<family>.unused` when recorded at or before `failureT` (or with
   * no failure), `<family>.unusedAfterFailure` after it.
   */
  unused(failureT: number | null | undefined): [string, string][] {
    const groups = new Map<string, { family: string; after: boolean; scope: string; list: RecordedInteraction[] }>();
    for (const r of this.allEvents) {
      if (r.consumed) continue;
      const after = failureT !== null && failureT !== undefined && r.event.t > failureT;
      const k = `${r.family}\u0000${after}\u0000${r.scope}`;
      let g = groups.get(k);
      if (!g) groups.set(k, (g = { family: r.family, after, scope: r.scope, list: [] }));
      g.list.push(r);
    }
    return [...groups.values()].map((g) => [`${g.family}.${g.after ? 'unusedAfterFailure' : 'unused'}`, `${g.scope}: ${summary(g.list)}`]);
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function byDue(a: RecordedInteraction, b: RecordedInteraction): number {
  const c = a.dueAt! - b.dueAt!;
  return c !== 0 ? c : a.event.seq - b.event.seq;
}

function summary(list: RecordedInteraction[]): string {
  const counts = new Map<string, number>();
  for (const r of list) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
  const first = list[0]!.event.t;
  return `${[...counts].map(([type, n]) => (n > 1 ? `${type}×${n}` : type)).join(', ')} from ${first}ms`;
}

function describe(r: RecordedInteraction): string {
  return `${r.scope} ${r.type} @${r.event.t}ms`;
}
