/**
 * Web vitals without a dependency (monitoring-v1 §8 measurements `lcp`,
 * `inp`, `cls`, `fcp`, `ttfb`), computed like the `web-vitals` library:
 *
 * * LCP: the last `largest-contentful-paint` entry before the first input
 *   or the page being hidden;
 * * CLS: the largest session window (shifts < 1 s apart, window ≤ 5 s) of
 *   `layout-shift` entries without recent input;
 * * INP: the longest interaction, or the 98th percentile (one per 50
 *   interactions skipped) when there are many;
 * * FCP: the `first-contentful-paint` entry; TTFB: `responseStart` of the
 *   navigation entry. All relative to `activationStart` (prerendering).
 */

interface LayoutShift {
  value: number;
  startTime: number;
  hadRecentInput: boolean;
}

export class ClsAccumulator {
  private sessionValue = 0;
  private sessionStart = 0;
  private lastTime = 0;
  value = 0;

  add(entry: LayoutShift): void {
    if (entry.hadRecentInput) return;
    if (this.sessionValue > 0 && entry.startTime - this.lastTime < 1000 && entry.startTime - this.sessionStart < 5000) {
      this.sessionValue += entry.value;
    } else {
      this.sessionValue = entry.value;
      this.sessionStart = entry.startTime;
    }
    this.lastTime = entry.startTime;
    if (this.sessionValue > this.value) this.value = this.sessionValue;
  }
}

interface EventTiming {
  interactionId?: number;
  duration: number;
  startTime: number;
}

export class InpAccumulator {
  private readonly longest = new Map<number, number>();
  private count = 0;
  /** Start time (ms since time origin) of the interaction that is the current INP. */
  startTime = 0;

  add(entry: EventTiming): void {
    const id = entry.interactionId;
    if (!id) return;
    const prev = this.longest.get(id);
    if (prev === undefined) this.count++;
    if (prev === undefined || entry.duration > prev) {
      this.longest.set(id, entry.duration);
      if (entry.duration >= (this.value ?? 0)) this.startTime = entry.startTime;
    }
    // Only the slowest interactions matter; keep the map small.
    if (this.longest.size > 50) {
      const smallest = [...this.longest.entries()].sort((a, b) => a[1] - b[1])[0]!;
      this.longest.delete(smallest[0]);
    }
  }

  get value(): number | null {
    if (this.longest.size === 0) return null;
    const sorted = [...this.longest.values()].sort((a, b) => b - a);
    return sorted[Math.min(sorted.length - 1, Math.floor(this.count / 50))]!;
  }
}

export interface VitalsSnapshot {
  lcp?: number;
  cls?: number;
  inp?: number;
  fcp?: number;
  ttfb?: number;
}

type PerformanceLike = Pick<Performance, 'getEntriesByType'>;

/** Collects vitals with `PerformanceObserver` (buffered), from `init` until the page is hidden. */
export class WebVitals {
  private lcp: number | null = null;
  private lcpFinal = false;
  private observesLayoutShift = false;
  readonly cls = new ClsAccumulator();
  readonly inp = new InpAccumulator();
  private observers: PerformanceObserver[] = [];
  private readonly undo: (() => void)[] = [];

  constructor(private readonly perf: PerformanceLike | undefined = globalThis.performance) {}

  private activationStart(): number {
    const nav = this.perf?.getEntriesByType?.('navigation')[0] as (PerformanceNavigationTiming & { activationStart?: number }) | undefined;
    return nav?.activationStart ?? 0;
  }

  start(): void {
    if (typeof PerformanceObserver === 'undefined') return;
    const observe = (type: string, cb: (entries: PerformanceEntry[]) => void, extra: Record<string, unknown> = {}) => {
      try {
        if (!PerformanceObserver.supportedEntryTypes?.includes(type)) return;
        const o = new PerformanceObserver((list) => cb(list.getEntries()));
        o.observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
        this.observers.push(o);
        if (type === 'layout-shift') this.observesLayoutShift = true;
      } catch {
        // unsupported in this browser
      }
    };
    observe('largest-contentful-paint', (entries) => {
      if (this.lcpFinal) return;
      const last = entries[entries.length - 1];
      if (last) this.lcp = Math.max(0, last.startTime - this.activationStart());
    });
    observe('layout-shift', (entries) => {
      for (const e of entries) this.cls.add(e as unknown as LayoutShift);
    });
    observe('event', (entries) => {
      for (const e of entries) this.inp.add(e as unknown as EventTiming);
    }, { durationThreshold: 40 });
    observe('first-input', (entries) => {
      for (const e of entries) this.inp.add(e as unknown as EventTiming);
    });
    if (typeof addEventListener === 'function') {
      const stopLcp = () => {
        this.lcpFinal = true;
      };
      for (const t of ['keydown', 'pointerdown'] as const) addEventListener(t, stopLcp, { once: true, capture: true, passive: true });
      this.undo.push(() => {
        for (const t of ['keydown', 'pointerdown'] as const) removeEventListener(t, stopLcp, { capture: true });
      });
    }
  }

  /** Called when the page is hidden: LCP stops changing. */
  hidden(): void {
    this.lcpFinal = true;
  }

  snapshot(): VitalsSnapshot {
    const out: VitalsSnapshot = {};
    const activation = this.activationStart();
    const nav = this.perf?.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (nav && nav.responseStart > 0) out.ttfb = Math.max(0, nav.responseStart - activation);
    const fcp = this.perf?.getEntriesByType?.('paint').find((e) => e.name === 'first-contentful-paint');
    if (fcp) out.fcp = Math.max(0, fcp.startTime - activation);
    if (this.lcp !== null) out.lcp = this.lcp;
    if (this.cls.value > 0 || this.observesLayoutShift) out.cls = Math.round(this.cls.value * 10_000) / 10_000;
    const inp = this.inp.value;
    if (inp !== null) out.inp = inp;
    return out;
  }

  stop(): void {
    for (const o of this.observers) o.disconnect();
    this.observers = [];
    for (const u of this.undo.splice(0)) u();
  }
}
