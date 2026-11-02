import type { CapsuleEvent, Checkpoint, CheckpointKind } from './model.js';

/** The checkpoint plus the events that follow it: what a capsule replays. */
export interface RecordedWindow {
  checkpoint: Checkpoint;
  events: CapsuleEvent[];
  /** Events evicted from the buffer over the whole session. */
  droppedEvents: number;
  /** No retained checkpoint covers the oldest retained event. */
  hasGap: boolean;
}

/** Default budget of retained event payload (BC-ENT-036). */
export const DEFAULT_RECORDER_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Approximate retained size of an event payload: string lengths plus a small
 * per-value overhead, without serializing it. Depth-capped so a pathological
 * object cannot make recording expensive.
 */
export function approxBytes(v: unknown, depth = 0): number {
  if (typeof v === 'string') return v.length + 2;
  if (v === null || typeof v !== 'object') return 8;
  if (depth > 16) return 16;
  if (ArrayBuffer.isView(v)) return v.byteLength;
  let n = 2;
  if (Array.isArray(v)) {
    for (const x of v) n += approxBytes(x, depth + 1) + 1;
    return n;
  }
  for (const k in v) n += k.length + 4 + approxBytes((v as Record<string, unknown>)[k], depth + 1);
  return n;
}

const hasBody = (e: CapsuleEvent) => e.type === 'http' && ((e.data.responseBody ?? null) !== null || (e.data.requestBody ?? null) !== null);

/** An http event without its bodies, marked `truncated` (replay reports `network.noBody`). */
function withoutBodiesForBudget(data: Record<string, unknown>): Record<string, unknown> {
  const d: Record<string, unknown> = { ...data, requestBody: null, responseBody: null };
  if ((data.responseBody ?? null) !== null) d.bodyEncoding = 'truncated';
  if ((data.requestBody ?? null) !== null) d.requestEncoding = 'truncated';
  return d;
}

/**
 * Bounded event buffer with checkpoints (port of `flight_recorder.dart`).
 * While nothing was evicted, the window is the launch checkpoint plus every
 * event; afterwards it starts at the earliest periodic checkpoint taken after
 * the last evicted event.
 *
 * Bounds: `maxEvents`, `windowMs`, and `maxBytes` of retained event payload
 * (approximate, see {@link approxBytes}). Over the byte budget, HTTP bodies
 * are dropped oldest first; only when no body is left are the oldest events
 * evicted (counted like other evictions). Either sets {@link truncated}.
 */
export class FlightRecorder {
  private launch: Checkpoint;
  private events: CapsuleEvent[] = [];
  private head = 0;
  private periodic: Checkpoint[] = [];
  private seq = 0;
  private dropped = 0;
  private lastEvictedSeq = 0;
  /** Events removed by {@link rewrite} over the session. */
  rewriteDropped = 0;
  /** Approximate payload size of each event in {@link events} (same indices). */
  private sizes: number[] = [];
  private retained = 0;
  /** Index of the oldest event that may still carry a body. */
  private bodyCursor = 0;
  /** HTTP events whose bodies were dropped for the byte budget, over the session. */
  bodiesDropped = 0;
  /** Events evicted for the byte budget, over the session (also in {@link droppedEvents}). */
  bytesEvicted = 0;

  constructor(
    launch: Checkpoint,
    readonly maxEvents = 20_000,
    readonly windowMs = 5 * 60 * 1000,
    readonly maxCheckpoints = 4,
    readonly maxBytes = DEFAULT_RECORDER_MAX_BYTES,
  ) {
    this.launch = launch;
  }

  /** Approximate payload bytes of the retained events. */
  get retainedBytes(): number {
    return this.retained;
  }

  /** The byte budget dropped bodies or events this session. */
  get truncated(): boolean {
    return this.bodiesDropped > 0 || this.bytesEvicted > 0;
  }

  get lastSeq(): number {
    return this.seq;
  }
  get eventCount(): number {
    return this.events.length - this.head;
  }
  get droppedEvents(): number {
    return this.dropped;
  }
  get launchCoversWindow(): boolean {
    return this.dropped === 0;
  }

  add(t: number, type: string, data: Record<string, unknown> = {}): CapsuleEvent {
    const event = { seq: ++this.seq, t, type, data };
    const size = approxBytes(data);
    this.events.push(event);
    this.sizes.push(size);
    this.retained += size;
    this.evict(t);
    if (this.retained > this.maxBytes) this.enforceBudget();
    return event;
  }

