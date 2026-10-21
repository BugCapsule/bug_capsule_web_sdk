function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

function hex(bytes: Uint8Array): string {
  let s = '';
  for (const x of bytes) s += x.toString(16).padStart(2, '0');
  return s;
}

/** Random hex id of `bytes` bytes, never all zero (monitoring-v1 §1: all-zero ids are invalid). */
function nonZeroHex(bytes: number): string {
  for (;;) {
    const h = hex(randomBytes(bytes));
    if (/[^0]/.test(h)) return h;
  }
}

export function uuid4(): string {
  const c = globalThis.crypto as Crypto & { randomUUID?: () => string };
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  const b = randomBytes(16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 32 lowercase hex chars. */
export function traceId(): string {
  return nonZeroHex(16);
}

/** 16 lowercase hex chars. */
export function spanId(): string {
  return nonZeroHex(8);
}

export const isTraceId = (s: string) => /^[0-9a-f]{32}$/.test(s) && /[^0]/.test(s);
export const isSpanId = (s: string) => /^[0-9a-f]{16}$/.test(s) && /[^0]/.test(s);

/** ISO-8601 (UTC) of epoch milliseconds, fractional milliseconds dropped. */
export function iso(ms: number): string {
  return new Date(Math.floor(ms)).toISOString();
}
