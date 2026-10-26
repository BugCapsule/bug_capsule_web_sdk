import { base64Decode, base64Encode, isObject } from './json.js';
import { Redactor } from './redaction.js';

/**
 * Lossless JSON for interaction payloads (spec capsule-v2 §3.1; port of
 * `typed_value.dart`): byte and numeric arrays, 64-bit integers and maps
 * with non-string keys survive a round trip, so replay hands the app the
 * value it saw when capturing.
 *
 * JavaScript specifics:
 *
 * * a JS `number` that is an integer within ±(2^53 − 1) is written as a plain
 *   JSON integer. JS cannot tell `1` from `1.0`, so integral doubles from
 *   other runtimes (`{"$t":"double","v":"80.0"}`) decode to the number `80`
 *   and re-encode as `80`;
 * * integral numbers beyond 2^53, NaN, ±Infinity and -0 use the `double` tag;
 * * `bigint` uses the `int` tag outside the safe range (and decodes back to a
 *   `bigint` there);
 * * `ArrayBuffer`, `DataView` and `Uint8Array` are `bytes`; `Int32Array`,
 *   `BigInt64Array`, `Float32Array`, `Float64Array` are `i32`, `i64`, `f32`,
 *   `f64`; other typed arrays are plain arrays of numbers;
 * * a `Map` with only string keys (none `$t`) is a JSON object, any other
 *   `Map` (or a plain object with a `$t` key) the `map` tag; tagged maps
 *   decode to `Map`;
 * * anything else that is not plain JSON (class instances, `Date`, `Blob`,
 *   functions, symbols) is `unsupported`, which makes the payload
 *   non-replayable.
 */
export const TypedValue = Object.freeze({
  tag: '$t',

  encode(value: unknown): unknown {
    return encode(value, 0);
  },

  decode(json: unknown): unknown {
    return decode(json);
  },

  /** Whether `json` holds no `unsupported` tag. */
  isReplayable(json: unknown): boolean {
    return isReplayable(json);
  },

  /**
   * Redacts typed-value JSON like {@link Redactor.redactJson} does plain
   * JSON: values under sensitive keys (string keys of plain or tagged maps)
   * are replaced, strings are scrubbed; byte and numeric arrays are left
   * alone. Returns the value and whether anything changed.
   */
  redact(json: unknown, redactor: Redactor): [unknown, boolean] {
    return redact(json, redactor);
  },

  /** Whether `json` contains binary data (`bytes` or numeric arrays). */
  hasBinary(json: unknown): boolean {
    return hasBinary(json);
  },
});

const TAG = '$t';
const MAX_DEPTH = 100;

/** Dart `double.toString()` for the values the `double` tag carries. */
export function dartDoubleString(v: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return 'Infinity';
  if (v === -Infinity) return '-Infinity';
  if (Object.is(v, -0)) return '-0.0';
  const s = String(v);
  return /[.eE]/.test(s) ? s : `${s}.0`;
}

function floatItem(v: number): number | string {
  return Number.isFinite(v) && !Object.is(v, -0) ? v : dartDoubleString(v);
}

function encodeNumber(v: number): unknown {
  if (Number.isFinite(v) && !Object.is(v, -0)) {
    if (!Number.isInteger(v) || Math.abs(v) <= Number.MAX_SAFE_INTEGER) return v;
  }
  return { [TAG]: 'double', v: dartDoubleString(v) };
}

