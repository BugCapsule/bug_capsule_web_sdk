import { base64Decode, base64Encode, utf8Decode, utf8Encode } from '../core/json.js';
import type { EligibilityBuilder } from '../core/model.js';
import { RequestKeyBuilder, type EndpointRule, type EndpointRuleInit, type HttpFixture } from '../core/network.js';
import type { RecordedWindow } from '../core/recorder.js';
import { mergeBaggage } from '../monitoring/tracing.js';
import type { HttpObservation } from '../monitoring/types.js';
import type { BugCapsuleIntegration, BugCapsuleSession, ReplayContext } from '../types.js';

export interface NetworkOptions {
  /** Capture/replay `window.fetch` (default true). */
  fetch?: boolean;
  /** Capture/replay `XMLHttpRequest` (default true). */
  xhr?: boolean;
  rules?: Iterable<EndpointRule | EndpointRuleInit>;
  ignoreQuery?: Iterable<string>;
  ignoreBodyFields?: Iterable<string>;
  /** Binary response bodies kept up to this size (default 64 KiB). */
  maxBinaryBytes?: number;
  /** Request bodies up to this size take part in the request key (default 64 KiB, fixed). */
  maxKeyBodyBytes?: number;
  /** A response body still streaming after this long is recorded as `truncated` (default 30 s). */
  maxBodyWaitMs?: number;
  /** Requests recorded with method, redacted URL, status and timing only (no headers, no bodies). */
  exclude?: (request: { method: string; url: string }) => boolean;
}

type BodyEncoding = 'json' | 'text' | 'form' | 'base64' | 'omitted' | 'truncated';

interface RequestBody {
  bytes: Uint8Array | null;
  /** The whole body is in `bytes`. */
  complete: boolean;
  length: number;
  contentType: string | null;
  /** Never hashed: multipart, streams, blobs of XHR. */
  unhashable: boolean;
}

const NO_BODY: RequestBody = { bytes: null, complete: true, length: 0, contentType: null, unhashable: false };

function isMultipart(type: string | null): boolean {
  return (type ?? '').toLowerCase().startsWith('multipart/');
}

function isText(type: string): boolean {
  return type.includes('json') || type.startsWith('text/') || type.includes('xml') || type.includes('x-www-form-urlencoded') || type === '';
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function toBytes(v: ArrayBuffer | ArrayBufferView): Uint8Array {
  return v instanceof ArrayBuffer ? new Uint8Array(v.slice(0)) : new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer);
}

async function readCapped(stream: ReadableStream<Uint8Array>, limit: number): Promise<{ bytes: Uint8Array; complete: boolean; length: number }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      length += value.byteLength;
      if (length > limit) break;
      chunks.push(value);
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(chunks.reduce((s, c) => s + c.byteLength, 0));
  let o = 0;
  for (const c of chunks) {
    bytes.set(c, o);
    o += c.byteLength;
  }
  return { bytes, complete, length };
}

/**
 * Network capture and deterministic replay for `fetch` and `XMLHttpRequest`
 * (spec capsule-v1 "Network matching", runtimes-v1 §4/§6).
 *
 * Install it before app code captures a reference to `fetch`
 * (`BugCapsule.init` early in the entry module). Wrappers the app installs
 * later sit above it, so app interceptors and transformations still run
 * during replay; only the bytes on the wire come from the capsule.
 *
 * Capture never buffers whole bodies: a `clone()` of the response is read up
 * to the limit and then cancelled while the app consumes the original
 * unchanged. Streaming request bodies are never read (keyed without a hash,
 * recorded as `omitted`). `text/event-stream` responses are recorded when
 * headers arrive.
 *
 * It is also the one place monitoring observes `fetch`/XHR (spans,
 * breadcrumbs, `traceparent`/`baggage`), recording or not; those headers are
 * added after the request is keyed and recorded, and never during replay.
 */
export class NetworkIntegration implements BugCapsuleIntegration {
  readonly name: string;
  readonly capabilities: Record<string, string>;
  readonly keys: RequestKeyBuilder;
  private readonly opts: Required<Pick<NetworkOptions, 'fetch' | 'xhr' | 'maxBinaryBytes' | 'maxKeyBodyBytes' | 'maxBodyWaitMs'>> & NetworkOptions;
  private session: BugCapsuleSession | null = null;
  private readonly occurrences = new Map<string, number>();
  private nextId = 0;
  private restoreFns: (() => void)[] = [];

