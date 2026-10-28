import { BugCapsule, type FeedbackWidget, type FeedbackWidgetOptions, type StateSerializer, type TrackOptions } from '@bugcapsule/web';
import { Component, useCallback, useEffect, useLayoutEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';

let declared = false;
function declareReact(): void {
  if (declared || !BugCapsule.isInitialized) return;
  declared = true;
  BugCapsule.useFramework('react');
}

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * A stable callback registered as the semantic action `id`: invoking it
 * records the action, and semantic replay calls the latest handler.
 *
 * `<button onClick={useBugCapsuleAction('cart.checkout', checkout)} data-bugcapsule-action="cart.checkout">`
 */
export function useBugCapsuleAction<A extends unknown[], R>(id: string, handler: (...args: A) => R): (...args: A) => R {
  declareReact();
  const latest = useRef(handler);
  useIsoLayoutEffect(() => {
    latest.current = handler;
  });
  const [wrapped] = useState(() => BugCapsule.action(id, (...args: A) => latest.current(...args)));
  useEffect(() => {
    // Re-register on mount so the mounted instance wins after remounts.
    BugCapsule.action(id, (...args: A) => latest.current(...args));
  }, [id]);
  return wrapped;
}

/**
 * Ref callback for an uncontrolled `<input>`/`<textarea>`/`<select>`
 * tracked as `id`: edits are recorded (redacted when sensitive) and restored
 * in replay. `<input ref={useTrackedInput('login.email')} />`
 */
export function useTrackedInput(id: string, options: TrackOptions = {}): (el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null) => void {
  declareReact();
  const dispose = useRef<(() => void) | null>(null);
  const sensitive = options.sensitive === true;
  return useCallback(
    (el) => {
      dispose.current?.();
      dispose.current = el ? BugCapsule.trackInput(id, el, { sensitive }) : null;
    },
    [id, sensitive],
  );
}

/**
 * Controlled value tracked as `id`: wraps `[value, setValue]` so changes are
 * recorded and replay can set the value.
 * `const [coupon, setCoupon] = useTrackedState('cart.coupon', '')`
 */
export function useTrackedState(id: string, initial: string, options: TrackOptions = {}): [string, (value: string) => void] {
  declareReact();
  const [value, setValue] = useState(initial);
  const tracker = useRef<ReturnType<typeof BugCapsule.trackValue> | null>(null);
  useIsoLayoutEffect(() => {
    tracker.current = BugCapsule.trackValue(id, setValue, options);
    return () => tracker.current?.dispose();
  }, [id, options.sensitive]);
  const set = useCallback((v: string) => {
    setValue(v);
    tracker.current?.changed(v);
  }, []);
  return [value, set];
}

/**
 * Registers component- or store-owned state for checkpoints and replay
 * restoration; records a `state` event when `value` changes.
 */
export function useBugCapsuleState<T>(key: string, value: T, restore: (data: T) => void): void {
  declareReact();
  const latest = useRef({ value, restore });
  latest.current = { value, restore };
  useIsoLayoutEffect(() => {
    const serializer: StateSerializer<T> = {
      serialize: () => latest.current.value,
      restore: (data) => latest.current.restore(data),
    };
    return BugCapsule.registerState(key, serializer);
  }, [key]);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    BugCapsule.stateChanged(key);
  }, [key, value]);
}

interface BoundaryProps {
  children: ReactNode;
  fallback?: ReactNode | ((error: unknown, reset: () => void, eventId: string | null) => ReactNode);
  /** Called after the error was reported (with the error event id, when one was sent). */
  onError?: (error: unknown, componentStack: string | null, eventId: string | null) => void;
}

/**
 * Error boundary that reports render errors to BugCapsule (React catches
 * them before they reach `window.onerror`): a failure for capsules and an
 * error event (mechanism `manual`, handled, with `contexts.react.componentStack`).
 */
export class BugCapsuleErrorBoundary extends Component<BoundaryProps, { error: unknown; eventId: string | null; failed: boolean }> {
  override state: { error: unknown; eventId: string | null; failed: boolean } = { error: null, eventId: null, failed: false };