  addCheckpoint(checkpoint: Checkpoint): void {
    this.periodic.push(checkpoint);
    this.prune();
  }

  /** Rewrites retained events and checkpoints in place (seq and t kept; null drops, counted in {@link rewriteDropped} unless `countDropped: false`). */
  rewrite(opts: { event?: (e: CapsuleEvent) => CapsuleEvent | null; checkpoint?: (c: Checkpoint) => Checkpoint; countDropped?: boolean }): void {
    if (opts.event) {
      const updated: CapsuleEvent[] = [];
      for (const e of this.live()) {
        const r = opts.event(e);
        if (r !== null) updated.push(r);
        else if (opts.countDropped !== false) this.rewriteDropped++;
      }
      this.events = updated;
      this.head = 0;
      this.sizes = updated.map((e) => approxBytes(e.data));
      this.retained = this.sizes.reduce((a, b) => a + b, 0);
      this.bodyCursor = 0;
    }
    if (opts.checkpoint) {
      this.launch = opts.checkpoint(this.launch);
      this.periodic = this.periodic.map(opts.checkpoint);
    }
  }

  checkpointNow(kind: CheckpointKind, t: number, wallClockMs: number, data: Record<string, unknown>): Checkpoint {
    return { kind, t, wallClockMs, afterSeq: this.seq, data };
  }

  window(): RecordedWindow {
    if (this.launchCoversWindow) {
      return { checkpoint: this.launch, events: this.live(), droppedEvents: 0, hasGap: false };
    }
    let chosen = this.periodic.find((cp) => cp.afterSeq >= this.lastEvictedSeq) ?? null;
    const hasGap = chosen === null;
    chosen ??= this.periodic.length > 0 ? this.periodic[this.periodic.length - 1]! : this.launch;
    const from = chosen.afterSeq;
    return {
      checkpoint: chosen,
      events: this.live().filter((e) => e.seq > from),
      droppedEvents: this.dropped,
      hasGap,
    };
  }

  private live(): CapsuleEvent[] {
    return this.events.slice(this.head);
  }

  private evict(now: number): void {
    while (this.head < this.events.length) {
      const first = this.events[this.head]!;
      if (this.events.length - this.head <= this.maxEvents && first.t >= now - this.windowMs) break;
      this.evictHead();
    }
    this.compact();
    if (this.dropped > 0) this.prune();
  }

  private evictHead(): void {
    this.lastEvictedSeq = this.events[this.head]!.seq;
    this.retained -= this.sizes[this.head]!;
    this.head++;
    this.dropped++;
  }

  /** Compact occasionally so the arrays do not grow without bound. */
  private compact(): void {
    if (this.head > 4096 && this.head * 2 > this.events.length) {
      this.events = this.events.slice(this.head);
      this.sizes = this.sizes.slice(this.head);
      this.bodyCursor = Math.max(0, this.bodyCursor - this.head);
      this.head = 0;
    }
  }

  /** Over budget: drop bodies oldest first, then evict the oldest events. */
  private enforceBudget(): void {
    let i = Math.max(this.bodyCursor, this.head);
    for (; i < this.events.length && this.retained > this.maxBytes; i++) {
      const e = this.events[i]!;
      if (!hasBody(e)) continue;
      const stripped = { ...e, data: withoutBodiesForBudget(e.data) };
      const size = approxBytes(stripped.data);
      this.retained += size - this.sizes[i]!;
      this.sizes[i] = size;
      this.events[i] = stripped;
      this.bodiesDropped++;
    }
    this.bodyCursor = i;
    let evicted = false;
    while (this.retained > this.maxBytes && this.head < this.events.length) {
      this.evictHead();
      this.bytesEvicted++;
      evicted = true;
    }
    if (evicted) {
      this.compact();
      this.prune();
    }
  }

  private prune(): void {
    const firstValid = this.periodic.findIndex((cp) => cp.afterSeq >= this.lastEvictedSeq);
    const keepFrom = firstValid === -1 ? this.periodic.length - 1 : firstValid;
    if (keepFrom > 0) this.periodic.splice(0, keepFrom);
    while (this.periodic.length > this.maxCheckpoints) this.periodic.shift();
  }
}
