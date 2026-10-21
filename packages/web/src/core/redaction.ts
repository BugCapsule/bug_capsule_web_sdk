import { encodeQuery, formatUri, parseUri, queryParametersAll, type ParsedUri } from './uri.js';

/**
 * On-device redaction applied before anything is recorded (spec capsule-v1
 * "Redaction"; port of `packages/bug_capsule/lib/src/core/redaction.dart`, checked
 * by spec-fixtures/conformance/redaction.json).
 *
 * * **by name**: JSON keys, header names, query/fragment parameter names and
 *   tracked-input ids that look sensitive;
 * * **by shape**: {@link Redactor.scrubText} finds credentials inside free text;
 * * **by app rules**: `extraKeys` and `patterns` from the app's config.
 *
 * Best effort: it does not find secrets in URL path segments, personal data
 * that is not a credential, or secrets under innocuous names.
 */
export class Redactor {
  static readonly placeholder = '[REDACTED]';

  private static readonly defaultHeaders = new Set([
    'authorization',
    'cookie',
    'set-cookie',
    'proxy-authorization',
    'x-api-key',
    'x-auth-token',
  ]);
  private static readonly exactKeys = new Set(['pin', 'pan', 'otp', 'ssn', 'cvv', 'cvc', 'passcode', 'iban']);
  private static readonly substringKeys = [
    'password',
    'passwd',
    'token',
    'secret',
    'apikey',
    'authorization',
    'cookie',
    'cardnumber',
    'creditcard',
    'privatekey',
    'sessionid',
  ];
  private static readonly exactQueryKeys = new Set(['code', 'sig', 'key', 'auth', 'sid', 'session']);
  private static readonly substringQueryKeys = ['signature', 'credential'];

  readonly extraKeys: readonly string[];
  readonly extraHeaders: readonly string[];
  private readonly normalizedExtraKeys: Set<string>;
  private readonly headers: Set<string>;
  private readonly patterns: readonly RegExp[];

  constructor(options: { extraKeys?: Iterable<string>; extraHeaders?: Iterable<string>; patterns?: Iterable<RegExp> } = {}) {
    this.extraKeys = Object.freeze([...(options.extraKeys ?? [])]);
    this.extraHeaders = Object.freeze([...(options.extraHeaders ?? [])]);
    this.normalizedExtraKeys = new Set(this.extraKeys.map(normalizeKey));
    this.headers = new Set([...Redactor.defaultHeaders, ...this.extraHeaders.map((h) => h.toLowerCase())]);
    this.patterns = Object.freeze([...(options.patterns ?? [])].map(globalCopy));
  }

  /** A redactor with these rules plus more. */
  extend(more: { keys?: Iterable<string>; headers?: Iterable<string>; patterns?: Iterable<RegExp> }): Redactor {
    return new Redactor({
      extraKeys: new Set([...this.extraKeys, ...(more.keys ?? [])]),
      extraHeaders: new Set([...this.extraHeaders, ...(more.headers ?? [])]),
      patterns: [...this.patterns, ...(more.patterns ?? [])],
    });
  }

  isSensitiveKey(key: string): boolean {
    const n = normalizeKey(key);
    if (Redactor.exactKeys.has(n) || this.normalizedExtraKeys.has(n)) return true;
    return Redactor.substringKeys.some((s) => n.includes(s));
  }

  /** Like {@link isSensitiveKey}, plus names that are only secret inside URLs. */
  isSensitiveQueryKey(key: string): boolean {
    if (this.isSensitiveKey(key)) return true;
    const n = normalizeKey(key);
    if (Redactor.exactQueryKeys.has(n)) return true;
    return Redactor.substringQueryKeys.some((s) => n.includes(s));
  }

  isSensitiveHeader(name: string): boolean {
    return this.headers.has(name.toLowerCase()) || this.isSensitiveKey(name);
  }

  // ------------------------------------------------------------------ JSON

