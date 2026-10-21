import type { Span } from './tracing.js';
import type { SeverityLevel, User } from './types.js';

/**
 * Data merged into every event sent while the scope is current: user, tags,
 * extras, contexts, level, fingerprint and the active span. `withScope`
 * runs a callback on a temporary copy. Breadcrumbs are kept by the client,
 * one buffer per page.
 */
export class Scope {
  user: User | null = null;
  tags: Record<string, string> = {};
  extra: Record<string, unknown> = {};
  contexts: Record<string, Record<string, unknown>> = {};
  level: SeverityLevel | null = null;
  fingerprint: string[] | null = null;
  span: Span | null = null;

  clone(): Scope {
    const s = new Scope();
    s.user = this.user ? { ...this.user } : null;
    s.tags = { ...this.tags };
    s.extra = { ...this.extra };
    s.contexts = { ...this.contexts };
    s.level = this.level;
    s.fingerprint = this.fingerprint ? [...this.fingerprint] : null;
    s.span = this.span;
    return s;
  }

  /** `null` clears the user. */
  setUser(user: User | null): this {
    this.user = user ? { ...user } : null;
    return this;
  }
  setTag(key: string, value: string | number | boolean): this {
    this.tags = { ...this.tags, [key]: String(value) };
    return this;
  }
  setTags(tags: Record<string, string | number | boolean>): this {
    for (const [k, v] of Object.entries(tags)) this.setTag(k, v);
    return this;
  }
  setExtra(key: string, value: unknown): this {
    this.extra = { ...this.extra, [key]: value };
    return this;
  }
  setExtras(extras: Record<string, unknown>): this {
    this.extra = { ...this.extra, ...extras };
    return this;
  }
  /** `null` removes the context. */
  setContext(name: string, context: Record<string, unknown> | null): this {
    const next = { ...this.contexts };
    if (context === null) delete next[name];
    else next[name] = { ...context };
    this.contexts = next;
    return this;
  }
  setLevel(level: SeverityLevel | null): this {
    this.level = level;
    return this;
  }
  setFingerprint(fingerprint: string[] | null): this {
    this.fingerprint = fingerprint ? [...fingerprint] : null;
    return this;
  }
  setSpan(span: Span | null): this {
    this.span = span;
    return this;
  }
}
