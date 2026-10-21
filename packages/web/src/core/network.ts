import type { CapsuleEvent } from './model.js';
import { canonicalJson, compareUtf16, fnvHash, isObject } from './json.js';
import { parseUri, queryParametersAll, type ParsedUri } from './uri.js';

/**
 * Per-endpoint normalization applied before a request key is computed.
 * `path` matches the URL path exactly, `:name` matches one segment and a
 * trailing `*` any remainder. `method` may be `*`.
 */
export interface EndpointRuleInit {
  method: string;
  path: string;
  ignoreQuery?: Iterable<string>;
  /** A plain name is removed at any depth; a dotted path (`meta.ts`) only at that path. */
  ignoreBodyFields?: Iterable<string>;
  /** When set, only these top-level body fields take part in the key. */
  matchBodyFields?: Iterable<string>;
}

export class EndpointRule {
  readonly method: string;
  readonly path: string;
  readonly ignoreQuery: ReadonlySet<string>;
  readonly ignoreBodyFields: ReadonlySet<string>;
  readonly matchBodyFields: ReadonlySet<string> | null;
  private readonly pattern: RegExp;

  constructor(init: EndpointRuleInit) {
    this.method = init.method.toUpperCase();
    this.path = init.path;
    this.ignoreQuery = new Set(init.ignoreQuery ?? []);
    this.ignoreBodyFields = new Set(init.ignoreBodyFields ?? []);
    this.matchBodyFields = init.matchBodyFields ? new Set(init.matchBodyFields) : null;
    const wildcard = init.path.endsWith('*');
    const body = wildcard ? init.path.substring(0, init.path.length - 1) : init.path;
    const segments = body.split('/').map((s) => (s.startsWith(':') ? '[^/]+' : escapeRegExp(s)));
    this.pattern = new RegExp(`^${segments.join('/')}${wildcard ? '.*' : '/?$'}`);
  }

  matches(method: string, path: string): boolean {
    return (this.method === '*' || this.method === method.toUpperCase()) && this.pattern.test(path);
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}

export const DEFAULT_IGNORE_QUERY: readonly string[] = ['_', 'ts', 'timestamp', 'nonce', 'cachebust'];

/** Builds the key that matches a replayed request to a recording (spec capsule-v1 "Network matching"). */
export class RequestKeyBuilder {
  static readonly maxKeyLength = 8000;
  readonly rules: readonly EndpointRule[];
  readonly globalIgnoreQuery: ReadonlySet<string>;
  readonly globalIgnoreBodyFields: ReadonlySet<string>;

  constructor(
    options: {
      rules?: Iterable<EndpointRule | EndpointRuleInit>;
      globalIgnoreQuery?: Iterable<string>;
      globalIgnoreBodyFields?: Iterable<string>;
    } = {},
  ) {
    this.rules = [...(options.rules ?? [])].map((r) => (r instanceof EndpointRule ? r : new EndpointRule(r)));
    this.globalIgnoreQuery = new Set(options.globalIgnoreQuery ?? DEFAULT_IGNORE_QUERY);
    this.globalIgnoreBodyFields = new Set(options.globalIgnoreBodyFields ?? []);
  }

  ruleFor(method: string, path: string): EndpointRule | null {
    for (const rule of this.rules) if (rule.matches(method, path)) return rule;
    return null;
  }

  /**
   * `METHOD host/path?sortedQuery#bodyHash`. `url` and `body` should already
   * be redacted so capture and replay compute the same key. `body` is a JSON
   * value, or a string parsed as JSON when it is valid JSON.
   */
  keyFor(method: string, url: string | ParsedUri, body: unknown): string {
    const m = method.toUpperCase();
    const uri = typeof url === 'string' ? parseUri(url) : url;
    if (!uri) throw new Error(`not a URL: ${String(url)}`);
    const rule = this.ruleFor(m, uri.path);
    const ignore = new Set([...this.globalIgnoreQuery, ...(rule?.ignoreQuery ?? [])]);
    const params = queryParametersAll(uri.query);
    const query: string[] = [];
    for (const name of [...params.keys()].sort(compareUtf16)) {
      if (ignore.has(name)) continue;
      for (const v of params.get(name)!) query.push(`${name}=${v}`);
    }
    let key = `${m} ${uri.host}${uri.path === '' ? '/' : uri.path}`;
    if (query.length > 0) key += `?${query.join('&')}`;
    const normalized = this.normalizeBody(body, rule);
    if (normalized !== undefined) key += `#${fnvHash(canonicalJson(normalized))}`;
    return key.length <= RequestKeyBuilder.maxKeyLength
      ? key
      : `${key.substring(0, RequestKeyBuilder.maxKeyLength - 20)}~${fnvHash(key)}`;
  }

