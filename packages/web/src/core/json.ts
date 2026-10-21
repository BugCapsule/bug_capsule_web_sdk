/** A JSON value as stored in a capsule. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function utf8Encode(s: string): Uint8Array {
  return encoder.encode(s);
}

/** Strict UTF-8 decoding; throws on invalid input. */
export function utf8Decode(b: Uint8Array): string {
  return decoder.decode(b);
}

/** UTF-16 code-unit order, the order Dart's `String.compareTo` uses. */
export function compareUtf16(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Canonical JSON for request-key hashing (spec capsule-v1 "Network
 * matching"): object keys sorted by UTF-16 code units, no whitespace,
 * scalars encoded as `JSON.stringify` does.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).sort(compareUtf16);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  if (value === undefined) return 'null';
  return JSON.stringify(value);
}

/** Two 32-bit FNV-1a passes with different offsets; 16 hex chars. */
export function fnvHash(input: string): string {
  const bytes = utf8Encode(input);
  const fnv = (offset: number) => {
    let h = offset >>> 0;
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i]!;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
  };
  const hex = (v: number) => v.toString(16).padStart(8, '0');
  return `${hex(fnv(0x811c9dc5))}${hex(fnv(0x050c5d1f))}`;
}

/** Counts JSON values in UTF-8 bytes without parsing (same rule as the Dart reader and the backend). */
export function countJsonValues(buf: Uint8Array, limit: number): number {
  let n = 1;
  let inString = false;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i]!;
    if (inString) {
      if (c === 0x5c) i++;
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) {
      inString = true;
    } else if (c === 0x7b || c === 0x5b || c === 0x2c) {
      if (++n > limit) return n;
    }
  }
  return n;
}

export function base64Encode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function base64Decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Truncates to at most [max] UTF-16 code units. */
export function cut(s: string, max: number): string {
  return s.length <= max ? s : s.substring(0, max);
}