  static getDerivedStateFromError(error: unknown) {
    return { error, failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    const componentStack = info.componentStack ?? null;
    const before = BugCapsule.lastEventId();
    BugCapsule.reportError(error, {
      mechanism: { type: 'manual', handled: true, data: { source: 'react.errorBoundary' } },
      ...(componentStack ? { contexts: { react: { componentStack } } } : {}),
    });
    const after = BugCapsule.lastEventId();
    const eventId = after !== before ? after : null;
    this.setState({ eventId });
    this.props.onError?.(error, componentStack, eventId);
  }

  reset = () => this.setState({ error: null, eventId: null, failed: false });

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const { fallback } = this.props;
    if (typeof fallback === 'function') return fallback(this.state.error, this.reset, this.state.eventId);
    if (fallback !== undefined) return fallback;
    return (
      <div role="alert" data-bugcapsule-ignore="" style={{ padding: 24, color: '#334155', background: '#f8fafc', fontFamily: 'system-ui, sans-serif' }}>
        <p>This part of the screen could not load. Please try again.</p>
        <button type="button" onClick={this.reset}>Try again</button>
      </div>
    );
  }
}

/**
 * React 19 root error callbacks:
 * `createRoot(el, { onUncaughtError: reactErrorHandler(), onRecoverableError: reactErrorHandler() })`.
 * Uncaught errors are reported as unhandled failures (capsule + event),
 * caught ones (`onCaughtError`) as handled failures — do not combine that
 * with `BugCapsuleErrorBoundary`, which reports them already — and
 * recoverable ones as `warning` events only.
 */
export function reactErrorHandler(
  kind: 'uncaught' | 'caught' | 'recoverable' = 'uncaught',
  callback?: (error: unknown, errorInfo: { componentStack?: string | null }) => void,
): (error: unknown, errorInfo: { componentStack?: string | null }) => void {
  return (error, errorInfo) => {
    const componentStack = errorInfo?.componentStack ?? null;
    const contexts = componentStack ? { contexts: { react: { componentStack } } } : {};
    if (kind === 'recoverable') {
      BugCapsule.captureException(error, { level: 'warning', mechanism: { type: 'manual', handled: true, data: { source: 'react.recoverable' } }, ...contexts });
    } else {
      BugCapsule.reportError(error, {
        mechanism: kind === 'uncaught' ? { type: 'uncaught', handled: false, data: { source: 'react.root' } } : { type: 'manual', handled: true, data: { source: 'react.root' } },
        ...contexts,
      });
    }
    callback?.(error, errorInfo);
  };
}

/**
 * Shows the opt-in feedback widget while mounted (a floating button opening
 * a report form). `<BugCapsuleFeedbackWidget theme={{ accent: '#0a7' }} />`
 */
export function BugCapsuleFeedbackWidget(props: FeedbackWidgetOptions): null {
  useFeedbackWidget(props);
  return null;
}

/**
 * The feedback widget for custom triggers:
 * `const feedback = useFeedbackWidget({ showTrigger: false }); <button onClick={() => feedback.current?.open()}>`
 */
export function useFeedbackWidget(options: FeedbackWidgetOptions = {}): { readonly current: FeedbackWidget | null } {
  const ref = useRef<FeedbackWidget | null>(null);
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    if (!BugCapsule.isInitialized) return;
    const widget = BugCapsule.showFeedbackWidget(latest.current);
    ref.current = widget;
    return () => {
      widget.remove();
      if (ref.current === widget) ref.current = null;
    };
  }, []);
  return ref;
}

/** A small QA "capture" button; renders nothing in production mode, while replaying, or when not recording. */
export function BugCapsuleCaptureButton(props: { label?: string; className?: string }) {
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<string | null>(null);
  if (!BugCapsule.isRecording || BugCapsule.isReplaying || BugCapsule.mode === 'production') return null;
  return (
    <button
      type="button"
      className={props.className}
      disabled={busy}
      data-bugcapsule-ignore=""
      onClick={async () => {
        setBusy(true);
        try {
          const r = await BugCapsule.capture({ note: 'QA capture button' });
          setLast(r ? r.capsuleId.substring(0, 8) : null);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? 'Capturing…' : last ? `${props.label ?? 'Capture bug'} (${last})` : (props.label ?? 'Capture bug')}
    </button>
  );
}
