import { parseStack } from './stack.js';
import type { DebugImage, StackFrame } from './types.js';

/** Global the `sourcemaps inject` snippet writes to: `Error().stack` at the top of the bundle → debug id. */
export const DEBUG_ID_GLOBAL = '_bugcapsuleDebugIds';

let cachedCount = -1;
let cached = new Map<string, string>();

/** Script URL → debug id, from the snippets of every bundle that ran so far. */
export function debugIdsByScript(source: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): Map<string, string> {
  const registry = source[DEBUG_ID_GLOBAL];
  if (typeof registry !== 'object' || registry === null) return new Map();
  const entries = Object.entries(registry as Record<string, unknown>);
  if (entries.length === cachedCount && source === globalThis) return cached;
  const out = new Map<string, string>();
  for (const [stack, id] of entries) {
    if (typeof id !== 'string') continue;
    // The newest frame of that stack is the snippet itself, inside the bundle.
    const frames = parseStack(stack);
    const url = frames[frames.length - 1]?.absPath;
    if (url && !out.has(url)) out.set(url, id);
  }
  if (source === globalThis) {
    cachedCount = entries.length;
    cached = out;
  }
  return out;
}

/** monitoring-v1 §3: one `sourcemap` image per script referenced by the frames that has a debug id. */
export function debugImagesFor(frames: StackFrame[], ids: Map<string, string> = debugIdsByScript()): DebugImage[] {
  if (ids.size === 0) return [];
  const images: DebugImage[] = [];
  const seen = new Set<string>();
  for (const f of frames) {
    const file = f.absPath;
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const id = ids.get(file);
    if (id) images.push({ type: 'sourcemap', debugId: id, codeFile: file });
  }
  return images.slice(0, 500);
}
