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

/**
 * Bounded event buffer with checkpoints (port of `flight_recorder.dart`).
 * While nothing was evicted, the window is the launch checkpoint plus every
 * event; afterwards it starts at the earliest periodic checkpoint taken after
 * the last evicted event.
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

  constructor(
    launch: Checkpoint,
    readonly maxEvents = 20_000,
    readonly windowMs = 5 * 60 * 1000,
    readonly maxCheckpoints = 4,
  ) {
    this.launch = launch;
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
    this.events.push(event);
    this.evict(t);
    return event;
  }

  addCheckpoint(checkpoint: Checkpoint): void {
    this.periodic.push(checkpoint);
    this.prune();
  }

  /** Rewrites retained events and checkpoints in place (seq and t kept; null drops). */
  rewrite(opts: { event?: (e: CapsuleEvent) => CapsuleEvent | null; checkpoint?: (c: Checkpoint) => Checkpoint }): void {
    if (opts.event) {
      const updated: CapsuleEvent[] = [];
      for (const e of this.live()) {
        const r = opts.event(e);
        if (r === null) this.rewriteDropped++;
        else updated.push(r);
      }
      this.events = updated;
      this.head = 0;
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
      this.lastEvictedSeq = first.seq;
      this.head++;
      this.dropped++;
    }
    // Compact occasionally so the array does not grow without bound.
    if (this.head > 4096 && this.head * 2 > this.events.length) {
      this.events = this.events.slice(this.head);
      this.head = 0;
    }
    if (this.dropped > 0) this.prune();
  }

  private prune(): void {
    const firstValid = this.periodic.findIndex((cp) => cp.afterSeq >= this.lastEvictedSeq);
    const keepFrom = firstValid === -1 ? this.periodic.length - 1 : firstValid;
    if (keepFrom > 0) this.periodic.splice(0, keepFrom);
    while (this.periodic.length > this.maxCheckpoints) this.periodic.shift();
  }
}