  constructor(options: NetworkOptions = {}, name?: string) {
    this.opts = { fetch: true, xhr: true, maxBinaryBytes: 64 * 1024, maxKeyBodyBytes: 64 * 1024, maxBodyWaitMs: 30_000, ...options };
    this.name = name ?? (this.opts.fetch && this.opts.xhr ? 'network' : this.opts.fetch ? 'fetch' : 'xhr');
    this.keys = new RequestKeyBuilder({
      rules: options.rules ?? [],
      ...(options.ignoreQuery ? { globalIgnoreQuery: options.ignoreQuery } : {}),
      globalIgnoreBodyFields: options.ignoreBodyFields ?? [],
    });
    this.capabilities = {
      ...(this.opts.fetch ? { 'network.fetch': 'supported' } : {}),
      ...(this.opts.xhr ? { 'network.xhr': 'supported' } : {}),
    };
  }

  /** Wraps `fetch`. */
  get coversFetch(): boolean {
    return this.opts.fetch;
  }
  /** Wraps `XMLHttpRequest`. */
  get coversXhr(): boolean {
    return this.opts.xhr;
  }

  setUp(session: BugCapsuleSession): void {
    this.session = session;
    if (this.opts.fetch && typeof globalThis.fetch === 'function') this.installFetch();
    if (this.opts.xhr && typeof XMLHttpRequest !== 'undefined') this.installXhr();
  }

  dispose(): void {
    for (const r of this.restoreFns.reverse()) r();
    this.restoreFns = [];
  }

  describeEligibility(eligibility: EligibilityBuilder, window: RecordedWindow): void {
    const missing = window.events.filter(
      (e) => e.type === 'http' && e.data.error == null && (e.data.bodyEncoding === 'omitted' || e.data.bodyEncoding === 'truncated'),
    );
    if (missing.length > 0) {
      eligibility.missing('network.bodies', `${missing.length} recorded responses have no body (capture disabled, excluded or too large)`);
    }
  }

  // ------------------------------------------------------------- shared

  private absolute(url: string): string {
    try {
      return new URL(url, globalThis.location?.href).href;
    } catch {
      return url;
    }
  }

  /** Decodes a complete body for keying and storage: redacted JSON, form fields, scrubbed text, or small binary as base64. */
  decode(bytes: Uint8Array, contentType: string | null): [unknown, BodyEncoding] {
    if (bytes.length === 0) return [null, 'json'];
    const redactor = this.session!.redactor;
    const type = (contentType ?? '').toLowerCase();
    if (isText(type)) {
      let text: string;
      try {
        text = utf8Decode(bytes);
      } catch {
        return this.binary(bytes);
      }
      if (type.includes('json') || type === '') {
        try {
          return [redactor.redactJson(JSON.parse(text)), 'json'];
        } catch {
          return [redactor.scrubText(text), 'text'];
        }
      }
      if (type.includes('x-www-form-urlencoded')) {
        try {
          const form: Record<string, string> = {};
          for (const [k, v] of new URLSearchParams(text)) form[k] = v;
          return [redactor.redactJson(form), 'form'];
        } catch {
          return [redactor.scrubText(text), 'text'];
        }
      }
      return [redactor.scrubText(text), 'text'];
    }
    return this.binary(bytes);
  }

  private binary(bytes: Uint8Array): [unknown, BodyEncoding] {
    return bytes.length > this.opts.maxBinaryBytes ? [null, 'truncated'] : [base64Encode(bytes), 'base64'];
  }

  private encodeBody(body: unknown, encoding: string): Uint8Array {
    switch (encoding) {
      case 'json':
        return body === null || body === undefined ? new Uint8Array(0) : utf8Encode(JSON.stringify(body));
      case 'text':
        return utf8Encode(typeof body === 'string' ? body : '');
      case 'form':
        return utf8Encode(new URLSearchParams(body as Record<string, string>).toString());
      case 'base64':
        return base64Decode(body as string);
      default:
        return new Uint8Array(0);
    }
  }

