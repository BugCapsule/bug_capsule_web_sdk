import type { FailureKind, FailureRecord } from './model.js';

const HEX = /\b(0x)?[0-9a-fA-F]{8,}\b/g;
const DIGITS = /\d+/g;
const SPACE = /\s+/g;

/** `<kind>:<type>:<normalized first line of the message>` (spec capsule-v1 "Failure"). */
export function failureSignature(kind: FailureKind, type: string, message: string): string {
  const firstLine = message.split('\n')[0] ?? '';
  let normalized = firstLine.replace(HEX, '#').replace(DIGITS, '#').replace(SPACE, ' ').trim();
  if (normalized.length > 200) normalized = normalized.substring(0, 200);
  return `${kind}:${type}:${normalized}`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.substring(0, max)}…`;
}

/** The failure `type` and `message` of a thrown value (spec runtimes-v1 §5, web). */
export function describeThrown(error: unknown): { type: string; message: string; stack: string | null } {
  if (error instanceof Error || (typeof error === 'object' && error !== null && 'message' in error)) {
    const e = error as Error;
    let type = typeof e.name === 'string' && e.name ? e.name : '';
    if (!type || type === 'Error') {
      const ctor = (e as { constructor?: { name?: string } }).constructor?.name;
      type = ctor && ctor !== 'Object' ? ctor : 'Error';
    }
    return { type, message: safeString(e.message), stack: typeof e.stack === 'string' ? e.stack : null };
  }
  if (error === undefined) return { type: 'undefined', message: '', stack: null };
  if (error === null) return { type: 'null', message: '', stack: null };
  return { type: typeof error === 'string' ? 'String' : typeof error, message: safeString(error), stack: null };
}

function safeString(v: unknown): string {
  try {
    return String(v ?? '');
  } catch {
    return '';
  }
}

/**
 * A failure from a thrown value. `scrub` removes credentials before anything
 * is derived; capture and replay must pass the same function.
 */
export function exceptionFailure(error: unknown, t: number, scrub: (s: string) => string = (s) => s): FailureRecord {
  const { type, message: raw, stack } = describeThrown(error);
  const message = scrub(raw);
  return {
    kind: 'exception',
    signature: failureSignature('exception', type, message),
    type,
    message: truncate(message, 2000),
    stack: stack === null ? null : scrub(truncate(stack, 8000)),
    assertionId: null,
    t,
  };
}

/** A failure raised through a named assertion; the id is its identity. */
export function assertionFailure(assertionId: string, message: string, t: number, scrub: (s: string) => string = (s) => s): FailureRecord {
  return {
    kind: 'assertion',
    signature: failureSignature('assertion', assertionId, ''),
    type: assertionId,
    message: truncate(scrub(message), 2000),
    stack: null,
    assertionId,
    t,
  };
}

export function shiftFailure(f: FailureRecord, offset: number): FailureRecord {
  return { ...f, t: f.t - offset };
}
