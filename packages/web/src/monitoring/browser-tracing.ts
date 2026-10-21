import type { Redactor } from '../core/redaction.js';
import { iso } from './ids.js';
import type { Transaction } from './tracing.js';
import { WebVitals, type VitalsSnapshot } from './vitals.js';

type PerformanceLike = Pick<Performance, 'getEntriesByType' | 'timeOrigin'>;

const RESOURCE_OPS: Record<string, string> = {
  script: 'resource.script',
  link: 'resource.css',
  css: 'resource.css',
  img: 'resource.img',
  image: 'resource.img',
  font: 'resource.font',
};

/**
 * Browser metrics for pageload and navigation transactions: navigation
 * timing, paint, marks/measures, resources and long tasks (as spans), web
 * vitals (as pageload measurements). Entries are read from the performance
 * timeline when a transaction finishes; each entry is reported once.
 */
export class BrowserMetrics {
  readonly vitals: WebVitals;
  private readonly reported = new WeakSet<PerformanceEntry>();
  private readonly longTasks: PerformanceEntry[] = [];
  private longTaskObserver: PerformanceObserver | null = null;
  vitalsSent = false;

  constructor(
    private readonly redactor: () => Redactor,
    private readonly perf: PerformanceLike | undefined = globalThis.performance,
    private readonly enableVitals = true,
  ) {
    this.vitals = new WebVitals(perf);
  }

  start(): void {
    if (this.enableVitals) this.vitals.start();
    if (typeof PerformanceObserver === 'undefined') return;
    try {
      if (PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
        this.longTaskObserver = new PerformanceObserver((list) => {
          this.longTasks.push(...list.getEntries());
          if (this.longTasks.length > 500) this.longTasks.splice(0, this.longTasks.length - 500);
        });
        this.longTaskObserver.observe({ type: 'longtask', buffered: true });
      }
    } catch {
      this.longTaskObserver = null;
    }
  }

  stop(): void {
    this.vitals.stop();
    this.longTaskObserver?.disconnect();
  }

  private get origin(): number {
    return this.perf?.timeOrigin ?? 0;
  }

  private entries(type: string): PerformanceEntry[] {
    try {
      return this.perf?.getEntriesByType?.(type) ?? [];
    } catch {
      return [];
    }
  }

  /** Adds the timeline's spans inside the transaction and, for a pageload, the vitals. */
  attach(t: Transaction, end: number): void {
    const origin = this.origin;
    const from = t.startTimestamp - origin;
    const to = end - origin;
    const within = (e: PerformanceEntry) => !this.reported.has(e) && e.startTime >= from - 1 && e.startTime <= to;
    const child = (op: string, description: string, start: number, finish: number, data?: Record<string, unknown>) => {
      const s = t.startChild({ op, description, startTimestamp: origin + start, ...(data ? { data } : {}) });
      s.finish(origin + Math.max(start, finish));
    };

    if (t.op === 'pageload') {
      const nav = this.entries('navigation')[0] as PerformanceNavigationTiming | undefined;
      if (nav && !this.reported.has(nav)) {
        this.reported.add(nav);
        if (nav.requestStart > 0 && nav.responseStart > 0) child('browser.request', 'request', nav.requestStart, nav.responseStart);
        if (nav.responseStart > 0 && nav.responseEnd > 0) child('browser.response', 'response', nav.responseStart, nav.responseEnd);
        if (nav.domContentLoadedEventStart > 0) child('browser.dom_content_loaded', 'domContentLoadedEvent', nav.domContentLoadedEventStart, nav.domContentLoadedEventEnd);
        if (nav.loadEventStart > 0) child('browser.load', 'loadEvent', nav.loadEventStart, nav.loadEventEnd);
      }
      for (const p of this.entries('paint')) {
        if (this.reported.has(p)) continue;
        this.reported.add(p);
        child('browser.paint', p.name, p.startTime, p.startTime);
      }
    }
    for (const m of this.entries('mark').filter(within)) {
      this.reported.add(m);
      child('mark', m.name, m.startTime, m.startTime);
    }
    for (const m of this.entries('measure').filter(within)) {
      this.reported.add(m);
      child('measure', m.name, m.startTime, m.startTime + m.duration);
    }
    for (const r of this.entries('resource').filter(within) as PerformanceResourceTiming[]) {
      this.reported.add(r);
      // fetch/XHR are http.client spans already.
      if (r.initiatorType === 'fetch' || r.initiatorType === 'xmlhttprequest' || r.initiatorType === 'beacon') continue;
      const op = RESOURCE_OPS[r.initiatorType] ?? (/\.css(\?|$)/.test(r.name) ? 'resource.css' : `resource.${r.initiatorType || 'other'}`);
      const data: Record<string, unknown> = { url: this.redactor().redactUrl(r.name) };
      if (r.transferSize !== undefined) data['http.response_transfer_size'] = r.transferSize;
      if (r.encodedBodySize !== undefined) data['http.response_content_length'] = r.encodedBodySize;
      if (r.decodedBodySize !== undefined) data['http.decoded_response_content_length'] = r.decodedBodySize;
      const blocking = (r as { renderBlockingStatus?: string }).renderBlockingStatus;
      if (blocking) data['resource.render_blocking_status'] = blocking;
      child(op, data.url as string, r.startTime, r.responseEnd || r.startTime + r.duration, data);
    }
    for (const lt of this.longTasks.filter(within)) {
      this.reported.add(lt);
      child('ui.long-task', 'Main UI thread blocked', lt.startTime, lt.startTime + lt.duration);
    }
    if (t.op === 'pageload' && this.enableVitals) this.addVitals(t, this.vitals.snapshot());
  }

  addVitals(t: Transaction, v: VitalsSnapshot): void {
    if (v.lcp !== undefined) t.setMeasurement('lcp', v.lcp, 'millisecond');
    if (v.fcp !== undefined) t.setMeasurement('fcp', v.fcp, 'millisecond');
    if (v.ttfb !== undefined) t.setMeasurement('ttfb', v.ttfb, 'millisecond');
    if (v.cls !== undefined) t.setMeasurement('cls', v.cls, 'none');
    if (v.inp !== undefined) {
      t.setMeasurement('inp', v.inp, 'millisecond');
      this.vitalsSent = true;
    }
  }

  /** ISO timestamp of a timeline time (ms since time origin). */
  isoAt(relative: number): string {
    return iso(this.origin + relative);
  }
}
