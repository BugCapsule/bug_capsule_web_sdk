import type { CapsuleEvent } from './model.js';

/**
 * Decides when replay may jump over an idle stretch before an input (port of
 * `idle_compression.dart`): both the recording and the replayed app must be
 * idle. Recorded HTTP latency is never inside an idle stretch.
 */
export class IdleCompressor {
  constructor(
    readonly events: readonly CapsuleEvent[],
    readonly minGapMs = 1500,
    readonly collapseToMs = 300,
  ) {}

  /** Recorded time from which the recording is idle until the input at `to`, or null. */
  idleSince(from: number, to: number): number | null {
    if (to - from <= this.minGapMs) return null;
    let since = from;
    for (const e of this.events) {
      const start = e.type === 'http' ? e.t - ((e.data.durationMs as number | undefined) ?? 0) : e.t;
      if (start >= to) continue;
      const end = e.t < to ? e.t : to;
      if (end > since) since = end;
    }
    return to - since > this.minGapMs ? since : null;
  }

  maySkip(now: number, idleSince: number, busy: number, quietMs: number): boolean {
    return busy === 0 && quietMs >= this.collapseToMs && now >= idleSince + this.collapseToMs;
  }
}