  /** The request key, computed identically in capture and replay whatever the capture settings. */
  keyFor(method: string, url: string, body: RequestBody): string {
    const s = this.session!;
    let keyBody: unknown = null;
    if (body.bytes && body.complete && !body.unhashable && body.length <= this.opts.maxKeyBodyBytes && !isMultipart(body.contentType)) {
      keyBody = this.decode(body.bytes, body.contentType)[0];
    }
    return this.keys.keyFor(method, s.redactor.redactUrl(url), keyBody);
  }

  private nextOccurrence(key: string): number {
    const n = this.occurrences.has(key) ? this.occurrences.get(key)! + 1 : 0;
    this.occurrences.set(key, n);
    return n;
  }

  private record(data: () => Record<string, unknown>): void {
    try {
      this.session?.record('http', data());
    } catch {
      // recording must never break the app's request
    }
  }

  private requestRecord(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: RequestBody,
    key: string,
    occurrence: number,
    excluded: boolean,
  ): Record<string, unknown> {
    const s = this.session!;
    const captureBodies = s.captureNetworkBodies && !excluded;
    let requestBody: unknown = null;
    let requestEncoding: BodyEncoding = 'json';
    if (body.length > 0 || body.unhashable) {
      if (!captureBodies || isMultipart(body.contentType) || body.unhashable) requestEncoding = 'omitted';
      else if (body.bytes && body.complete && body.length <= s.maxBodyBytes) [requestBody, requestEncoding] = this.decode(body.bytes, body.contentType);
      else requestEncoding = 'truncated';
    }
    return {
      id: this.nextId++,
      key,
      occurrence,
      method: method.toUpperCase(),
      url: s.redactor.redactUrl(url),
      ...(excluded ? { excluded: true } : { requestHeaders: s.redactor.redactHeaders(headers) }),
      requestBody,
      requestEncoding,
    };
  }

  private errorJson(type: string, message: string): Record<string, unknown> {
    return { type, message: this.session!.redactor.scrubText(message) };
  }

  /** Waits the recorded latency (abortable); idle compression leaves the clock alone meanwhile. */
  private async wait(replay: ReplayContext, ms: number, signal?: AbortSignal | null): Promise<void> {
    const done = replay.beginWork();
    try {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
          return;
        }
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, ms);
        const onAbort = () => {
          clearTimeout(timer);
          reject(signal!.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    } finally {
      done();
    }
  }

  private replayHeaders(f: HttpFixture): [string, string][] {
    return Object.entries(f.responseHeaders).filter(
      ([k]) => k !== 'content-length' && k !== 'content-encoding' && k !== 'transfer-encoding',
    );
  }

  // -------------------------------------------------------------- fetch

  private installFetch(): void {
    const g = globalThis as { fetch: typeof fetch };
    const previous = g.fetch;
    const self = this;
    const wrapped = function bugCapsuleFetch(this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const session = self.session;
      if (!session) return previous.call(globalThis, input, init);
      if (session.replay) return self.replayFetch(session.replay, previous, input, init);
      const observation = self.observeFetch(session, input, init);
      if (!observation && !session.isRecording) return previous.call(globalThis, input, init);
      const send = observation?.headers
        ? (i: RequestInfo | URL, n?: RequestInit) => previous.call(globalThis, i, withTraceHeaders(i, n, observation.headers!))
        : previous;
      const p = session.isRecording ? self.captureFetch(send, input, init) : send.call(globalThis, input, init);
      if (observation) {
        p.then(
          (r) => observation.finish({ status: r.status }),
          (e) => observation.finish({ error: e }),
        );
      }
      return p;
    };
    g.fetch = wrapped as typeof fetch;
    this.restoreFns.push(() => {
      if (g.fetch === wrapped) g.fetch = previous;
    });
  }

  private observeFetch(session: BugCapsuleSession, input: RequestInfo | URL, init?: RequestInit): HttpObservation | null {
    const monitor = session.monitor;
    if (!monitor) return null;
    try {
      const { method, url } = this.fetchMethodUrl(input, init);
      return monitor.httpStart({ kind: 'fetch', method, url });
    } catch {
      return null;
    }
  }

