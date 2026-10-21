type Handler = (payload?: Record<string, unknown>) => void;

interface TrackedInput {
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
  /** For framework-controlled inputs that are not DOM elements (or custom setters). */
  set?: (value: string) => void;
}

/**
 * Named UI actions and tracked inputs. Semantic replay invokes actions by id;
 * tracked inputs are always restored by id. The latest registration wins (a
 * component re-registering on every render binds the mounted instance).
 */
export class ActionRegistry {
  private readonly actions = new Map<string, Handler>();
  private readonly inputs = new Map<string, TrackedInput>();

  register(id: string, handler: Handler): () => void {
    this.actions.set(id, handler);
    return () => {
      if (this.actions.get(id) === handler) this.actions.delete(id);
    };
  }

  invoke(id: string, payload?: Record<string, unknown>): boolean {
    const handler = this.actions.get(id);
    if (!handler) {
      // Fall back to an element declaring the action (data-bugcapsule-action).
      const el = typeof document === 'undefined' ? null : document.querySelector<HTMLElement>(`[data-bugcapsule-action="${cssEscape(id)}"]`);
      if (!el) return false;
      el.click();
      return true;
    }
    handler(payload);
    return true;
  }

  trackInput(id: string, input: TrackedInput): () => void {
    this.inputs.set(id, input);
    return () => {
      if (this.inputs.get(id) === input) this.inputs.delete(id);
    };
  }

  /** Sets the value the way a user would (native setter + `input`/`change` events, so React and others see it). */
  setText(id: string, value: string): boolean {
    const tracked = this.inputs.get(id);
    if (!tracked) return false;
    if (tracked.set) {
      tracked.set(value);
      return true;
    }
    const el = tracked.element;
    if (!el || !el.isConnected) return false;
    const proto = Object.getPrototypeOf(el) as object;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
}

function cssEscape(s: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
}
