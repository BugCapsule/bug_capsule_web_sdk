import { BugCapsule, type StateSerializer, type TrackOptions } from '@bugcapsule/web';
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
  fallback?: ReactNode | ((error: unknown, reset: () => void) => ReactNode);
}

/**
 * Error boundary that reports render errors to BugCapsule (React catches
 * them before they reach `window.onerror`).
 */
export class BugCapsuleErrorBoundary extends Component<BoundaryProps, { error: unknown }> {
  override state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  override componentDidCatch(error: unknown, _info: ErrorInfo): void {
    BugCapsule.reportError(error);
  }

  reset = () => this.setState({ error: null });

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    const { fallback } = this.props;
    return typeof fallback === 'function' ? fallback(this.state.error, this.reset) : (fallback ?? null);
  }
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
