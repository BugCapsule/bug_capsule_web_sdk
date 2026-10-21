import { Redactor } from '../core/redaction.js';
import type { CheckpointKind } from '../core/model.js';
import type { BugCapsuleIntegration, BugCapsuleSession } from '../types.js';

export interface HistoryOptions {
  /** Runs after built-in redaction, e.g. `(l) => l.replace(/\/reset\/[^/?]+/, '/reset/:token')`. */
  sanitizeLocation?: (location: string) => string;
}

/**
 * Records navigation through the History API (`pushState`, `replaceState`,
 * `popstate`, `hashchange`), so it works under any router. Checkpoints hold
 * the current location (path + query + hash, redacted); the replay runner
 * opens the app at the launch checkpoint's location, and a periodic
 * checkpoint's location is restored with `history.replaceState` before the
 * app renders.
 */
export class HistoryIntegration implements BugCapsuleIntegration {
  readonly name = 'history';
  readonly capabilities = { 'navigation.history': 'supported' };
  private session: BugCapsuleSession | null = null;
  private last: string | null = null;
  private undo: (() => void)[] = [];

  constructor(private readonly options: HistoryOptions = {}) {}

  private location(): string | null {
    const loc = globalThis.location;
    if (!loc) return null;
    return this.redact(`${loc.pathname}${loc.search}${loc.hash}`);
  }

  private redact(path: string): string {
    const s = this.session;
    if (!s) return path;
    const origin = globalThis.location?.origin ?? 'http://localhost';
    const redacted = s.redactor.redactUrl(`${origin}${path}`);
    const relative = redacted.startsWith(origin) ? redacted.substring(origin.length) || '/' : redacted;
    return this.options.sanitizeLocation?.(relative) ?? relative;
  }

  setUp(session: BugCapsuleSession): void {
    this.session = session;
    if (typeof history === 'undefined') return;
    this.last = this.location();
    const wrap = (method: 'pushState' | 'replaceState', action: string) => {
      const original = history[method];
      const self = this;
      history[method] = function (this: History, ...args: Parameters<History['pushState']>) {
        const r = original.apply(this, args);
        self.onChange(action);
        return r;
      };
      this.undo.push(() => {
        history[method] = original;
      });
    };
    wrap('pushState', 'push');
    wrap('replaceState', 'replace');
    const onPop = () => this.onChange('pop');
    addEventListener('popstate', onPop);
    addEventListener('hashchange', onPop);
    this.undo.push(() => {
      removeEventListener('popstate', onPop);
      removeEventListener('hashchange', onPop);
    });
  }

  /** Records `location` (called by router integrations with their own source/action). */
  route(location: string, source = 'history', action?: string): void {
    const s = this.session;
    if (!s || !s.isRecording) return;
    const redacted = this.redact(location);
    if (redacted === this.last) return;
    this.last = redacted;
    s.record('route', { location: redacted, source, ...(action ? { action } : {}) });
  }

  private onChange(action: string): void {
    try {
      const loc = globalThis.location;
      if (loc) this.route(`${loc.pathname}${loc.search}${loc.hash}`, 'history', action);
    } catch {
      // never break navigation
    }
  }

  snapshot(_kind: CheckpointKind): { location: string } | null {
    const location = this.location();
    return location === null ? null : { location };
  }

  restore(data: unknown, session: BugCapsuleSession): void {
    const location = (data as { location?: unknown } | null)?.location;
    if (typeof location !== 'string') return;
    if (location.includes(Redactor.placeholder) || location.includes('%5BREDACTED%5D')) session.replay?.diverge('route.redacted', location);
    // The runner already opened the launch location; periodic checkpoints move the app there.
    if (session.replay?.capsule.checkpoint.kind === 'periodic') {
      try {
        history.replaceState(history.state, '', location);
      } catch (e) {
        session.replay.diverge('restore.history', String(e));
      }
    }
  }

  dispose(): void {
    for (const u of this.undo.reverse()) u();
    this.undo = [];
  }
}

export function historyIntegration(options: HistoryOptions = {}): HistoryIntegration {
  return new HistoryIntegration(options);
}