function typeName(value: unknown): string {
  if (typeof value !== 'object' || value === null) return typeof value;
  const ctor = (value as { constructor?: { name?: unknown } }).constructor;
  return typeof ctor?.name === 'string' && ctor.name ? ctor.name : 'Object';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!isObject(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function encode(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return { [TAG]: 'unsupported', type: 'too deep' };
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'string') return value ?? null;
  if (typeof value === 'number') return encodeNumber(value);
  if (typeof value === 'bigint') {
    return value >= BigInt(-Number.MAX_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : { [TAG]: 'int', v: value.toString() };
  }
  if (value instanceof ArrayBuffer) return { [TAG]: 'bytes', b64: base64Encode(new Uint8Array(value)) };
  if (ArrayBuffer.isView(value)) {
    if (value instanceof Uint8Array || value instanceof DataView) {
      return { [TAG]: 'bytes', b64: base64Encode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
    }
    if (value instanceof Int32Array) return { [TAG]: 'i32', v: Array.from(value) };
    if (value instanceof BigInt64Array) return { [TAG]: 'i64', v: Array.from(value, (x) => x.toString()) };
    if (value instanceof Float32Array) return { [TAG]: 'f32', v: Array.from(value, floatItem) };
    if (value instanceof Float64Array) return { [TAG]: 'f64', v: Array.from(value, floatItem) };
    if (value instanceof BigUint64Array) return Array.from(value, (x) => encode(x, depth + 1));
    // Int8, Uint8Clamped, Int16, Uint16, Uint32: lists of integers (as in Dart).
    return Array.from(value as unknown as ArrayLike<number>, (x) => x);
  }
  if (Array.isArray(value)) return value.map((v) => encode(v, depth + 1));
  if (value instanceof Map) {
    const plain = [...value.keys()].every((k) => typeof k === 'string' && k !== TAG);
    if (plain) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of value) out[k as string] = encode(v, depth + 1);
      return out;
    }
    return { [TAG]: 'map', e: [...value].map(([k, v]) => [encode(k, depth + 1), encode(v, depth + 1)]) };
  }
  if (isPlainObject(value)) {
    if (Object.prototype.hasOwnProperty.call(value, TAG)) {
      return { [TAG]: 'map', e: Object.entries(value).map(([k, v]) => [k, encode(v, depth + 1)]) };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = encode(v, depth + 1);
    return out;
  }
  return { [TAG]: 'unsupported', type: typeName(value) };
}

function parseFloatItem(x: unknown): number {
  return typeof x === 'number' ? x : Number(x as string);
}

function parseBigInt(x: unknown): bigint {
  return BigInt(typeof x === 'number' ? Math.trunc(x) : String(x));
}

function decode(json: unknown): unknown {
  if (Array.isArray(json)) return json.map(decode);
  if (!isObject(json)) return json;
  const t = json[TAG];
  if (t === undefined) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(json)) out[k] = decode(v);
    return out;
  }
  const v = json.v;
  switch (t) {
    case 'int': {
      const n = BigInt(v as string);
      return n >= BigInt(-Number.MAX_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n;
    }
    case 'double':
      return Number(v as string);
    case 'bytes':
      return base64Decode(json.b64 as string);
    case 'i32':
      return Int32Array.from(v as number[]);
    case 'i64':
      return BigInt64Array.from((v as unknown[]).map(parseBigInt));
    case 'f32':
      return Float32Array.from((v as unknown[]).map(parseFloatItem));
    case 'f64':
      return Float64Array.from((v as unknown[]).map(parseFloatItem));
    case 'map':
      return new Map((json.e as unknown[][]).map((e) => [decode(e[0]), decode(e[1])]));
    default:
      return null;
  }
}

function isReplayable(json: unknown): boolean {
  if (Array.isArray(json)) return json.every(isReplayable);
  if (!isObject(json)) return true;
  const t = json[TAG];
  if (t === 'unsupported') return false;
  if (t === 'map') return (json.e as unknown[][]).every((e) => isReplayable(e[0]) && isReplayable(e[1]));
  if (t !== undefined) return true;
  return Object.values(json).every(isReplayable);
}

function redact(json: unknown, redactor: Redactor): [unknown, boolean] {
  if (typeof json === 'string') {
    const out = redactor.redactJson(json);
    return [out, out !== json];
  }
  if (Array.isArray(json)) {
    let changed = false;
    const out = json.map((v) => {
      const [r, c] = redact(v, redactor);
      changed ||= c;
      return r;
    });
    return [out, changed];
  }
  if (!isObject(json)) return [json, false];
  const t = json[TAG];
  if (t === undefined) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(json)) {
      if (v !== null && v !== undefined && redactor.isSensitiveKey(key)) {
        out[key] = Redactor.placeholder;
        changed = true;
      } else {
        const [r, c] = redact(v, redactor);
        out[key] = r;
        changed ||= c;
      }
    }
    return [out, changed];
  }
  if (t === 'map') {
    let changed = false;
    const entries = (json.e as unknown[][]).map((pair) => {
      const key = pair[0];
      if (typeof key === 'string' && pair[1] !== null && pair[1] !== undefined && redactor.isSensitiveKey(key)) {
        changed = true;
        return [key, Redactor.placeholder];
      }
      const [k, kc] = redact(key, redactor);
      const [v, vc] = redact(pair[1], redactor);
      changed ||= kc || vc;
      return [k, v];
    });
    return [{ [TAG]: 'map', e: entries }, changed];
  }
  return [json, false];
}

const BINARY_TAGS = new Set(['bytes', 'i32', 'i64', 'f32', 'f64']);

function hasBinary(json: unknown): boolean {
  if (Array.isArray(json)) return json.some(hasBinary);
  if (!isObject(json)) return false;
  const t = json[TAG];
  if (typeof t === 'string' && BINARY_TAGS.has(t)) return true;
  if (t === 'map') return (json.e as unknown[][]).some((e) => hasBinary(e[0]) || hasBinary(e[1]));
  return Object.values(json).some(hasBinary);
}