  /** Undefined means "no body" (no hash in the key). */
  private normalizeBody(body: unknown, rule: EndpointRule | null): unknown {
    if (body === null || body === undefined) return undefined;
    let value: unknown = body;
    if (typeof value === 'string') {
      if (value === '') return undefined;
      try {
        value = JSON.parse(value);
      } catch {
        return value;
      }
    }
    const ignore = new Set([...this.globalIgnoreBodyFields, ...(rule?.ignoreBodyFields ?? [])]);
    const match = rule?.matchBodyFields;
    if (match && isObject(value)) {
      const picked: Record<string, unknown> = {};
      for (const k of match) if (k in value) picked[k] = value[k];
      value = picked;
    }
    return ignore.size === 0 ? value : strip(value, ignore, '');
  }
}

function strip(value: unknown, ignore: Set<string>, path: string): unknown {
  if (Array.isArray(value)) return value.map((v) => strip(v, ignore, path));
  if (isObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const p = path === '' ? k : `${path}.${k}`;
      if (ignore.has(k) || ignore.has(p)) continue;
      out[k] = strip(v, ignore, p);
    }
    return out;
  }
  return value;
}

/** One recorded HTTP exchange, as stored in an `http` event. */
export class HttpFixture {
  constructor(readonly event: CapsuleEvent) {}

  get data(): Record<string, unknown> {
    return this.event.data;
  }
  get key(): string {
    return this.data.key as string;
  }
  get occurrence(): number {
    return (this.data.occurrence as number | undefined) ?? 0;
  }
  get status(): number {
    return (this.data.status as number | undefined) ?? 0;
  }
  get statusMessage(): string | undefined {
    return (this.data.statusMessage as string | null | undefined) ?? undefined;
  }
  get durationMs(): number {
    return (this.data.durationMs as number | undefined) ?? 0;
  }
  get responseBody(): unknown {
    return this.data.responseBody;
  }
  get bodyEncoding(): string {
    return (this.data.bodyEncoding as string | undefined) ?? 'omitted';
  }
  get responseHeaders(): Record<string, string> {
    return (this.data.responseHeaders as Record<string, string> | undefined) ?? {};
  }
  get error(): { type?: string; message?: string } | null {
    return (this.data.error as { type?: string; message?: string } | null | undefined) ?? null;
  }
  get hasBody(): boolean {
    return this.bodyEncoding !== 'omitted' && this.bodyEncoding !== 'truncated';
  }
}

export interface FixtureLookup {
  fixture: HttpFixture;
  /** The request happened more often in replay than in the recording. */
  reused: boolean;
}

/** Serves recorded responses in occurrence order per request key. */
export class FixtureStore {
  private readonly byKey = new Map<string, HttpFixture[]>();
  private readonly served = new Map<string, number>();

  constructor(events: Iterable<CapsuleEvent>) {
    for (const e of events) {
      if (e.type !== 'http') continue;
      const f = new HttpFixture(e);
      const list = this.byKey.get(f.key);
      if (list) list.push(f);
      else this.byKey.set(f.key, [f]);
    }
    for (const list of this.byKey.values()) list.sort((a, b) => a.occurrence - b.occurrence);
  }

  get keyCount(): number {
    return this.byKey.size;
  }

  take(key: string): FixtureLookup | null {
    const list = this.byKey.get(key);
    if (!list || list.length === 0) return null;
    const n = this.served.get(key) ?? 0;
    this.served.set(key, n + 1);
    return n < list.length ? { fixture: list[n]!, reused: false } : { fixture: list[list.length - 1]!, reused: true };
  }

  /** Keys recorded but never requested during replay. */
  unusedKeys(): string[] {
    return [...this.byKey.keys()].filter((k) => !this.served.has(k));
  }
}
