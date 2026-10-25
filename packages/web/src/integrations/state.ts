import { Redactor } from '../core/redaction.js';
import type { BugCapsuleIntegration, BugCapsuleSession } from '../types.js';

/** How an app-owned state object is captured and restored. */
export interface StateSerializer<T = unknown> {
  /** JSON-safe projection of the state (leave secrets out; it is redacted too). */
  serialize(): T;
  /** Applies a snapshot (replay). */
  restore(data: T): void;
}

/**
 * Generic state serialization/restoration for app-owned stores (Redux,
 * Zustand, signals, plain objects) through explicit registration:
 * `BugCapsule.registerState('cart', {serialize, restore})`.
 *
 * Capture: every registered state is snapshotted into each checkpoint, and
 * `BugCapsule.stateChanged(key)` records a diagnostic `state` event. Replay:
 * a state registering while its checkpoint data is present is restored on
 * registration; registering after replay input started reports
 * `restore.late`; captured keys nobody registered report `restore.missing`.
 */
export class StateIntegration implements BugCapsuleIntegration {
  readonly name = 'state';
  readonly capabilities = { 'state.registered': 'explicit' };
  private readonly states = new Map<string, StateSerializer>();
  private session: BugCapsuleSession | null = null;
  private pending: Record<string, unknown> | null = null;

  setUp(session: BugCapsuleSession): void {
    this.session = session;
  }

  /** Registered states (setup diagnostics). */
  get size(): number {
    return this.states.size;
  }

  register<T>(key: string, serializer: StateSerializer<T>): () => void {
    this.states.set(key, serializer as StateSerializer);
    const replay = this.session?.replay;
    if (replay && this.pending && key in this.pending) {
      if (replay.inputsStarted) replay.diverge('restore.late', `state.${key} registered after replay input started`);
      const data = this.pending[key];
      delete this.pending[key];
      if (typeof data === 'string' && data.includes(Redactor.placeholder)) replay.diverge('state.redacted', key);
      try {
        serializer.restore(data as T);
      } catch (e) {
        replay.diverge(`restore.state.${key}`, String(e));
      }
    }
    return () => {
      if (this.states.get(key) === serializer) this.states.delete(key);
    };
  }

  changed(key: string): void {
    if (this.states.has(key)) this.session?.record('state', { key });
  }

  snapshot(): Record<string, unknown> | null {
    if (this.states.size === 0) return null;
    const out: Record<string, unknown> = {};
    for (const [key, s] of this.states) {
      try {
        out[key] = s.serialize();
      } catch {
        // a failing serializer leaves its state out
      }
    }
    return out;
  }

  restore(data: unknown): void {
    this.pending = typeof data === 'object' && data !== null ? { ...(data as Record<string, unknown>) } : null;
    if (!this.pending) return;
    for (const key of Object.keys(this.pending)) {
      const s = this.states.get(key);
      if (!s) continue;
      const value = this.pending[key];
      delete this.pending[key];
      try {
        s.restore(value);
      } catch (e) {
        this.session?.replay?.diverge(`restore.state.${key}`, String(e));
      }
    }
  }

  /** Called by the engine at the end of an attempt. */
  reportUnrestored(): void {
    for (const key of Object.keys(this.pending ?? {})) this.session?.replay?.diverge('restore.missing', `state.${key}`);
  }
}
