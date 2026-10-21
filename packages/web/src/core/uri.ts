/**
 * The subset of Dart `Uri` behaviour the capsule format depends on: request
 * keys and redacted URLs must come out the same as in the reference SDK
 * (checked by spec-fixtures/conformance).
 */
export interface ParsedUri {
  scheme: string;
  userInfo: string;
  host: string;
  port: string;
  path: string;
  /** Raw query without `?`, or null when absent. */
  query: string | null;
  /** Raw fragment without `#`, or null when absent. */
  fragment: string | null;
}

const RFC3986 = /^(?:([^:/?#]+):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#([\s\S]*))?$/;
const DEFAULT_PORTS: Record<string, string> = { http: '80', https: '443', ws: '80', wss: '443' };

export function parseUri(raw: string): ParsedUri | null {
  const m = RFC3986.exec(raw);
  if (!m) return null;
  const scheme = (m[1] ?? '').toLowerCase();
  const authority = m[2] ?? '';
  let userInfo = '';
  let hostPort = authority;
  const at = authority.lastIndexOf('@');
  if (at >= 0) {
    userInfo = authority.substring(0, at);
    hostPort = authority.substring(at + 1);
  }
  let host = hostPort;
  let port = '';
  const ipv6 = hostPort.startsWith('[');
  const colon = ipv6 ? hostPort.indexOf(':', hostPort.indexOf(']')) : hostPort.lastIndexOf(':');
  if (colon >= 0) {
    host = hostPort.substring(0, colon);
    port = hostPort.substring(colon + 1);
  }
  if (ipv6) host = host.replace(/^\[|\]$/g, '');
  if (port && DEFAULT_PORTS[scheme] === port) port = '';
  return {
    scheme,
    userInfo,
    host: host.toLowerCase(),
    port,
    path: m[3] ?? '',
    query: m[4] ?? null,
    fragment: m[5] ?? null,
  };
}

export function formatUri(u: ParsedUri): string {
  let out = u.scheme ? `${u.scheme}:` : '';
  if (u.host || u.scheme === 'http' || u.scheme === 'https' || u.userInfo) {
    out += '//';
    if (u.userInfo) out += `${u.userInfo}@`;
    out += u.host.includes(':') ? `[${u.host}]` : u.host;
    if (u.port) out += `:${u.port}`;
  }
  out += u.path;
  if (u.query !== null) out += `?${u.query}`;
  if (u.fragment !== null) out += `#${u.fragment}`;
  return out;
}

/** Dart `Uri.decodeQueryComponent`: `+` is a space; throws on malformed escapes. */
export function decodeQueryComponent(s: string): string {
  return decodeURIComponent(s.replace(/\+/g, ' '));
}

/** Dart `Uri.encodeQueryComponent`: unreserved characters kept, space as `+`. */
export function encodeQueryComponent(s: string): string {
  return encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+');
}

/**
 * Dart `Uri.queryParametersAll`: names in order of first appearance, values
 * in order. Throws on malformed percent escapes.
 */
export function queryParametersAll(query: string | null): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (query === null || query === '') return out;
  for (const part of query.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    const name = decodeQueryComponent(eq < 0 ? part : part.substring(0, eq));
    const value = eq < 0 ? '' : decodeQueryComponent(part.substring(eq + 1));
    const list = out.get(name);
    if (list) list.push(value);
    else out.set(name, [value]);
  }
  return out;
}

/** Dart `Uri.replace(queryParameters: ...)` query encoding. */
export function encodeQuery(params: Map<string, string[]>): string {
  const parts: string[] = [];
  for (const [name, values] of params) {
    for (const v of values) parts.push(`${encodeQueryComponent(name)}=${encodeQueryComponent(v)}`);
  }
  return parts.join('&');
}