  private fetchMethodUrl(input: RequestInfo | URL, init?: RequestInit): { method: string; url: string; headers: Headers; signal: AbortSignal | null } {
    const req = typeof Request !== 'undefined' && input instanceof Request ? input : null;
    const url = this.absolute(req ? req.url : String(input instanceof URL ? input.href : input));
    const method = (init?.method ?? req?.method ?? 'GET').toUpperCase();
    const headers = new Headers(req?.headers);
    if (init?.headers) new Headers(init.headers).forEach((v, k) => headers.set(k, v));
    return { method, url, headers, signal: init?.signal ?? req?.signal ?? null };
  }

  private async fetchBody(input: RequestInfo | URL, init: RequestInit | undefined, headers: Headers): Promise<RequestBody> {
    const limit = Math.max(this.session!.maxBodyBytes, this.opts.maxKeyBodyBytes);
    let contentType = headers.get('content-type');
    const body = init?.body;
    if (body === undefined || body === null) {
      const req = typeof Request !== 'undefined' && input instanceof Request ? input : null;
      if (!req || req.body === null || init?.body === null) return NO_BODY;
      if (req.bodyUsed) return { ...NO_BODY, unhashable: true, contentType };
      const read = await readCapped(req.clone().body!, limit);
      return { bytes: read.bytes, complete: read.complete, length: read.length, contentType, unhashable: false };
    }
    if (typeof body === 'string') {
      const bytes = utf8Encode(body);
      return { bytes, complete: true, length: bytes.length, contentType: contentType ?? 'text/plain;charset=UTF-8', unhashable: false };
    }
    if (body instanceof URLSearchParams) {
      const bytes = utf8Encode(body.toString());
      return { bytes, complete: true, length: bytes.length, contentType: contentType ?? 'application/x-www-form-urlencoded;charset=UTF-8', unhashable: false };
    }
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      return { bytes: null, complete: false, length: 1, contentType: contentType ?? 'multipart/form-data', unhashable: true };
    }
    if (typeof Blob !== 'undefined' && body instanceof Blob) {
      contentType ??= body.type || null;
      const bytes = new Uint8Array(await body.slice(0, limit + 1).arrayBuffer());
      return { bytes: bytes.length > limit ? bytes.subarray(0, limit) : bytes, complete: body.size <= limit, length: body.size, contentType, unhashable: false };
    }
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      const bytes = toBytes(body as ArrayBuffer | ArrayBufferView);
      return { bytes, complete: true, length: bytes.length, contentType, unhashable: false };
    }
    // ReadableStream and anything else: never consumed.
    return { bytes: null, complete: false, length: 1, contentType, unhashable: true };
  }

  private fetchError(e: unknown): Record<string, unknown> {
    const name = (e as { name?: string })?.name;
    const message = (e as { message?: string })?.message ?? String(e);
    const type = name === 'AbortError' ? 'cancel' : name === 'TimeoutError' ? 'receiveTimeout' : 'connectionError';
    return this.errorJson(type, message);
  }

  private async captureFetch(previous: typeof fetch, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const session = this.session!;
    const started = now();
    let meta: ReturnType<NetworkIntegration['fetchMethodUrl']>;
    let body: RequestBody;
    let key: string | null = null;
    let occurrence = 0;
    let excluded = false;
    try {
      meta = this.fetchMethodUrl(input, init);
      excluded = this.opts.exclude?.({ method: meta.method, url: meta.url }) ?? false;
      body = await this.fetchBody(input, init, meta.headers);
      key = this.keyFor(meta.method, meta.url, body);
      occurrence = this.nextOccurrence(key);
    } catch {
      return previous.call(globalThis, input, init); // keying failed: not recorded, the request still runs
    }
    const base = () => {
      const headers: Record<string, string> = {};
      meta.headers.forEach((v, k) => (headers[k] = v));
      return this.requestRecord(meta.method, meta.url, headers, body, key!, occurrence, excluded);
    };
    let response: Response;
    try {
      response = await previous.call(globalThis, input, init);
    } catch (e) {
      this.record(() => ({ ...base(), status: 0, durationMs: Math.round(now() - started), bodyEncoding: 'omitted', error: this.fetchError(e) }));
      throw e;
    }
    const head = () => {
      const headers: Record<string, string> = {};
      response.headers.forEach((v, k) => (headers[k] = v));
      return {
        ...base(),
        status: response.status,
        statusMessage: response.statusText || null,
        ...(excluded ? {} : { responseHeaders: session.redactor.redactHeaders(headers) }),
      };
    };
    const contentType = response.headers.get('content-type');
    const sse = (contentType ?? '').toLowerCase().includes('event-stream');
    if (sse || !session.captureNetworkBodies || excluded || response.body === null) {
      const bodyless = response.body === null && !sse && session.captureNetworkBodies && !excluded;
      this.record(() => ({
        ...head(),
        durationMs: Math.round(now() - started),
        ...(bodyless ? { responseBody: null, bodyEncoding: 'json' } : { bodyEncoding: 'omitted' }),
      }));
      return response;
    }
    const limit = isText((contentType ?? '').toLowerCase()) ? session.maxBodyBytes : this.opts.maxBinaryBytes;
    let clone: Response;
    try {
      clone = response.clone();
    } catch {
      this.record(() => ({ ...head(), durationMs: Math.round(now() - started), bodyEncoding: 'omitted' }));
      return response;
    }
    let recorded = false;
    const finish = (extra: Record<string, unknown>) => {
      if (recorded) return;
      recorded = true;
      clearTimeout(timer);
      this.record(() => ({ ...head(), durationMs: Math.round(now() - started), ...extra }));
    };
    const timer = setTimeout(() => {
      finish({ bodyEncoding: 'truncated' });
      void clone.body?.cancel().catch(() => {});
    }, this.opts.maxBodyWaitMs);
    void readCapped(clone.body!, limit).then(
      (read) => {
        if (!read.complete) return finish({ bodyEncoding: 'truncated' });
        try {
          const [responseBody, bodyEncoding] = this.decode(read.bytes, contentType);
          finish({ responseBody, bodyEncoding });
        } catch {
          finish({ bodyEncoding: 'truncated' });
        }
      },
      (e) => finish({ bodyEncoding: 'truncated', error: this.fetchError(e) }),
    );
    return response;
  }

  private async replayFetch(replay: ReplayContext, previous: typeof fetch, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const meta = this.fetchMethodUrl(input, init);
    const body = await this.fetchBody(input, init, meta.headers);
    const key = this.keyFor(meta.method, meta.url, body);
    const lookup = replay.fixtures.take(key);
    if (!lookup) {
      replay.diverge('network.unrecorded', key);
      if (!replay.settings.strictNetwork) {
        const done = replay.beginWork();
        try {
          return await previous.call(globalThis, input, init);
        } finally {
          done();
        }
      }
      throw new TypeError(`BugCapsule replay: no recorded response for ${key}`);
    }
    if (lookup.reused) replay.diverge('network.reused', key);
    const f = lookup.fixture;
    replay.fixtureServed();
    await this.wait(replay, f.durationMs, meta.signal);
    const error = f.error;
    if (error && f.status === 0) {
      const message = error.message ?? 'replayed network error';
      if (error.type === 'cancel') throw new DOMException(message, 'AbortError');
      if (error.type === 'receiveTimeout' || error.type === 'connectionTimeout' || error.type === 'sendTimeout') {
        throw new DOMException(message, 'TimeoutError');
      }
      throw new TypeError(message);
    }
    if (!f.hasBody && f.status !== 204 && f.status !== 304) replay.diverge('network.noBody', key);
    const nullBody = f.status === 204 || f.status === 205 || f.status === 304 || meta.method === 'HEAD';
    const response = new Response(nullBody ? null : (this.encodeBody(f.responseBody, f.bodyEncoding) as BodyInit), {
      status: f.status < 200 || f.status > 599 ? 200 : f.status,
      statusText: f.statusMessage ?? '',
      headers: this.replayHeaders(f),
    });
    Object.defineProperty(response, 'url', { value: meta.url });
    return response;
  }

  // ---------------------------------------------------------------- XHR

  private installXhr(): void {
    const proto = XMLHttpRequest.prototype;
    const originals = { open: proto.open, send: proto.send, setRequestHeader: proto.setRequestHeader, abort: proto.abort };
    const states = new WeakMap<XMLHttpRequest, XhrState>();
    const self = this;
    proto.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      states.set(this, { method: String(method).toUpperCase(), url: self.absolute(String(url)), headers: {}, async: rest[0] !== false });
      return (originals.open as (...a: unknown[]) => void).call(this, method, url, ...rest);
    } as typeof proto.open;
    proto.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
      const st = states.get(this);
      if (st) st.headers[name.toLowerCase()] = st.headers[name.toLowerCase()] ? `${st.headers[name.toLowerCase()]}, ${value}` : value;
      if (st?.replaying) return;
      return originals.setRequestHeader.call(this, name, value);
    };
    proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      const st = states.get(this);
      const session = self.session;
      if (!st || !session) return originals.send.call(this, body);
      if (session.replay) return self.replayXhr(session.replay, this, st, body ?? null, () => originals.send.call(this, body));
      if (session.isRecording) self.captureXhr(this, st, body ?? null);
      self.observeXhr(session, this, st, originals.setRequestHeader);
      return originals.send.call(this, body);
    };
    proto.abort = function (this: XMLHttpRequest) {
      const st = states.get(this);
      if (st?.replaying) {
        st.abortReplay?.();
        return;
      }
      return originals.abort.call(this);
    };
    this.restoreFns.push(() => Object.assign(proto, originals));
  }

  /** Monitoring: span + breadcrumb, and trace headers set past the recorded ones. */
  private observeXhr(session: BugCapsuleSession, xhr: XMLHttpRequest, st: XhrState, setHeader: XMLHttpRequest['setRequestHeader']): void {
    const monitor = session.monitor;
    if (!monitor) return;
    let observation: HttpObservation | null = null;
    try {
      observation = monitor.httpStart({ kind: 'xhr', method: st.method, url: st.url });
      const headers = observation?.headers;
      if (headers) {
        if (st.headers.traceparent === undefined) setHeader.call(xhr, 'traceparent', headers.traceparent!);
        // XHR joins repeated headers with ", ": only add ours when the app sent no BugCapsule baggage.
        const existing = st.headers.baggage;
        if (headers.baggage && mergeBaggage(existing, headers.baggage) !== existing) setHeader.call(xhr, 'baggage', headers.baggage);
      }
    } catch {
      // never break the app's request
    }
    if (!observation) return;
    let failed: unknown;
    xhr.addEventListener('error', () => (failed = new TypeError('XMLHttpRequest error')));
    xhr.addEventListener('timeout', () => (failed = new DOMException('XMLHttpRequest timeout', 'TimeoutError')));
    xhr.addEventListener('abort', () => (failed = new DOMException('XMLHttpRequest aborted', 'AbortError')));
    xhr.addEventListener('loadend', () => observation!.finish(xhr.status > 0 ? { status: xhr.status } : { error: failed }));
  }

  private xhrBody(body: Document | XMLHttpRequestBodyInit | null, headers: Record<string, string>): RequestBody {
    let contentType = headers['content-type'] ?? null;
    if (body === null || body === undefined) return NO_BODY;
    if (typeof body === 'string') {
      const bytes = utf8Encode(body);
      return { bytes, complete: true, length: bytes.length, contentType: contentType ?? 'text/plain;charset=UTF-8', unhashable: false };
    }
    if (body instanceof URLSearchParams) {
      const bytes = utf8Encode(body.toString());
      return { bytes, complete: true, length: bytes.length, contentType: contentType ?? 'application/x-www-form-urlencoded;charset=UTF-8', unhashable: false };
    }
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      const bytes = toBytes(body as ArrayBuffer | ArrayBufferView);
      return { bytes, complete: true, length: bytes.length, contentType, unhashable: false };
    }
    if (typeof Blob !== 'undefined' && body instanceof Blob) contentType ??= body.type || null;
    // FormData, Blob (async to read), Document: never hashed.
    return { bytes: null, complete: false, length: 1, contentType, unhashable: true };
  }

  private captureXhr(xhr: XMLHttpRequest, st: XhrState, raw: Document | XMLHttpRequestBodyInit | null): void {
    const session = this.session!;
    const started = now();
    let key: string;
    let occurrence: number;
    let body: RequestBody;
    const excluded = this.opts.exclude?.({ method: st.method, url: st.url }) ?? false;
    try {
      body = this.xhrBody(raw, st.headers);
      key = this.keyFor(st.method, st.url, body);
      occurrence = this.nextOccurrence(key);
    } catch {
      return;
    }
    let error: Record<string, unknown> | null = null;
    xhr.addEventListener('error', () => (error = this.errorJson('connectionError', 'XMLHttpRequest error')));
    xhr.addEventListener('timeout', () => (error = this.errorJson('receiveTimeout', 'XMLHttpRequest timeout')));
    xhr.addEventListener('abort', () => (error = this.errorJson('cancel', 'XMLHttpRequest aborted')));
    xhr.addEventListener('loadend', () => {
      this.record(() => {
        const base = this.requestRecord(st.method, st.url, st.headers, body, key, occurrence, excluded);
        const durationMs = Math.round(now() - started);
        if (error && xhr.status === 0) return { ...base, status: 0, durationMs, bodyEncoding: 'omitted', error };
        const headers = parseRawHeaders(xhr.getAllResponseHeaders());
        const out: Record<string, unknown> = {
          ...base,
          status: xhr.status,
          statusMessage: xhr.statusText || null,
          ...(excluded ? {} : { responseHeaders: session.redactor.redactHeaders(headers) }),
          durationMs,
          ...(error ? { error } : {}),
        };
        if (!session.captureNetworkBodies || excluded) return { ...out, bodyEncoding: 'omitted' };
        const type = (headers['content-type'] ?? '').toLowerCase();
        const rt = xhr.responseType;
        if (rt === '' || rt === 'text') {
          const bytes = utf8Encode(xhr.responseText ?? '');
          if (bytes.length > (isText(type) ? session.maxBodyBytes : this.opts.maxBinaryBytes)) return { ...out, bodyEncoding: 'truncated' };
          const [responseBody, bodyEncoding] = this.decode(bytes, headers['content-type'] ?? null);
          return { ...out, responseBody, bodyEncoding };
        }
        if (rt === 'json') {
          const text = xhr.response == null ? '' : JSON.stringify(xhr.response);
          if (text.length > session.maxBodyBytes) return { ...out, bodyEncoding: 'truncated' };
          return { ...out, responseBody: xhr.response == null ? null : session.redactor.redactJson(xhr.response), bodyEncoding: 'json' };
        }
        if (rt === 'arraybuffer' && xhr.response instanceof ArrayBuffer) {
          const [responseBody, bodyEncoding] = this.decode(new Uint8Array(xhr.response), headers['content-type'] ?? null);
          return { ...out, responseBody, bodyEncoding };
        }
        return { ...out, bodyEncoding: 'omitted' };
      });
    });
  }

  private replayXhr(
    replay: ReplayContext,
    xhr: XMLHttpRequest,
    st: XhrState,
    raw: Document | XMLHttpRequestBodyInit | null,
    sendReal: () => void,
  ): void {
    const key = this.keyFor(st.method, st.url, this.xhrBody(raw, st.headers));
    const lookup = replay.fixtures.take(key);
    if (!lookup) {
      replay.diverge('network.unrecorded', key);
      if (!replay.settings.strictNetwork) {
        sendReal();
        return;
      }
    } else {
      if (lookup.reused) replay.diverge('network.reused', key);
      replay.fixtureServed();
    }
    st.replaying = true;
    const f = lookup?.fixture ?? null;
    const define = (props: Record<string, unknown>) => {
      for (const [k, value] of Object.entries(props)) Object.defineProperty(xhr, k, { value, configurable: true, writable: true });
    };
    const fire = (type: string) => {
      const ev = type === 'readystatechange' ? new Event(type) : new ProgressEvent(type);
      xhr.dispatchEvent(ev);
    };
    const finishWith = (outcome: 'load' | 'error' | 'timeout' | 'abort') => {
      if (outcome !== 'load') {
        define({ readyState: 4, status: 0, statusText: '', response: xhr.responseType === '' || xhr.responseType === 'text' ? '' : null, responseText: '' });
        fire('readystatechange');
        fire(outcome);
        fire('loadend');
        return;
      }
      const fx = f!;
      if (!fx.hasBody && fx.status !== 204 && fx.status !== 304) replay.diverge('network.noBody', key);
      const bytes = this.encodeBody(fx.responseBody, fx.bodyEncoding);
      const headers = this.replayHeaders(fx);
      const rawHeaders = headers.map(([k, v]) => `${k}: ${v}`).join('\r\n');
      const text = (() => {
        try {
          return utf8Decode(bytes);
        } catch {
          return '';
        }
      })();
      const rt = xhr.responseType;
      const response =
        rt === 'json' ? (text ? safeJson(text) : null) : rt === 'arraybuffer' ? bytes.buffer.slice(0) : rt === 'blob' ? new Blob([bytes as BlobPart]) : text;
      define({
        status: fx.status,
        statusText: fx.statusMessage ?? '',
        responseURL: st.url,
        getAllResponseHeaders: () => (rawHeaders ? `${rawHeaders}\r\n` : ''),
        getResponseHeader: (name: string) => headers.find(([k]) => k === name.toLowerCase())?.[1] ?? null,
      });
      define({ readyState: 2 });
      fire('readystatechange');
      define({ readyState: 3 });
      fire('readystatechange');
      define({ readyState: 4, response, ...(rt === '' || rt === 'text' ? { responseText: text } : {}) });
      fire('readystatechange');
      fire('load');
      fire('loadend');
    };
    const outcome = (): 'load' | 'error' | 'timeout' | 'abort' => {
      if (!f) return 'error';
      const error = f.error;
      if (error && f.status === 0) {
        return error.type === 'cancel' ? 'abort' : error.type?.endsWith('Timeout') ? 'timeout' : 'error';
      }
      return 'load';
    };
    if (!st.async) {
      finishWith(outcome());
      return;
    }
    const duration = f?.durationMs ?? 0;
    const timeoutMs = xhr.timeout > 0 && duration > xhr.timeout ? xhr.timeout : null;
    const done = replay.beginWork();
    const timer = setTimeout(() => {
      done();
      st.abortReplay = undefined;
      finishWith(timeoutMs !== null ? 'timeout' : outcome());
    }, timeoutMs ?? duration);
    st.abortReplay = () => {
      clearTimeout(timer);
      done();
      st.abortReplay = undefined;
      finishWith('abort');
    };
    fire('loadstart');
  }
}

