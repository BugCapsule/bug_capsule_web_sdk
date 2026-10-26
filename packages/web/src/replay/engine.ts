import { IdleCompressor } from '../core/idle.js';
import { InteractionScript } from '../core/interactions.js';
import { Redactor } from '../core/redaction.js';
import { FixtureStore } from '../core/network.js';
import { requiredDependencies, type Capsule, type CapsuleEvent, type FailureRecord } from '../core/model.js';
import type { Divergence, ReplayReport, ReplaySettings, ReplayStrategy } from '../core/protocol.js';
import type { ReplayContext } from '../types.js';
import type { ActionRegistry } from '../actions.js';

/** What the Playwright runner exposes to the page (see @bugcapsule/web-replay). */
export interface ReplayBridge {
  load(): Promise<{ capsule: unknown; settings: Record<string, unknown> }>;
  /** Trusted pointer input dispatched by the browser automation (viewport CSS px). */
  pointer(p: { phase: string; x: number; y: number; buttons: number; pointer: number; kind: string }): Promise<void>;
  report(report: ReplayReport): Promise<void>;
}

interface WindowWithBridge {
  __BUGCAPSULE_REPLAY__?: { version: number };
  __bugcapsuleReplayCall?: (op: string, payload?: unknown) => Promise<unknown>;
}

/** The bridge, when this page was opened by the BugCapsule replay runner. */
export function detectReplayBridge(): ReplayBridge | null {
  const w = globalThis as unknown as WindowWithBridge;
  const call = w.__bugcapsuleReplayCall;
  if (!w.__BUGCAPSULE_REPLAY__ || typeof call !== 'function') return null;
  return {
    load: () => call('load') as Promise<{ capsule: unknown; settings: Record<string, unknown> }>,
    pointer: (p) => call('pointer', p) as Promise<void>,
    report: (r) => call('report', r) as Promise<void>,
  };
}

const now = () => performance.now();

/**
 * Drives a replay in the page (port of `replay_engine.dart`): dispatches
 * recorded input at recorded times relative to the checkpoint, watches for
 * the original failure, and builds the {@link ReplayReport}. Long idle gaps
 * between inputs are skipped when both the recording and the page are idle.
 *
 * Recorded interactions (capsule-v2: WebSockets) are scheduled on the same
 * clock: a delivery that is due is never skipped past, and an open but idle
 * connection does not keep replay busy.
 */
export class ReplayEngine implements ReplayContext {
  readonly fixtures: FixtureStore;
  readonly interactions: InteractionScript;
  private readonly idle: IdleCompressor;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private started: number | null = null;
  private readonly restoredAt = now();
  private readonly divergences: Divergence[] = [];
  private readonly otherFailures: FailureRecord[] = [];
  private reproduced: FailureRecord | null = null;
  private readonly waiters = new Set<() => void>();
  private readonly pressed = new Set<number>();
  private fixturesServedCount = 0;
  private dispatched = 0;
  private skippedMs = 0;
  private gapsCompressed = 0;
  private work = 0;
  private lastActivity = 0;
  private strategy: ReplayStrategy = 'auto';
  private started_ = false;
  /** Runs right before the report is built (e.g. to report unrestored state). */
  beforeReport: (() => void) | null = null;

  constructor(
    readonly capsule: Capsule,
    readonly settings: ReplaySettings,
    private readonly actions: ActionRegistry,
    private readonly bridge: ReplayBridge,
    private readonly buildGitSha: string | null,
  ) {
    this.fixtures = new FixtureStore(capsule.events);
    this.idle = new IdleCompressor(capsule.events);
    // Preflight (Runtime.startReplay) made sure an adapter serves every required dependency.
    this.interactions = new InteractionScript(capsule.events, {
      dependencies: new Set(requiredDependencies(capsule.manifest).map((d) => d.id)),
      clock: () => this.interactionClock(),
      base: capsule.checkpoint.kind === 'launch' ? 0 : capsule.checkpoint.t,
    });
  }

  /**
   * Replay clock of interaction deliveries: page time since restore plus
   * skipped idle time. The page-time part holds still for the rest of the
   * current task, so operations the app starts together (two sockets opened
   * in one function) get the same time, as their recorded twins did.
   */
  private interactionClock(): number {
    if (this.taskTime === null) {
      this.taskTime = now() - this.restoredAt;
      queueMicrotask(() => (this.taskTime = null));
    }
    return this.taskTime + this.skippedMs;
  }

  private taskTime: number | null = null;

