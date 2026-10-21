import { Redactor } from '../core/redaction.js';
import type { EligibilityBuilder } from '../core/model.js';
import type { BugCapsuleIntegration, BugCapsuleSession } from '../types.js';

export interface WebStorageOptions {
  /** Keys to capture: only keys starting with one of these (required; no default allowlist). */
  allowPrefixes: string[];
  /** Wins over the allowlist. */
  denyPrefixes?: string[];
}

/**
 * Snapshots allowlisted `localStorage` / `sessionStorage` keys into every
 * checkpoint and restores them before the app renders in replay. Nothing is
 * captured unless allowlisted. Sensitive keys keep only a placeholder; values
 * pass through redaction like every recorded string.
 */
export class WebStorageIntegration implements BugCapsuleIntegration {
  readonly name: 'local_storage' | 'session_storage';
  readonly capabilities: Record<string, string>;
  private session: BugCapsuleSession | null = null;
  private readonly redacted = new Set<string>();

  constructor(
    private readonly area: 'local' | 'session',
    private readonly options: WebStorageOptions,
  ) {
    this.name = area === 'local' ? 'local_storage' : 'session_storage';
    this.capabilities = { [`storage.${this.name}`]: 'supported' };
  }

  private get store(): Storage | null {
    try {
      return this.area === 'local' ? globalThis.localStorage : globalThis.sessionStorage;
    } catch {
      return null; // blocked by privacy settings
    }
  }

  private allowed(key: string): boolean {
    return this.options.allowPrefixes.some((p) => key.startsWith(p)) && !(this.options.denyPrefixes ?? []).some((p) => key.startsWith(p));
  }

  setUp(session: BugCapsuleSession): void {
    this.session = session;
  }

  snapshot(): Record<string, string> | null {
    const store = this.store;
    const session = this.session;
    if (!store || !session) return null;
    const out: Record<string, string> = {};
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key === null || !this.allowed(key)) continue;
      const value = store.getItem(key) ?? '';
      if (session.redactor.isSensitiveKey(key)) {
        this.redacted.add(key);
        out[key] = Redactor.placeholder;
        continue;
      }
      const redacted = session.redactor.redactJson(value);
      if (redacted !== value) this.redacted.add(key);
      out[key] = redacted;
    }
    return out;
  }

  restore(data: unknown, session: BugCapsuleSession): void {
    const store = this.store;
    if (!store) {
      session.replay?.diverge(`restore.${this.name}`, 'storage is not available in this browser context');
      return;
    }
    const existing: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k !== null && this.allowed(k)) existing.push(k);
    }
    for (const k of existing) store.removeItem(k);
    if (typeof data !== 'object' || data === null) return;
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (typeof value !== 'string') continue;
      if (value.includes(Redactor.placeholder)) session.replay?.diverge('storage.redacted', key);
      store.setItem(key, value);
    }
  }

  describeEligibility(eligibility: EligibilityBuilder): void {
    for (const key of this.redacted) {
      eligibility.missing(`storage.${key}`, 'value redacted on device; replay restores a placeholder');
    }
  }
}

export function localStorageIntegration(options: WebStorageOptions): WebStorageIntegration {
  return new WebStorageIntegration('local', options);
}

export function sessionStorageIntegration(options: WebStorageOptions): WebStorageIntegration {
  return new WebStorageIntegration('session', options);
}

/**
 * An application-owned IndexedDB store the app knows how to describe and
 * rebuild. The SDK never reads IndexedDB on its own.
 */
export interface IndexedDbAdapter {
  /** Key in the checkpoint (`indexeddb.<name>`). */
  name: string;
  /** JSON-safe snapshot of the data replay needs (redacted by the SDK afterwards). */
  snapshot(): unknown | Promise<unknown>;
  /** Rebuilds the store from a snapshot before the app renders. */
  restore(data: unknown): void | Promise<void>;
}

export class IndexedDbIntegration implements BugCapsuleIntegration {
  readonly name = 'indexeddb';
  readonly capabilities = { 'storage.indexeddb': 'explicit' };
  constructor(private readonly adapters: IndexedDbAdapter[]) {}

  async snapshot(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const a of this.adapters) {
      try {
        out[a.name] = await a.snapshot();
      } catch {
        // an adapter that fails leaves its store out; replay reports it missing
      }
    }
    return out;
  }

  async restore(data: unknown, session: BugCapsuleSession): Promise<void> {
    const snap = (data ?? {}) as Record<string, unknown>;
    for (const a of this.adapters) {
      if (!(a.name in snap)) {
        session.replay?.diverge('restore.missing', `indexeddb.${a.name}`);
        continue;
      }
      try {
        await a.restore(snap[a.name]);
      } catch (e) {
        session.replay?.diverge(`restore.indexeddb.${a.name}`, String(e));
      }
    }
  }
}

export function indexedDbIntegration(adapters: IndexedDbAdapter[]): IndexedDbIntegration {
  return new IndexedDbIntegration(adapters);
}