interface XhrState {
  method: string;
  url: string;
  headers: Record<string, string>;
  async: boolean;
  replaying?: boolean;
  abortReplay?: (() => void) | undefined;
}

/** The request init with `traceparent` (unless the app set one) and `baggage` (merged) added. */
function withTraceHeaders(input: RequestInfo | URL, init: RequestInit | undefined, trace: Record<string, string>): RequestInit | undefined {
  try {
    return addTraceHeaders(input, init, trace);
  } catch {
    return init; // the request goes out as the app made it
  }
}

function addTraceHeaders(input: RequestInfo | URL, init: RequestInit | undefined, trace: Record<string, string>): RequestInit {
  const req = typeof Request !== 'undefined' && input instanceof Request ? input : null;
  // fetch(request, { headers }) replaces the request's headers, so start from what fetch would send.
  const headers = new Headers(init?.headers ?? req?.headers);
  if (trace.traceparent && !headers.has('traceparent')) headers.set('traceparent', trace.traceparent);
  if (trace.baggage) headers.set('baggage', mergeBaggage(headers.get('baggage'), trace.baggage));
  return { ...init, headers };
}

function parseRawHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.trim().split(/[\r\n]+/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.substring(0, i).trim().toLowerCase();
    const v = line.substring(i + 1).trim();
    out[k] = out[k] ? `${out[k]}, ${v}` : v;
  }
  return out;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** fetch + XMLHttpRequest with one shared occurrence counter (recommended). */
export function networkIntegration(options: NetworkOptions = {}): NetworkIntegration {
  return new NetworkIntegration(options);
}

/** fetch only. */
export function fetchIntegration(options: Omit<NetworkOptions, 'fetch' | 'xhr'> = {}): NetworkIntegration {
  return new NetworkIntegration({ ...options, fetch: true, xhr: false });
}

/** XMLHttpRequest only. */
export function xhrIntegration(options: Omit<NetworkOptions, 'fetch' | 'xhr'> = {}): NetworkIntegration {
  return new NetworkIntegration({ ...options, fetch: false, xhr: true });
}