  /** Delivers due interactions and arms a timer for the next one (call after take/takeNext/bind). */
  interactionsChanged(): void {
    if (this.pumpTimer !== null) clearTimeout(this.pumpTimer);
    this.pumpTimer = null;
    const next = this.interactions.nextDueAt;
    if (next === null) return;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      this.pumpInteractions();
    }, Math.max(0, next - this.interactionClock()));
  }

  private pumpInteractions(): void {
    let delivered = 0;
    try {
      delivered = this.interactions.pump();
    } catch (e) {
      this.diverge('dispatch.error', `interaction delivery: ${String(e)}`);
    }
    for (const [type, detail] of this.interactions.takeDivergences()) this.diverge(type, detail);
    if (delivered > 0) this.activity();
    this.interactionsChanged();
  }

  /** Ms until the next interaction delivery is due (null: none scheduled). */
  private interactionDueIn(): number | null {
    const next = this.interactions.nextDueAt;
    return next === null ? null : next - this.interactionClock();
  }

  get inputsStarted(): boolean {
    return this.started_;
  }

  /** Virtual wall clock: checkpoint wall time + elapsed + skipped idle time. */
  wallClock(): number {
    return this.capsule.checkpoint.wallClockMs + (now() - this.restoredAt) + this.skippedMs;
  }

  private elapsed(): number {
    return this.started === null ? 0 : now() - this.started + this.skippedMs;
  }

  diverge(type: string, detail: string): void {
    if (this.divergences.length >= 200) return;
    this.divergences.push(this.started === null ? { type, detail } : { type, detail, t: Math.round(this.elapsed()) });
  }

  fixtureServed(): void {
    this.fixturesServedCount++;
  }

  beginWork(): () => void {
    this.work++;
    this.activity();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.work--;
      this.activity();
    };
  }

  activity(): void {
    this.lastActivity = this.started === null ? 0 : now() - this.started;
  }

  private get quietMs(): number {
    return (this.started === null ? 0 : now() - this.started) - this.lastActivity;
  }

  private get busy(): number {
    return this.work + this.pressed.size;
  }

  onFailure(failure: FailureRecord): void {
    const expected = this.capsule.manifest.failure;
    if (expected && failure.signature === expected.signature) {
      if (!this.reproduced) {
        this.reproduced = failure;
        for (const w of [...this.waiters]) w();
      }
    } else {
      this.otherFailures.push(failure);
      this.diverge('failure.other', failure.signature);
    }
  }

  precheck(): void {
    const sha = this.capsule.manifest.source?.gitSha;
    if (sha && this.buildGitSha && sha !== this.buildGitSha) {
      this.diverge('build.gitSha', `capsule ${sha} vs build ${this.buildGitSha}`);
    }
  }

  private chooseStrategy(): ReplayStrategy {
    const hasPointers = this.capsule.events.some((e) => e.type === 'pointer');
    const hasActions = this.capsule.events.some((e) => e.type === 'action');
    if (this.settings.strategy !== 'auto') return this.settings.strategy;
    const screen = this.capsule.manifest.platform.screen ?? {};
    const sameScreen =
      Math.abs(innerWidth - (screen.width ?? innerWidth)) < 1 && Math.abs(innerHeight - (screen.height ?? innerHeight)) < 1;
    if (hasPointers && (sameScreen || !hasActions)) {
      if (!sameScreen) {
        this.diverge('screen.size', `recorded ${screen.width}x${screen.height}, replay ${innerWidth}x${innerHeight}; pointers are scaled`);
      }
      return 'pointer';
    }
    return 'semantic';
  }

  private shouldDispatch(type: string): boolean {
    switch (type) {
      case 'lifecycle':
      case 'text':
        return true;
      case 'pointer':
        return this.strategy === 'pointer';
      case 'action':
        return this.strategy === 'semantic';
      default:
        return false;
    }
  }

  /** Sleeps [ms], waking early when the expected failure fires. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.waiters.delete(done);
        resolve();
      };
      const t = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }

  /** Call after the app rendered its first frame. */
  async run(): Promise<ReplayReport> {
    this.started = now();
    this.strategy = this.chooseStrategy();
    const expected = this.capsule.manifest.failure ?? null;
    const base = this.capsule.checkpoint.kind === 'launch' ? 0 : this.capsule.checkpoint.t;
    const toDispatch = this.capsule.events.filter((e) => this.shouldDispatch(e.type) && e.t >= base);
    this.interactions.runStarted(this.interactionClock());
    this.interactionsChanged();

    let lastT = 0;
    let previous = base;
    for (const event of toDispatch) {
      if (this.reproduced) break;
      const due = event.t - base;
      lastT = due;
      const idleSince = this.settings.idleCompression ? this.idle.idleSince(previous, event.t) : null;
      previous = event.t;
      let compressed = false;
      while (!this.reproduced) {
        const wait = due - this.elapsed();
        if (wait <= 0) break;
        if (idleSince !== null && this.idle.maySkip(this.elapsed() + base, idleSince, this.busy, this.quietMs)) {
          // Never jump past a due interaction delivery: skip up to it, deliver, then continue.
          const dueIn = this.interactionDueIn();
          const jump = dueIn === null ? wait : Math.min(wait, Math.max(0, dueIn));
          if (jump > 0) {
            if (!compressed) this.gapsCompressed++;
            compressed = true;
            this.skippedMs += jump;
          }
          if (jump >= wait) break;
          this.pumpInteractions();
          continue;
        }
        await this.sleep(idleSince === null || wait < 50 ? wait : 50);
      }
      if (this.reproduced) break;
      this.started_ = true;
      await this.dispatch(event);
    }

    if (!this.reproduced) {
      const failureDue = expected ? expected.t - base : 0;
      const deadline = Math.max(failureDue, lastT) + (expected ? this.settings.settleTimeoutMs : 1500);
      const remaining = deadline - this.elapsed();
      if (remaining > 0) await this.sleep(remaining);
    }

    try {
      this.beforeReport?.();
    } catch {
      // reporting hooks must not lose the report
    }
    for (const key of this.fixtures.unusedKeys()) this.diverge('network.unused', key);
    for (const [type, detail] of this.interactions.takeDivergences()) this.diverge(type, detail);
    for (const [type, detail] of this.interactions.unused(expected?.t ?? null)) this.diverge(type, detail);

    const outcome = !expected ? 'no_assertion' : this.reproduced ? 'reproduced' : 'not_reproduced';
    return {
      outcome,
      attempt: this.settings.attempt,
      durationMs: Math.round(now() - this.started),
      strategy: this.strategy,
      expectedSignature: expected?.signature ?? null,
      observed: this.reproduced,
      otherFailures: [...this.otherFailures],
      divergences: [...this.divergences],
      eventsDispatched: this.dispatched,
      eventsExpected: toDispatch.length,
      fixturesServed: this.fixturesServedCount,
      compressedMs: Math.round(this.skippedMs),
      gapsCompressed: this.gapsCompressed,
      buildGitSha: this.buildGitSha,
      message: null,
      ...(this.settings.attemptId ? { attemptId: this.settings.attemptId } : {}),
      runtime: 'web',
    };
  }

  private async dispatch(event: CapsuleEvent): Promise<void> {
    try {
      switch (event.type) {
        case 'pointer':
          await this.dispatchPointer(event.data);
          break;
        case 'action': {
          const id = event.data.id as string;
          const payload = (event.data.payload as Record<string, unknown> | undefined) ?? undefined;
          if (!this.actions.invoke(id, payload)) {
            this.diverge('action.unregistered', id);
            return;
          }
          break;
        }
        case 'text': {
          const id = event.data.id as string;
          const value = (event.data.value as string | undefined) ?? '';
          if (value.includes(Redactor.placeholder)) this.diverge('text.redacted', id);
          if (!this.actions.setText(id, value)) {
            this.diverge('text.untracked', id);
            return;
          }
          break;
        }
        case 'lifecycle':
          if (!dispatchLifecycle(event.data.state as string)) {
            this.diverge('lifecycle.unsupported', String(event.data.state));
            return;
          }
          break;
      }
      this.dispatched++;
      this.activity();
    } catch (e) {
      this.diverge('dispatch.error', `${event.type}: ${String(e)}`);
    }
  }

  private async dispatchPointer(d: Record<string, unknown>): Promise<void> {
    const screen = this.capsule.manifest.platform.screen ?? {};
    const sx = screen.width ? innerWidth / screen.width : 1;
    const sy = screen.height ? innerHeight / screen.height : 1;
    const x = (d.x as number) * sx;
    const y = (d.y as number) * sy;
    const phase = d.phase as string;
    const pointer = d.pointer as number;
    if (phase === 'down') {
      this.checkTarget(d.target as { selector?: string; action?: string } | undefined, x, y);
      this.pressed.add(pointer);
    } else if (phase === 'up' || phase === 'cancel') {
      this.pressed.delete(pointer);
    }
    await this.bridge.pointer({ phase, x, y, buttons: (d.buttons as number | undefined) ?? 1, pointer, kind: (d.kind as string) ?? 'mouse' });
  }

  /** Selectors and coordinates are fallbacks: report ambiguity or mismatch. */
  private checkTarget(target: { selector?: string; action?: string } | undefined, x: number, y: number): void {
    if (!target?.selector) return;
    let matches: Element[];
    try {
      matches = [...document.querySelectorAll(target.selector)];
    } catch {
      return;
    }
    if (matches.length === 0) {
      this.diverge('selector.missing', target.selector);
      return;
    }
    if (matches.length > 1) this.diverge('selector.ambiguous', `${target.selector} matches ${matches.length} elements`);
    const hit = document.elementFromPoint(x, y);
    if (!hit || !matches.some((m) => m === hit || m.contains(hit))) {
      this.diverge('pointer.mismatch', `${target.selector} is not at (${Math.round(x)}, ${Math.round(y)})`);
    }
  }
}

/** Synthetic page lifecycle (runtimes-v1 §4: web lifecycle replay is partial). */
function dispatchLifecycle(state: string): boolean {
  const setVisibility = (v: 'visible' | 'hidden') => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => v === 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  };
  switch (state) {
    case 'resumed':
      if (document.visibilityState !== 'visible') setVisibility('visible');
      return true;
    case 'hidden':
      setVisibility('hidden');
      return true;
    case 'paused':
      setVisibility('hidden');
      dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      return true;
    case 'inactive':
      dispatchEvent(new FocusEvent('blur'));
      return true;
    default:
      return false;
  }
}
