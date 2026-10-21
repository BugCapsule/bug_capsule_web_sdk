import type { StackFrame } from './types.js';

/** monitoring-v1 §2: at most 250 frames; the ones closest to the crash are kept. */
export const MAX_FRAMES = 250;

const V8_LINE = /^\s*at\s+/;
const LOCATION = /^(.*?):(\d+)(?::(\d+))?$/;
const URL_LIKE = /^(?:[a-z][a-z0-9+.-]*:|\/|\[native code\]|<anonymous>)/i;

function location(loc: string): Pick<StackFrame, 'absPath' | 'lineno' | 'colno'> {
  const m = LOCATION.exec(loc);
  if (!m) return { absPath: loc };
  const out: Pick<StackFrame, 'absPath' | 'lineno' | 'colno'> = { absPath: m[1]!, lineno: Number(m[2]) };
  if (m[3] !== undefined) out.colno = Number(m[3]);
  return out;
}

function frame(fn: string | undefined, loc: Pick<StackFrame, 'absPath' | 'lineno' | 'colno'>): StackFrame {
  const f: StackFrame = {};
  const name = fn?.trim();
  if (name) f.function = name;
  if (loc.absPath) {
    f.absPath = loc.absPath;
    f.filename = filenameOf(loc.absPath);
  }
  if (loc.lineno !== undefined) f.lineno = loc.lineno;
  if (loc.colno !== undefined) f.colno = loc.colno;
  return f;
}

/** `http(s)://host/path?q` → `/path`; other schemes and paths are kept as they are. */
export function filenameOf(absPath: string): string {
  if (/^https?:\/\//i.test(absPath)) {
    try {
      return new URL(absPath).pathname;
    } catch {
      return absPath;
    }
  }
  return absPath;
}

/** `    at fn (url:1:2)`, `    at url:1:2`, `    at async fn (...)`, `    at eval (eval at f (url:1:2), <anonymous>:1:1)`. */
function parseV8(line: string): StackFrame | null {
  let rest = line.replace(V8_LINE, '').trim();
  if (rest.startsWith('async ')) rest = rest.substring(6);
  let fn: string | undefined;
  let loc = rest;
  const paren = /^(.*?) \((.*)\)$/.exec(rest);
  if (paren) {
    fn = paren[1];
    loc = paren[2]!;
  }
  if (loc.startsWith('eval at ')) {
    // The script that called eval is the useful location.
    const inner = /\(([^()]+?:\d+:\d+)\)/.exec(loc);
    loc = inner ? inner[1]! : '<anonymous>';
    fn ??= 'eval';
  }
  if (loc === 'native' || loc === '<anonymous>') return frame(fn, { absPath: loc === 'native' ? '[native code]' : '<anonymous>' });
  if (/^index \d+$/.test(loc)) return frame(`${fn ?? ''} (${loc})`, {}); // `at async Promise.all (index 0)`
  return frame(fn, location(loc));
}

/** `fn@url:1:2`, `@url:1:2`, `async*fn@url:1:2`, `url line 2 > eval:1:1`, `fn@[native code]`. */
function parseGecko(line: string): StackFrame | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (trimmed === '[native code]') return frame(undefined, { absPath: '[native code]' });
  const at = trimmed.indexOf('@');
  let fn: string | undefined;
  let loc: string;
  if (at === -1) {
    if (!URL_LIKE.test(trimmed)) return null;
    loc = trimmed;
  } else {
    fn = trimmed.substring(0, at).replace(/^async\*/, '');
    loc = trimmed.substring(at + 1);
    if (!URL_LIKE.test(loc)) return null;
  }
  const evalAt = / line (\d+) > (?:eval|Function)/.exec(loc);
  if (evalAt) return frame(fn ?? 'eval', { absPath: loc.substring(0, evalAt.index), lineno: Number(evalAt[1]) });
  if (fn === 'global code' || fn === 'eval code' || fn === 'module code') fn = undefined;
  return frame(fn, location(loc));
}

/**
 * Parses a Chromium (V8), Firefox (Gecko) or Safari (JavaScriptCore)
 * `Error.stack` into frames, **oldest call first, crashing frame last**
 * (monitoring-v1 §2). Lines that are not frames (the message) are skipped.
 */
export function parseStack(stack: string | null | undefined): StackFrame[] {
  if (!stack) return [];
  const lines = stack.split('\n');
  const v8 = lines.some((l) => V8_LINE.test(l));
  const frames: StackFrame[] = [];
  for (const line of lines) {
    if (line.length > 2048) continue;
    const f = v8 ? (V8_LINE.test(line) ? parseV8(line) : null) : parseGecko(line);
    if (f) frames.push(f);
  }
  frames.reverse();
  return frames.length > MAX_FRAMES ? frames.slice(frames.length - MAX_FRAMES) : frames;
}

export type InAppMatcher = string | RegExp;

export interface InAppOptions {
  /** The page origin (`location.origin`); without it no frame is in-app by default. */
  origin?: string | null;
  inAppIncludes?: readonly InAppMatcher[];
  inAppExcludes?: readonly InAppMatcher[];
}

const matches = (s: string, m: InAppMatcher) => (typeof m === 'string' ? s.includes(m) : m.test(s));

/**
 * monitoring-v1 §2 web default: same-origin scripts not under
 * `node_modules` (nor bundler runtimes). `inAppIncludes` (substring or
 * RegExp on `absPath`) win over `inAppExcludes`, which win over the default.
 */
export function isInApp(absPath: string | undefined, options: InAppOptions): boolean {
  if (!absPath) return false;
  if (options.inAppIncludes?.some((m) => matches(absPath, m))) return true;
  if (options.inAppExcludes?.some((m) => matches(absPath, m))) return false;
  if (/\/node_modules\/|webpack\/runtime|\/@vite\/|\/@react-refresh|\.vite\/deps\//.test(absPath)) return false;
  if (!options.origin) return false;
  try {
    return new URL(absPath).origin === options.origin;
  } catch {
    return false;
  }
}

/** Frames for an event: parsed, `inApp` set. */
export function framesOf(stack: string | null | undefined, options: InAppOptions): StackFrame[] {
  return parseStack(stack).map((f) => ({ ...f, inApp: isInApp(f.absPath, options) }));
}