  /**
   * Deep copy of a JSON-like value: values under sensitive keys replaced,
   * strings scrubbed, strings holding a JSON object/array redacted
   * recursively (re-encoded only if that changed them).
   */
  redactJson<T = unknown>(value: T): T {
    return this.redact(value, 0)[0] as T;
  }

  private static readonly maxDepth = 64;
  private static readonly maxEmbeddedJson = 64 * 1024;

  private redact(value: unknown, depth: number): [unknown, boolean] {
    if (depth > Redactor.maxDepth) return [Redactor.placeholder, true];
    if (typeof value === 'string') return this.redactString(value, depth);
    if (Array.isArray(value)) {
      let changed = false;
      const out = value.map((item) => {
        const [v, c] = this.redact(item, depth + 1);
        changed ||= c;
        return v;
      });
      return [out, changed];
    }
    if (typeof value === 'object' && value !== null) {
      let changed = false;
      const out: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(value)) {
        if (v !== null && v !== undefined && this.isSensitiveKey(key)) {
          out[key] = Redactor.placeholder;
          changed = true;
        } else {
          const [r, c] = this.redact(v, depth + 1);
          out[key] = r;
          changed ||= c;
        }
      }
      return [out, changed];
    }
    return [value, false];
  }

  private redactString(value: string, depth: number): [unknown, boolean] {
    const trimmed = value.trimStart();
    if (
      trimmed.length >= 2 &&
      value.length <= Redactor.maxEmbeddedJson &&
      (trimmed.startsWith('{') || trimmed.startsWith('['))
    ) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(value);
      } catch {
        decoded = undefined;
      }
      if (typeof decoded === 'object' && decoded !== null) {
        const [redacted, changed] = this.redact(decoded, depth + 1);
        return changed ? [JSON.stringify(redacted), true] : [value, false];
      }
    }
    const scrubbed = this.scrubText(value);
    return [scrubbed, scrubbed !== value];
  }

  // ------------------------------------------------------------ free text

  private static readonly authScheme = /\b(Bearer|Basic|Token|Digest)\s+[A-Za-z0-9\-._~+/]{6,}=*/gi;
  private static readonly jwt = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
  private static readonly knownKeys =
    /\b(?:(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|bc[is]_[A-Za-z0-9_-]{20,})/g;
  private static readonly quotedPair = /(["'])([^"'\\]{1,100})\1(\s*[:=]\s*)(["'])((?:[^"'\\]|\\.)*)\4/g;
  private static readonly equalsPair = /(?<![A-Za-z0-9_\-.[\]])([A-Za-z0-9_\-.[\]]{1,100})=([^&\s"'#;,)<>]+)/g;
  private static readonly colonPair = /(?<![A-Za-z0-9_\-.])([A-Za-z0-9_\-.]{2,100})(\s*:\s*)([^,\s}{\][]+)/g;
  private static readonly digits = /\b[2-6]\d(?:[ -]?\d){11,17}\b/g;

  /** Removes credentials from free text. Returns `text` itself when nothing matched. */
  scrubText(text: string): string {
    if (text.length < 5) return text;
    const P = Redactor.placeholder;
    let out = text;
    out = out.replace(Redactor.authScheme, (_m, scheme: string) => `${scheme} ${P}`);
    out = out.replace(Redactor.jwt, P);
    out = out.replace(Redactor.knownKeys, P);
    out = out.replace(Redactor.quotedPair, (m, q1: string, key: string, sep: string, q2: string, value: string) =>
      !this.isSensitiveQueryKey(key) || value === P ? m : `${q1}${key}${q1}${sep}${q2}${P}${q2}`,
    );
    out = out.replace(Redactor.equalsPair, (m, key: string, value: string) =>
      !this.isSensitiveQueryKey(key) || value === P ? m : `${key}=${P}`,
    );
    out = out.replace(Redactor.colonPair, (m, key: string, sep: string, value: string) =>
      value.startsWith('//') || !this.isSensitiveKey(key) || value.includes(P) ? m : `${key}${sep}${P}`,
    );
    out = out.replace(Redactor.digits, (m) => (luhn(m) ? P : m));
    for (const p of this.patterns) out = out.replace(p, P);
    return out === text ? text : out;
  }

  // ------------------------------------------------------ headers and URLs

  /** Lowercases names, joins multi-value headers, redacts sensitive ones and scrubs the rest. */
  redactHeaders(headers: Record<string, unknown> | Iterable<[string, unknown]>): Record<string, string> {
    const entries = Symbol.iterator in Object(headers) && !isPlainRecord(headers)
      ? [...(headers as Iterable<[string, unknown]>)]
      : Object.entries(headers as Record<string, unknown>);
    const out: Record<string, string> = {};
    for (const [name, value] of entries) {
      out[name.toLowerCase()] = this.isSensitiveHeader(name)
        ? Redactor.placeholder
        : this.scrubText(Array.isArray(value) ? value.join(', ') : String(value));
    }
    return out;
  }

  /**
   * Redacts user info, sensitive query parameters and sensitive `key=value`
   * pairs in the fragment. The path is kept (secrets in paths need an app rule).
   */
  redactUrl(url: string): string {
    const uri = parseUri(url);
    if (!uri) return this.scrubText(url);
    const out = this.redactParsed(uri);
    return out === uri ? url : formatUri(out);
  }

  /** Returns `uri` itself when nothing changed. */
  redactParsed(uri: ParsedUri): ParsedUri {
    try {
      return this.redactParsedUnsafe(uri);
    } catch {
      // Malformed escapes make the query unreadable: drop query and fragment.
      return { ...uri, userInfo: '', query: null, fragment: null };
    }
  }

  private redactParsedUnsafe(uri: ParsedUri): ParsedUri {
    let result = uri;
    if (uri.userInfo) result = { ...result, userInfo: 'REDACTED' };
    if (uri.query !== null && uri.query !== '') {
      let changed = false;
      const params = new Map<string, string[]>();
      for (const [key, values] of queryParametersAll(uri.query)) {
        if (this.isSensitiveQueryKey(key)) {
          changed = true;
          params.set(key, [Redactor.placeholder]);
        } else {
          const scrubbed = values.map((v) => this.scrubText(v));
          if (scrubbed.some((s, i) => s !== values[i])) changed = true;
          params.set(key, scrubbed);
        }
      }
      if (changed) result = { ...result, query: encodeQuery(params) };
    }
    if (uri.fragment !== null && uri.fragment.includes('=')) {
      const scrubbed = uri.fragment.replace(Redactor.equalsPair, (m, key: string) =>
        this.isSensitiveQueryKey(key) ? `${key}=${Redactor.placeholder}` : m,
      );
      if (scrubbed !== uri.fragment) result = { ...result, fragment: normalizeFragment(scrubbed) };
    }
    return result;
  }

  /** Free text bound to a named field: whole value when sensitive, otherwise credentials inside it. */
  redactText(fieldId: string, value: string, sensitive = false): string {
    return sensitive || this.isSensitiveKey(fieldId) ? Redactor.placeholder : this.scrubText(value);
  }
}

/** Dart `Uri(fragment: ...)` normalization: characters outside the fragment set are percent-encoded. */
function normalizeFragment(fragment: string): string {
  return fragment.replace(/%[0-9A-Fa-f]{2}|[^A-Za-z0-9\-._~!$&'()*+,;=:@/?]/g, (c) =>
    c.startsWith('%') && c.length === 3 ? c : encodeURIComponent(c).replace(/[!'()*]/g, (x) => `%${x.charCodeAt(0).toString(16).toUpperCase()}`),
  );
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_\-\s.]/g, '');
}

function globalCopy(p: RegExp): RegExp {
  return p.global ? new RegExp(p.source, p.flags) : new RegExp(p.source, `${p.flags}g`);
}

function isPlainRecord(v: unknown): boolean {
  return typeof v === 'object' && v !== null && Object.getPrototypeOf(v) === Object.prototype;
}

function luhn(candidate: string): boolean {
  const digits = candidate.replace(/[ -]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}
