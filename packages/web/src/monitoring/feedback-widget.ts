import type { FeedbackInput } from './types.js';

export interface FeedbackTheme {
  /** Button and focus colour. */
  accent?: string;
  /** Text on the accent colour. */
  accentForeground?: string;
  background?: string;
  foreground?: string;
  muted?: string;
  border?: string;
  radius?: string;
  fontFamily?: string;
  zIndex?: number;
}

export interface FeedbackWidgetOptions {
  /** Default `auto` (follows `prefers-color-scheme`). */
  colorScheme?: 'light' | 'dark' | 'auto';
  /** Overrides for the light (and, unless `darkTheme` is given, dark) palette. */
  theme?: FeedbackTheme;
  darkTheme?: FeedbackTheme;
  position?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  /** Show the floating button (default true); without it, call `open()` from your own UI. */
  showTrigger?: boolean;
  triggerLabel?: string;
  title?: string;
  nameLabel?: string;
  emailLabel?: string;
  messageLabel?: string;
  messagePlaceholder?: string;
  submitLabel?: string;
  cancelLabel?: string;
  successMessage?: string;
  showName?: boolean;
  showEmail?: boolean;
  /** Prefilled values (e.g. the signed-in user). */
  defaults?: { name?: string; email?: string };
  tags?: Record<string, string>;
  /** Link the feedback to the last error event (default true). */
  attachLastEvent?: boolean;
  captureCapsule?: boolean;
  onSubmit?: (feedbackId: string) => void;
  /** Where the widget is attached (default `document.body`). */
  container?: HTMLElement;
}

const LIGHT: Required<Omit<FeedbackTheme, 'zIndex'>> = {
  accent: '#4f46e5',
  accentForeground: '#ffffff',
  background: '#ffffff',
  foreground: '#111827',
  muted: '#6b7280',
  border: '#d1d5db',
  radius: '10px',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
};
const DARK: Required<Omit<FeedbackTheme, 'zIndex'>> = {
  ...LIGHT,
  accent: '#818cf8',
  accentForeground: '#0b0b12',
  background: '#1f2937',
  foreground: '#f9fafb',
  muted: '#9ca3af',
  border: '#374151',
};

function vars(t: Omit<FeedbackTheme, 'zIndex'>): string {
  return Object.entries(t)
    .map(([k, v]) => `--bc-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: ${String(v).replace(/[;{}]/g, '')};`)
    .join(' ');
}

const POSITIONS = {
  'bottom-right': 'bottom: 16px; right: 16px;',
  'bottom-left': 'bottom: 16px; left: 16px;',
  'top-right': 'top: 16px; right: 16px;',
  'top-left': 'top: 16px; left: 16px;',
};

/**
 * The opt-in user feedback widget (monitoring-v1 §9): a floating button
 * opening a dialog with name, email and message. Rendered in a shadow root
 * (page styles do not leak in or out), themed with `--bc-*` CSS variables,
 * keyboard accessible (focus moves into the dialog, Escape closes it).
 * Marked `data-bugcapsule-ignore` / `data-bugcapsule-sensitive`, so capsule
 * capture never records what is typed into it.
 */
export class FeedbackWidget {
  private host: HTMLElement | null = null;
  private root: ShadowRoot | null = null;
  private returnFocus: HTMLElement | null = null;

  constructor(
    private readonly submit: (input: FeedbackInput) => string,
    private readonly lastEventId: () => string | null,
    private readonly options: FeedbackWidgetOptions = {},
  ) {}

  get isOpen(): boolean {
    return this.root?.querySelector('.dialog')?.hasAttribute('hidden') === false;
  }

