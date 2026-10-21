import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

/** Global the snippet writes to; the SDK reads it (`packages/web/src/monitoring/debug-ids.ts`). */
export const DEBUG_ID_GLOBAL = '_bugcapsuleDebugIds';

const BUNDLE = /\.(?:m|c)?js$/;
const DEBUG_ID_COMMENT = /\/\/# debugId=([0-9a-fA-F-]{32,36})\s*$/m;
const MAPPING_URL = /\/\/[#@] sourceMappingURL=(\S+)\s*$/m;

/**
 * Registers the bundle's debug id at runtime: the key is a stack trace
 * taken inside the bundle, so the SDK can tell which script URL has which
 * id. Appended (not prepended) so no source map mapping moves.
 */
export function snippet(debugId: string): string {
  return `;!function(){try{var e="undefined"!=typeof window?window:"undefined"!=typeof globalThis?globalThis:"undefined"!=typeof self?self:{},n=(new e.Error).stack;n&&(e.${DEBUG_ID_GLOBAL}=e.${DEBUG_ID_GLOBAL}||{},e.${DEBUG_ID_GLOBAL}[n]="${debugId}")}catch(e){}}();`;
}

/** Deterministic UUID (v4 layout) from the bundle's content, so a rebuild of the same code keeps its id. */
export function debugIdFromContent(content: string | Uint8Array): string {
  const h = createHash('sha256').update(content).digest();
  h[6] = (h[6]! & 0x0f) | 0x40;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export function readDebugId(js: string): string | null {
  return DEBUG_ID_COMMENT.exec(js)?.[1]?.toLowerCase() ?? null;
}

/** Bundles (`.js`, `.mjs`, `.cjs`) under the given files and directories, `node_modules` skipped. */
export async function findBundles(inputs: string[]): Promise<string[]> {
  const out: string[] = [];
  const walk = async (p: string) => {
    const s = await stat(p);
    if (s.isDirectory()) {
      if (path.basename(p) === 'node_modules') return;
      const entries = await readdir(p);
      for (const e of entries.sort()) await walk(path.join(p, e));
    } else if (BUNDLE.test(p)) {
      out.push(p);
    }
  };
  for (const input of inputs) await walk(path.resolve(input));
  return out;
}

/** The source map of a bundle: its `sourceMappingURL` (a relative file) or `<bundle>.map`. */
export function mapPathFor(file: string, js: string): string | null {
  const url = MAPPING_URL.exec(js)?.[1];
  if (url && !url.startsWith('data:') && !/^[a-z]+:\/\//i.test(url)) {
    const candidate = path.resolve(path.dirname(file), decodeURIComponent(url.split(/[?#]/)[0]!));
    if (existsSync(candidate)) return candidate;
  }
  return existsSync(`${file}.map`) ? `${file}.map` : null;
}

export interface InjectResult {
  file: string;
  map: string | null;
  debugId: string;
  /** False when the bundle already had a debug id. */
  changed: boolean;
}

/**
 * monitoring-v1 §3: writes `//# debugId=<id>` and the registration snippet
 * into the bundle and `"debugId"` into its source map. Idempotent.
 */
export async function injectFile(file: string, options: { dryRun?: boolean } = {}): Promise<InjectResult> {
  const js = await readFile(file, 'utf8');
  const map = mapPathFor(file, js);
  const existing = readDebugId(js);
  const debugId = existing ?? debugIdFromContent(js);
  let changed = false;
  if (!existing) {
    const addition = `${snippet(debugId)}\n//# debugId=${debugId}\n`;
    const m = MAPPING_URL.exec(js);
    // Keep `sourceMappingURL` the last comment, as browsers expect.
    const next = m ? `${js.substring(0, m.index)}${addition}${js.substring(m.index)}` : `${js}${js.endsWith('\n') ? '' : '\n'}${addition}`;
    if (!options.dryRun) await writeFile(file, next);
    changed = true;
  }
  if (map) {
    const raw = await readFile(map, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.debugId !== debugId) {
      parsed.debugId = debugId;
      parsed.debug_id = debugId;
      if (!options.dryRun) await writeFile(map, JSON.stringify(parsed));
      changed = true;
    }
  }
  return { file, map, debugId, changed };
}

export interface UploadOptions {
  /** Backend base URL. */
  url: string;
  /** Project secret key (`bcs_…`). */
  secretKey: string;
  release?: string;
  /** Prefix of artifact names (default `~/`, which matches any origin). */
  urlPrefix?: string;
  /** Also upload the bundles as `minified_source` (needs `release`; default true). */
  sources?: boolean;
  dryRun?: boolean;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

export interface UploadedFile {
  kind: 'sourcemap' | 'minified_source';
  name: string;
  debugId: string | null;
  status: number;
}

function artifactName(prefix: string, root: string, file: string): string {
  const rel = path.relative(root, file).split(path.sep).join('/');
  return prefix.endsWith('/') ? `${prefix}${rel}` : `${prefix}/${rel}`;
}

async function post(opts: UploadOptions, query: Record<string, string>, body: Uint8Array): Promise<number> {
  const qs = new URLSearchParams(query).toString();
  const target = `${opts.url.replace(/\/+$/, '')}/v1/debug-files?${qs}`;
  const doFetch = opts.fetch ?? fetch;
  const gz = gzipSync(body);
  for (let attempt = 1; ; attempt++) {
    const res = await doFetch(target, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.secretKey}`, 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip' },
      body: gz,
    });
    if (res.ok) return res.status;
    const text = await res.text().catch(() => '');
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const after = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
      await new Promise((r) => setTimeout(r, Number.isFinite(after) ? Math.min(after, 30) * 1000 : 1000 * attempt));
      continue;
    }
    throw new Error(`upload of ${query.name ?? query.kind} failed: HTTP ${res.status} ${text.substring(0, 300)}`);
  }
}

/**
 * Uploads source maps (`kind=sourcemap`, by `debugId` and/or `release` +
 * `name`) and, with a release, the bundles (`kind=minified_source`) to
 * `POST /v1/debug-files` (monitoring-v1 §5.4).
 */
export async function uploadSourcemaps(inputs: string[], opts: UploadOptions): Promise<UploadedFile[]> {
  if (/^bci_/.test(opts.secretKey)) throw new Error('debug files need the project secret key (bcs_…); the ingest key (bci_…) cannot upload');
  const log = opts.log ?? (() => {});
  const prefix = opts.urlPrefix ?? '~/';
  const uploaded: UploadedFile[] = [];
  for (const input of inputs) {
    const root = (await stat(input)).isDirectory() ? path.resolve(input) : path.dirname(path.resolve(input));
    for (const file of await findBundles([input])) {
      const js = await readFile(file);
      const text = js.toString('utf8');
      const map = mapPathFor(file, text);
      const debugId = readDebugId(text);
      if (!map) {
        log(`skip ${path.relative(root, file)}: no source map`);
        continue;
      }
      if (!debugId && !opts.release) {
        log(`skip ${path.relative(root, file)}: no debug id (run "sourcemaps inject" first) and no --release`);
        continue;
      }
      const mapName = artifactName(prefix, root, map);
      const query: Record<string, string> = { kind: 'sourcemap', name: mapName };
      if (debugId) query.debugId = debugId;
      if (opts.release) query.release = opts.release;
      const status = opts.dryRun ? 0 : await post(opts, query, await readFile(map));
      uploaded.push({ kind: 'sourcemap', name: mapName, debugId, status });
      log(`${opts.dryRun ? 'would upload' : 'uploaded'} ${mapName}${debugId ? ` (${debugId})` : ''}`);
      if (opts.release && opts.sources !== false) {
        const name = artifactName(prefix, root, file);
        const q: Record<string, string> = { kind: 'minified_source', release: opts.release, name };
        if (debugId) q.debugId = debugId;
        const s = opts.dryRun ? 0 : await post(opts, q, js);
        uploaded.push({ kind: 'minified_source', name, debugId, status: s });
        log(`${opts.dryRun ? 'would upload' : 'uploaded'} ${name}`);
      }
    }
  }
  return uploaded;
}
