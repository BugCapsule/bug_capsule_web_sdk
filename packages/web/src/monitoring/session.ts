import { iso, uuid4 } from './ids.js';
import type { SessionPayload, SessionStatus } from './types.js';

/**
 * Release-health session of one page load (monitoring-v1 §7): `init` on
 * the first update, the same `sid` with increasing `seq` afterwards;
 * `crashed` is final; `exited` with `errors > 0` makes it errored.
 */
export class SessionTracker {
  private current: { sid: string; started: number; seq: number; errors: number; status: SessionStatus } | null = null;

  constructor(
    private readonly opts: {
      now: () => number;
      did: () => string;
      release: string | undefined;
      environment: string;
    },
  ) {}

  get active(): boolean {
    return this.current !== null && this.current.status === 'ok';
  }
  get sid(): string | null {
    return this.current?.sid ?? null;
  }
  get status(): SessionStatus | null {
    return this.current?.status ?? null;
  }

  /** Starts a session and returns its `init` update. */
  start(): SessionPayload {
    this.current = { sid: uuid4(), started: this.opts.now(), seq: 0, errors: 0, status: 'ok' };
    return this.update(true);
  }

  /**
   * Counts an error event; returns an update when it changed what the
   * server must know (first error, or the session crashed), else null.
   */
  error(crashed: boolean): SessionPayload | null {
    const s = this.current;
    if (!s || s.status !== 'ok') return null;
    s.errors++;
    if (crashed) {
      s.status = 'crashed';
      return this.update(false);
    }
    return s.errors === 1 ? this.update(false) : null;
  }

  /** Ends the session (`exited` unless it crashed); null when none is open. */
  end(status: SessionStatus = 'exited'): SessionPayload | null {
    const s = this.current;
    if (!s || s.status !== 'ok') {
      this.current = null;
      return null;
    }
    s.status = status;
    const update = this.update(false);
    this.current = null;
    return update;
  }

  private update(init: boolean): SessionPayload {
    const s = this.current!;
    const now = this.opts.now();
    const payload: SessionPayload = {
      sid: s.sid,
      did: this.opts.did(),
      seq: s.seq++,
      init,
      started: iso(s.started),
      timestamp: iso(now),
      status: s.status,
      errors: s.errors,
      duration: Math.max(0, Math.round(now - s.started) / 1000),
      environment: this.opts.environment,
      runtime: 'web',
    };
    if (this.opts.release) payload.release = this.opts.release;
    return payload;
  }
}