  mount(): void {
    if (this.host || typeof document === 'undefined') return;
    const o = this.options;
    const host = document.createElement('div');
    host.setAttribute('data-bugcapsule-ignore', '');
    host.setAttribute('data-bugcapsule-sensitive', '');
    host.setAttribute('data-bugcapsule-feedback', '');
    const root = host.attachShadow({ mode: 'open' });
    const light = { ...LIGHT, ...(o.theme ?? {}) };
    const dark = { ...DARK, ...(o.darkTheme ?? o.theme ?? {}) };
    delete (light as FeedbackTheme).zIndex;
    delete (dark as FeedbackTheme).zIndex;
    const scheme = o.colorScheme ?? 'auto';
    const z = o.theme?.zIndex ?? 2147483000;
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; ${vars(scheme === 'dark' ? dark : light)} }
      ${scheme === 'auto' ? `@media (prefers-color-scheme: dark) { :host { ${vars(dark)} } }` : ''}
      * { box-sizing: border-box; font-family: var(--bc-font-family); }
      .trigger { position: fixed; ${POSITIONS[o.position ?? 'bottom-right']} z-index: ${z}; border: 0; cursor: pointer;
        padding: 10px 16px; border-radius: 999px; background: var(--bc-accent); color: var(--bc-accent-foreground);
        font-size: 14px; font-weight: 600; box-shadow: 0 4px 14px rgba(0,0,0,.2); }
      .backdrop { position: fixed; inset: 0; z-index: ${z + 1}; background: rgba(0,0,0,.35); display: flex; align-items: center; justify-content: center; padding: 16px; }
      .backdrop[hidden], .dialog[hidden] { display: none; }
      .dialog { width: min(420px, 100%); background: var(--bc-background); color: var(--bc-foreground); border: 1px solid var(--bc-border);
        border-radius: var(--bc-radius); padding: 20px; box-shadow: 0 10px 40px rgba(0,0,0,.3); }
      h2 { margin: 0 0 12px; font-size: 18px; }
      label { display: block; margin: 10px 0 4px; font-size: 13px; color: var(--bc-muted); }
      input, textarea { width: 100%; padding: 8px 10px; font-size: 14px; color: var(--bc-foreground); background: transparent;
        border: 1px solid var(--bc-border); border-radius: calc(var(--bc-radius) / 2); }
      textarea { min-height: 110px; resize: vertical; }
      input:focus-visible, textarea:focus-visible, button:focus-visible { outline: 2px solid var(--bc-accent); outline-offset: 2px; }
      .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
      .actions button { padding: 8px 14px; font-size: 14px; border-radius: calc(var(--bc-radius) / 2); cursor: pointer; }
      .submit { border: 0; background: var(--bc-accent); color: var(--bc-accent-foreground); font-weight: 600; }
      .cancel { background: transparent; color: var(--bc-foreground); border: 1px solid var(--bc-border); }
      .status { margin: 10px 0 0; font-size: 13px; color: var(--bc-muted); min-height: 1em; }
    `;
    root.appendChild(style);

    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string) => {
      const e = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
      if (text !== undefined) e.textContent = text;
      return e;
    };
    if (o.showTrigger !== false) {
      const trigger = el('button', { type: 'button', class: 'trigger', 'aria-haspopup': 'dialog' }, o.triggerLabel ?? 'Report a bug');
      trigger.addEventListener('click', () => this.open());
      root.appendChild(trigger);
    }
    const backdrop = el('div', { class: 'backdrop', hidden: '' });
    const dialog = el('form', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'bc-title', hidden: '', novalidate: '' });
    dialog.appendChild(el('h2', { id: 'bc-title' }, o.title ?? 'Report a bug'));
    if (o.showName !== false) {
      dialog.appendChild(el('label', { for: 'bc-name' }, o.nameLabel ?? 'Name'));
      dialog.appendChild(el('input', { id: 'bc-name', name: 'name', autocomplete: 'name', maxlength: '200', value: o.defaults?.name ?? '' }));
    }
    if (o.showEmail !== false) {
      dialog.appendChild(el('label', { for: 'bc-email' }, o.emailLabel ?? 'Email'));
      dialog.appendChild(el('input', { id: 'bc-email', name: 'email', type: 'email', autocomplete: 'email', maxlength: '200', value: o.defaults?.email ?? '' }));
    }
    dialog.appendChild(el('label', { for: 'bc-message' }, o.messageLabel ?? 'What happened?'));
    dialog.appendChild(el('textarea', { id: 'bc-message', name: 'message', required: '', maxlength: '5000', placeholder: o.messagePlaceholder ?? 'Describe what you did and what went wrong' }));
    dialog.appendChild(el('p', { class: 'status', role: 'status', 'aria-live': 'polite' }));
    const actions = el('div', { class: 'actions' });
    const cancel = el('button', { type: 'button', class: 'cancel' }, o.cancelLabel ?? 'Cancel');
    cancel.addEventListener('click', () => this.close());
    actions.appendChild(cancel);
    actions.appendChild(el('button', { type: 'submit', class: 'submit' }, o.submitLabel ?? 'Send report'));
    dialog.appendChild(actions);
    dialog.addEventListener('submit', (e) => {
      e.preventDefault();
      this.onSubmit(dialog);
    });
    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) this.close();
    });
    backdrop.appendChild(dialog);
    root.appendChild(backdrop);
    (o.container ?? document.body).appendChild(host);
    this.host = host;
    this.root = root;
  }

  private onSubmit(form: HTMLFormElement): void {
    const value = (name: string) => (form.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLTextAreaElement | null)?.value.trim() ?? '';
    const status = form.querySelector('.status')!;
    const message = value('message');
    if (!message) {
      status.textContent = 'Please describe the problem.';
      (form.querySelector('[name="message"]') as HTMLElement | null)?.focus();
      return;
    }
    const o = this.options;
    const eventId = o.attachLastEvent === false ? null : this.lastEventId();
    const id = this.submit({
      message,
      ...(value('name') ? { name: value('name') } : {}),
      ...(value('email') ? { email: value('email') } : {}),
      ...(eventId ? { eventId } : {}),
      ...(o.tags ? { tags: o.tags } : {}),
      ...(o.captureCapsule !== undefined ? { captureCapsule: o.captureCapsule } : {}),
    });
    (form.querySelector('[name="message"]') as HTMLTextAreaElement).value = '';
    status.textContent = o.successMessage ?? 'Thanks! Your report was sent.';
    o.onSubmit?.(id);
    setTimeout(() => this.close(), 1200);
  }

  open(): void {
    this.mount();
    const root = this.root;
    if (!root) return;
    this.returnFocus = (document.activeElement as HTMLElement | null) ?? null;
    root.querySelector('.backdrop')!.removeAttribute('hidden');
    root.querySelector('.dialog')!.removeAttribute('hidden');
    root.querySelector('.status')!.textContent = '';
    (root.querySelector('[name="message"]') as HTMLElement | null)?.focus();
  }

  close(): void {
    const root = this.root;
    if (!root) return;
    root.querySelector('.backdrop')?.setAttribute('hidden', '');
    root.querySelector('.dialog')?.setAttribute('hidden', '');
    this.returnFocus?.focus?.();
    this.returnFocus = null;
  }

  remove(): void {
    this.host?.remove();
    this.host = null;
    this.root = null;
  }
}
