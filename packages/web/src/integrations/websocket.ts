import {
  DEFAULT_INTERACTION_LIMITS,
  DependencyGaps,
  DependencyKinds,
  DependencyStats,
  OccurrenceCounter,
  parsePayload,
  PayloadBudget,
  PayloadEncoder,
  payloadToJson,
  samePayload,
  type InteractionLimits,
  type InteractionPayload,
  type RecordedInteraction,
} from '../core/interactions.js';
import { compareUtf16 } from '../core/json.js';
import type { CapsuleDependency, CapsuleEvent, DependencyGap, EligibilityBuilder } from '../core/model.js';
import { DEFAULT_IGNORE_QUERY } from '../core/network.js';
import type { RecordedWindow } from '../core/recorder.js';
import { TypedValue } from '../core/typed-value.js';
import { parseUri, queryParametersAll } from '../core/uri.js';
import { SDK_VERSION } from '../version.js';
import type { BugCapsuleIntegration, BugCapsuleSession, ReplayAdapter, ReplayContext } from '../types.js';

/** Adapter id in `manifest.dependencies[].adapter` and in the remote config's `disabledAdapters`. */
export const WEBSOCKET_ADAPTER_ID = 'bugcapsule-web.websocket';
/** Version of the `ws.*` event payloads this adapter writes and replays. */
export const WEBSOCKET_ADAPTER_SCHEMA = 1;
/** `manifest.dependencies[].id` of the browser WebSocket dependency. */
const DEP = 'ws';

/**
 * Browser engines the adapter's capture → capsule → replay tests ran in
 * (`test/browser/websocket.spec.ts`, Playwright 1.63). Written to
 * `manifest.dependencies[].tested`.
 */
export const WEBSOCKET_TESTED_BROWSERS: readonly { package: string; version: string }[] = Object.freeze([
  { package: 'chromium', version: '153.0.8010.12' },
  { package: 'firefox', version: '155.0' },
  { package: 'webkit', version: '26.6' },
]);

/** Where a binary frame went. */
export interface WebSocketFrameInfo {
  direction: 'send' | 'message';
  /** The connection URL, redacted. */
  url: string;
}

/**
 * Turns binary frames into recordable values and back. Without one, binary
 * frames are recorded as metadata (their size) and replay cannot deliver
 * them (`ws.noPayload`).
 */
export interface WebSocketBinarySerializer {
  /**
   * Bytes of a frame → a value to record (JSON-like, `Map`, typed arrays,
   * bytes). It goes through redaction like text frames (sensitive keys,
   * credentials in strings); raw bytes are kept as they are. Return
   * `undefined` to record this frame as metadata only.
   */
  decode(bytes: Uint8Array, frame: WebSocketFrameInfo): unknown;
  /** A recorded value → the bytes replay delivers. */
  encode(value: unknown, frame: WebSocketFrameInfo): ArrayBuffer | ArrayBufferView;
}

/**
 * Records binary frames byte for byte. Use it only for frames that carry no
 * personal data or credentials: bytes are not redacted.
 */
export const rawBinarySerializer: WebSocketBinarySerializer = Object.freeze({
  decode: (bytes: Uint8Array) => bytes,
  encode: (value: unknown) => (value instanceof Uint8Array ? value : new Uint8Array(0)),
});

export interface WebSocketOptions {
  /** Query parameters left out of the connection match key (default: `_`, `ts`, `timestamp`, `nonce`, `cachebust`). */
  ignoreQuery?: Iterable<string>;
  /** Records binary frames (default: metadata only). */
  binary?: WebSocketBinarySerializer;
  /**
   * Text frames the redactor changed are recorded as `redacted` and are not
   * replayable by default (a placeholder could send the app down another
   * path). Set true when the app does not branch on the redacted fields.
   */
  redactedReplayable?: boolean;
  /** Per frame (encoded JSON); larger frames are `truncated`. Default and maximum 64 KiB. */
  maxPayloadBytes?: number;
  /** Frame payloads kept per 5-minute window; later frames are metadata. Default and maximum 1 MiB. */
  maxWindowPayloadBytes?: number;
  /** Sockets captured at the same time; more are not captured (`connections.limit`). Default and maximum 32. */
  maxConnections?: number;
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/** One socket being recorded. */
interface Captured {
  conn: string;
  url: string;
  key: string;
  sends: number;
  messages: number;
  opened: boolean;
  clientClosed: boolean;
  closed: boolean;
  disabledNoted?: boolean;
}

function isBlob(v: unknown): v is Blob {
  return typeof Blob !== 'undefined' && v instanceof Blob;
}

function bytesOf(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  return data instanceof ArrayBuffer ? new Uint8Array(data.slice(0)) : new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
}

/** What a browser sends for `send(data)`: strings, Blobs and buffers as they are, anything else as a string. */
function normalizeFrame(data: unknown): string | Blob | ArrayBuffer | ArrayBufferView {
  if (typeof data === 'string' || isBlob(data) || data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data;
  return String(data);
}

function frameSize(data: unknown): number {
  if (typeof data === 'string') return new TextEncoder().encode(data).length;
  if (isBlob(data)) return data.size;
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data.byteLength;
  return 0;
}

/**
 * WebSocket capture and offline replay (capsule-v2 §4.1, adapter
 * `bugcapsule-web.websocket`, schema 1). Opt-in: add `webSocketIntegration()`
 * to `integrations`.
 *
 * Capture replaces `WebSocket` in the page realm with a subclass of the
 * native one: the app gets the real socket, and connects, opens, sends,
 * messages, errors and closes are recorded (URLs redacted, text frames
 * redacted like JSON bodies, binary frames as metadata unless a
 * {@link WebSocketBinarySerializer} is set), within the capsule-v2 bounds.
 *
 * Replay replaces `WebSocket` with an in-memory fake that never touches the
 * network: connects are matched by key and occurrence, sends are compared
 * with the recording, and recorded server events are delivered with their
 * recorded latency after the operation that released them.
 *
 * Not covered: sockets in workers, iframes and other realms, sockets created
 * before `BugCapsule.init` or through a `WebSocket` reference taken before
 * it, ping/pong and frame-level details.
 */
export class WebSocketIntegration implements BugCapsuleIntegration {
  readonly name = 'websocket';
  readonly capabilities: Record<string, string> = { 'websocket.capture': 'supported', 'websocket.replay': 'supported' };
  readonly replayAdapters: readonly ReplayAdapter[] = [{ adapter: WEBSOCKET_ADAPTER_ID, schemas: [WEBSOCKET_ADAPTER_SCHEMA] }];
  private readonly ignore: ReadonlySet<string>;
  private readonly limits: InteractionLimits;
  private session: BugCapsuleSession | null = null;
  private restoreFns: (() => void)[] = [];
  // capture
  private readonly captured = new WeakMap<object, Captured>();
  private readonly open = new Set<Captured>();
  private readonly occurrences = new OccurrenceCounter();
  private readonly reconnects = new Map<string, number>();
  private nextConn = 0;
  private readonly stats = new DependencyStats();
  private readonly budget: PayloadBudget;
  private encoder: PayloadEncoder | null = null;
  private readonly dropped = new WeakSet<object>();
  /** Session times of sockets not captured (limit, disabled) and of capture failures. */
  private readonly limitHits: number[] = [];
  private readonly disabledHits: number[] = [];
  private readonly failures: number[] = [];

  constructor(private readonly options: WebSocketOptions = {}) {
    this.ignore = new Set(options.ignoreQuery ?? DEFAULT_IGNORE_QUERY);
    const min = (a: number, b: number | undefined) => (b === undefined || !(b < a) ? a : Math.max(0, Math.floor(b)));
    this.limits = {
      ...DEFAULT_INTERACTION_LIMITS,
      maxPayloadBytes: min(DEFAULT_INTERACTION_LIMITS.maxPayloadBytes, options.maxPayloadBytes),
      maxWindowPayloadBytes: min(DEFAULT_INTERACTION_LIMITS.maxWindowPayloadBytes, options.maxWindowPayloadBytes),
      maxActive: min(DEFAULT_INTERACTION_LIMITS.maxActive, options.maxConnections),
    };
    this.budget = new PayloadBudget(this.limits);
  }

  setUp(session: BugCapsuleSession): void {
    this.session = session;
    const native = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (typeof native !== 'function') return;
    this.encoder = new PayloadEncoder({
      redactor: () => session.redactor,
      budget: this.budget,
      stats: this.stats,
      now: () => session.now(),
      redactedReplayable: this.options.redactedReplayable ?? false,
    });
    const replay = session.replay;
    if (replay) {
      // Always the fake: without a recording every connect is ws.unrecorded (capsule-v2 §5), never live.
      this.install(createReplayWebSocket(new ReplayDriver(this, replay, session)));
      return;
    }
    this.install(this.capturingWebSocket(native));
  }

  dispose(): void {
    for (const r of this.restoreFns.reverse()) r();
    this.restoreFns = [];
  }

  private install(replacement: typeof WebSocket): void {
    const g = globalThis as { WebSocket: typeof WebSocket };
    const previous = g.WebSocket;
    g.WebSocket = replacement;
    this.restoreFns.push(() => {
      if (g.WebSocket === replacement) g.WebSocket = previous;
    });
  }

  // ------------------------------------------------------------- shared

  /**
   * `{url, key}` for a connection URL: the redacted URL, and the match key
   * (capsule-v2 §4.1, as the Dart adapter builds it): the redacted URL
   * without fragment and ignored query parameters, the query sorted by name.
   * Same in capture and replay whatever the capture settings.
   */
  keyFor(rawUrl: string): { url: string; key: string } {
    const redactor = this.session!.redactor;
    const url = redactor.redactUrl(rawUrl);
    const u = parseUri(url);
    if (!u) return { url, key: url };
    let query = '';
    try {
      const params = queryParametersAll(u.query);
      const parts: string[] = [];
      for (const name of [...params.keys()].sort(compareUtf16)) {
        if (this.ignore.has(name)) continue;
        for (const v of params.get(name)!) parts.push(`${name}=${v}`);
      }
      query = parts.join('&');
    } catch {
      query = '';
    }
    const host = u.host.includes(':') ? `[${u.host}]` : u.host;
    return { url, key: `${u.scheme}://${host}${u.port ? `:${u.port}` : ''}${u.path === '' ? '/' : u.path}${query ? `?${query}` : ''}` };
  }

  /** A frame as a payload object (text, binary through the serializer, or metadata). */
  framePayload(frame: unknown, info: WebSocketFrameInfo, encoder: PayloadEncoder): InteractionPayload {
    const data = normalizeFrame(frame);
    if (typeof data === 'string') return encoder.encode(data, 'text');
    if (isBlob(data)) {
      this.gap(DependencyGaps.payloadBinaryMetadata, this.options.binary ? 'Blob frames are recorded as metadata (use binaryType = "arraybuffer")' : undefined);
      return { mode: 'metadata', replayable: false, bytes: data.size, kind: 'binary' };
    }
    const bytes = bytesOf(data);
    const serializer = this.options.binary;
    if (!serializer) return encoder.encode(bytes, 'binary');
    let value: unknown;
    try {
      value = serializer.decode(bytes, info);
    } catch {
      this.gap(DependencyGaps.captureFailed, 'binary serializer threw');
      return { mode: 'omitted', replayable: false, bytes: bytes.length, kind: 'binary' };
    }
    if (value === undefined) {
      this.gap(DependencyGaps.payloadBinaryMetadata, 'the binary serializer kept this frame as metadata');
      return { mode: 'metadata', replayable: false, bytes: bytes.length, kind: 'binary' };
    }
    encoder.captureBinary = true;
    try {
      return { ...encoder.encode(value, 'binary'), bytes: bytes.length };
    } finally {
      encoder.captureBinary = false;
    }
  }

  /** The bytes a recorded binary payload stands for (null: cannot be produced). */
  frameBytes(payload: InteractionPayload, info: WebSocketFrameInfo): Uint8Array | null {
    const value = TypedValue.decode(payload.value);
    const serializer = this.options.binary;
    if (serializer) {
      const out = serializer.encode(value, info);
      return out instanceof Uint8Array ? out : bytesOf(out);
    }
    return value instanceof Uint8Array ? value : null;
  }

  get maxPayloadBytes(): number {
    return this.limits.maxPayloadBytes;
  }

  private gap(code: string, detail?: string): void {
    this.stats.gap(code, detail);
    if (code === DependencyGaps.captureFailed) this.failures.push(this.session?.now() ?? 0);
  }

  // ------------------------------------------------------------- capture

  private get capturing(): boolean {
    const s = this.session;
    return !!s && s.isRecording && !(s.adapterDisabled?.(WEBSOCKET_ADAPTER_ID) ?? false);
  }

  private record(c: Captured, type: string, data: () => Record<string, unknown>): void {
    const session = this.session;
    if (!session?.isRecording) return;
    if (session.adapterDisabled?.(WEBSOCKET_ADAPTER_ID)) {
      if (!c.disabledNoted) this.disabledHits.push(session.now());
      c.disabledNoted = true;
      return;
    }
    try {
      const d = data();
      this.stats.events++;
      this.session!.record(type, { dep: DEP, conn: c.conn, ...d });
    } catch {
      this.gap(DependencyGaps.captureFailed, `${type} could not be recorded`);
    }
  }

  private payloadFor(data: unknown, c: Captured, direction: 'send' | 'message'): Record<string, unknown> {
    const before = this.stats.dropped;
    const json = payloadToJson(this.framePayload(data, { direction, url: c.url }, this.encoder!));
    // Told apart from binary metadata in the manifest gaps.
    if (this.stats.dropped > before) this.dropped.add(json);
    return json;
  }

  private capturingWebSocket(Native: typeof WebSocket): typeof WebSocket {
    const integration = this;
    const Capturing = class WebSocket extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        if (protocols === undefined) super(url);
        else super(url, protocols);
        try {
          integration.attach(this, protocols);
        } catch {
          integration.gap(DependencyGaps.captureFailed, 'connect could not be recorded');
        }
      }

      override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        const c = integration.captured.get(this);
        const before = this.readyState;
        try {
          super.send(data);
        } catch (e) {
          if (c) {
            integration.record(c, 'ws.error', () => ({
              phase: 'send',
              error: { type: (e as { name?: string })?.name ?? 'Error', message: integration.session!.redactor.scrubText(String((e as { message?: string })?.message ?? e)) },
              // The app's own call threw; replay reproduces it from the socket state.
              diagnostic: true,
            }));
          }
          throw e;
        }
        // Only sends on an open socket go out (later ones only grow bufferedAmount, in replay too).
        if (c && before === OPEN) {
          const index = c.sends++;
          integration.record(c, 'ws.send', () => ({ index, payload: integration.payloadFor(data, c, 'send') }));
        }
      }

      override close(code?: number, reason?: string): void {
        const c = integration.captured.get(this);
        const before = this.readyState;
        if (code === undefined && reason === undefined) super.close();
        else if (reason === undefined) super.close(code);
        else super.close(code, reason);
        if (c && (before === CONNECTING || before === OPEN)) {
          c.clientClosed = true;
          integration.record(c, 'ws.close', () => ({
            initiator: 'client',
            ...(code !== undefined ? { code } : {}),
            ...(reason ? { reason: integration.session!.redactor.scrubText(String(reason)) } : {}),
          }));
        }
      }
    };
    return Capturing as unknown as typeof WebSocket;
  }

  private attach(socket: WebSocket, protocols: string | string[] | undefined): void {
    const session = this.session;
    if (!session || !session.isRecording) return;
    const now = session.now();
    if (session.adapterDisabled?.(WEBSOCKET_ADAPTER_ID)) {
      this.disabledHits.push(now);
      return;
    }
    if (this.open.size >= this.limits.maxActive) {
      this.stats.gap(DependencyGaps.connectionsLimit, `more than ${this.limits.maxActive} sockets open at once`);
      this.limitHits.push(now);
      return;
    }
    const { url, key } = this.keyFor(socket.url);
    const c: Captured = { conn: `ws${++this.nextConn}`, url, key, sends: 0, messages: 0, opened: false, clientClosed: false, closed: false };
    this.captured.set(socket, c);
    this.open.add(c);
    const occurrence = this.occurrences.next(key);
    const attempt = this.reconnects.get(key) ?? 0;
    const list = protocols === undefined ? [] : typeof protocols === 'string' ? [protocols] : [...protocols];
    this.record(c, 'ws.connect', () => ({ url, key, occurrence, attempt, ...(list.length ? { protocols: list } : {}) }));
    const opts = { capture: false } as const;
    socket.addEventListener(
      'open',
      () => {
        c.opened = true;
        this.record(c, 'ws.open', () => ({ ...(socket.protocol ? { protocol: socket.protocol } : {}), ...(socket.extensions ? { extensions: socket.extensions } : {}) }));
      },
      opts,
    );
    socket.addEventListener(
      'message',
      (e: MessageEvent) => {
        const index = c.messages++;
        this.record(c, 'ws.message', () => ({ index, payload: this.payloadFor(e.data, c, 'message') }));
      },
      opts,
    );
    socket.addEventListener('error', () => this.record(c, 'ws.error', () => ({ phase: c.opened ? 'stream' : 'connect', error: { type: 'Event', message: 'WebSocket error' } })), opts);
    socket.addEventListener(
      'close',
      (e: CloseEvent) => {
        if (c.closed) return;
        c.closed = true;
        this.open.delete(c);
        this.reconnects.set(c.key, (this.reconnects.get(c.key) ?? 0) + 1);
        this.record(c, 'ws.close', () => ({
          initiator: !c.clientClosed && e.wasClean ? 'server' : 'unknown',
          code: e.code,
          ...(e.reason ? { reason: session.redactor.scrubText(e.reason) } : {}),
          wasClean: e.wasClean,
        }));
      },
      opts,
    );
  }

  // ---------------------------------------------------- capsule (writer)

  ownsEvent(e: CapsuleEvent): boolean {
    return e.type.startsWith('ws.') && e.data.dep === DEP;
  }

  openInteractions(): { dep: string; type: string; id: string; restorable: boolean }[] {
    if (!this.capturing) return [];
    return [...this.open].map((c) => ({ dep: DEP, type: 'ws', id: c.conn, restorable: false }));
  }

  private windowGaps(window: RecordedWindow, events: CapsuleEvent[]): DependencyGap[] {
    const since = window.checkpoint.t;
    const counts = new Map<string, number>();
    const add = (code: string, n = 1) => n > 0 && counts.set(code, (counts.get(code) ?? 0) + n);
    for (const e of events) {
      const raw = e.data.payload;
      const p = parsePayload(raw);
      if (!p) continue;
      if (p.mode === 'truncated') add(DependencyGaps.payloadTruncated);
      else if (p.mode === 'redacted') add(DependencyGaps.payloadRedacted);
      else if (p.mode === 'omitted') add(DependencyGaps.captureFailed);
      else if (p.mode === 'metadata') add(typeof raw === 'object' && raw !== null && this.dropped.has(raw) ? DependencyGaps.payloadDropped : p.kind === 'binary' ? DependencyGaps.payloadBinaryMetadata : DependencyGaps.payloadDropped);
    }
    add(DependencyGaps.connectionsLimit, this.limitHits.filter((t) => t >= since).length);
    add(DependencyGaps.captureFailed, this.failures.filter((t) => t >= since).length);
    const details: Record<string, string> = {
      [DependencyGaps.payloadBinaryMetadata]: 'binary frames recorded as metadata; set webSocketIntegration({ binary }) to keep them',
      [DependencyGaps.payloadTruncated]: `frames over ${this.limits.maxPayloadBytes} bytes`,
      [DependencyGaps.payloadDropped]: 'capsule payload budget spent',
      [DependencyGaps.payloadRedacted]: 'frames changed by redaction are not replayable',
      [DependencyGaps.connectionsLimit]: `more than ${this.limits.maxActive} sockets open at once were not captured`,
    };
    return [...counts].map(([code, count]) => (details[code] ? { code, count, detail: details[code] } : { code, count }));
  }

  describeDependencies(window: RecordedWindow): CapsuleDependency[] {
    const events = window.events.filter((e) => this.ownsEvent(e));
    if (events.length === 0) return [];
    const gaps = this.windowGaps(window, events);
    const operations = new Set<string>();
    let payloadBytes = 0;
    let dropped = 0;
    let truncated = 0;
    for (const e of events) {
      if (e.type === 'ws.connect') operations.add('connect');
      if (e.type === 'ws.send') operations.add('send');
      if (e.type === 'ws.close' && e.data.initiator === 'client') operations.add('close');
      const raw = e.data.payload;
      const p = parsePayload(raw);
      if (!p) continue;
      if (p.value !== undefined) payloadBytes += (JSON.stringify(p.value) ?? '').length;
      if (p.mode === 'truncated') truncated++;
      if (p.mode === 'metadata' && typeof raw === 'object' && raw !== null && this.dropped.has(raw)) dropped++;
    }
    return [
      {
        id: DEP,
        kind: DependencyKinds.websocket,
        adapter: WEBSOCKET_ADAPTER_ID,
        adapterVersion: SDK_VERSION,
        schema: WEBSOCKET_ADAPTER_SCHEMA,
        required: true,
        coverage: gaps.length > 0 ? 'partial' : 'complete',
        operations: ['connect', 'send', 'close'].filter((o) => operations.has(o)),
        tested: WEBSOCKET_TESTED_BROWSERS.map((t) => ({ ...t })),
        ...(gaps.length > 0 ? { gaps } : {}),
        stats: { events: events.length, payloadBytes, dropped, truncated },
      },
    ];
  }

  describeEligibility(eligibility: EligibilityBuilder, window: RecordedWindow): void {
    const events = window.events.filter((e) => this.ownsEvent(e));
    const since = window.checkpoint.t;
    if (events.length > 0) {
      const gaps = this.windowGaps(window, events);
      if (gaps.length > 0) eligibility.missing(`dependency.${DEP}`, `WebSocket capture is partial: ${gaps.map((g) => `${g.code}×${g.count ?? 1}`).join(', ')}`);
    }
    if (this.disabledHits.some((t) => t >= since) || (this.nextConn > 0 && this.session?.adapterDisabled?.(WEBSOCKET_ADAPTER_ID))) {
      eligibility.missing(`dependency.${DEP}`, 'WebSocket capture was switched off remotely (disabledAdapters); sockets opened meanwhile are not in the capsule');
    }
    const open = (window.checkpoint.data.interactions as { open?: { dep?: string }[] } | undefined)?.open ?? [];
    const unrestorable = open.filter((o) => o.dep === DEP).length;
    if (unrestorable > 0) {
      eligibility.missing('interactions.restore', `${unrestorable} WebSocket connection(s) open at the periodic checkpoint cannot be restored`, true);
    }
  }
}

// ------------------------------------------------------------------ replay

/** Per fake socket: the recorded connection it was matched to. */
interface Connection {
  socket: ReplayWebSocketLike;
  url: string;
  key: string;
  scope: string | null;
  sends: number;
}

/** What the driver needs from a fake socket (see {@link createReplayWebSocket}). */
interface ReplayWebSocketLike {
  readonly binaryType: BinaryType;
  readonly readyState: number;
  /** Internal: state changes and event dispatch. */
  _setState(state: number, protocol?: string, extensions?: string): void;
  _dispatch(type: 'open' | 'message' | 'error' | 'close', init?: Record<string, unknown>): void;
}

/** Matches fake sockets to the recording and delivers recorded events (capsule-v2 §5). */
class ReplayDriver {
  private readonly encoder: PayloadEncoder;
  private readonly dep: string;
  private readonly connections = new WeakMap<object, Connection>();

  constructor(
    readonly integration: WebSocketIntegration,
    readonly replay: ReplayContext,
    private readonly session: BugCapsuleSession,
  ) {
    // Sends are compared with what capture would have recorded; the replay budget never runs out.
    this.encoder = new PayloadEncoder({
      redactor: () => session.redactor,
      budget: new PayloadBudget({ ...DEFAULT_INTERACTION_LIMITS, maxPayloadBytes: integration.maxPayloadBytes, maxWindowPayloadBytes: Number.MAX_SAFE_INTEGER }),
      stats: new DependencyStats(),
      now: () => 0,
      redactedReplayable: true,
    });
    this.dep = replay.capsule.manifest.dependencies?.find((d) => d.adapter === WEBSOCKET_ADAPTER_ID)?.id ?? DEP;
  }

  connect(socket: ReplayWebSocketLike, href: string, protocols: string[]): void {
    const { url, key } = this.integration.keyFor(href);
    const conn: Connection = { socket, url, key, scope: null, sends: 0 };
    this.connections.set(socket, conn);
    const r = this.replay.interactions.take(this.dep, 'ws.connect', key);
    if (!r) {
      this.replay.diverge('ws.unrecorded', `ws.connect ${key}`);
      this.fail(conn);
      return;
    }
    conn.scope = r.scope;
    const recorded = Array.isArray(r.data.protocols) ? (r.data.protocols as unknown[]).map(String) : [];
    if (recorded.join(',') !== protocols.join(',')) {
      this.replay.diverge('ws.mismatch', `${r.scope} ws.connect protocols [${protocols.join(', ')}], recorded [${recorded.join(', ')}]`);
    }
    this.replay.interactions.bind(r.scope, (event) => this.deliver(conn, event));
    this.replay.activity();
    this.replay.interactionsChanged();
  }

  send(socket: ReplayWebSocketLike, data: unknown): void {
    const conn = this.connections.get(socket);
    if (!conn) return;
    const index = conn.sends++;
    if (conn.scope === null) return;
    const r = this.replay.interactions.takeNext(conn.scope, ['ws.send']);
    this.replay.activity();
    if (!r) {
      this.replay.diverge('ws.unrecorded', `${conn.scope} ws.send #${index}`);
      this.fail(conn);
      return;
    }
    const actual = this.integration.framePayload(data, { direction: 'send', url: conn.url }, this.encoder);
    const recorded = r.payload('payload');
    if (recorded && !samePayload(recorded, actual)) {
      this.replay.diverge('ws.mismatch', `${conn.scope} ws.send #${index}: ${describePayload(actual)}, recorded ${describePayload(recorded)}`);
    }
    this.replay.interactionsChanged();
  }

  close(socket: ReplayWebSocketLike, code: number | undefined, reason: string | undefined): void {
    const conn = this.connections.get(socket);
    if (!conn || conn.scope === null) return; // an unmatched connection is already failing
    const r = this.replay.interactions.takeNext(conn.scope, ['ws.close']);
    this.replay.activity();
    if (!r) {
      this.replay.diverge('ws.unrecorded', `${conn.scope} ws.close`);
      const scope = conn.scope;
      setTimeout(() => {
        if (socket.readyState === CLOSED) return;
        socket._setState(CLOSED);
        this.replay.interactions.unbind(scope);
        socket._dispatch('close', { code: code ?? 1005, reason: reason ?? '', wasClean: true });
      }, 0);
      return;
    }
    const rc = typeof r.data.code === 'number' ? r.data.code : undefined;
    const rr = typeof r.data.reason === 'string' ? r.data.reason : '';
    const actualReason = reason ? this.session.redactor.scrubText(reason) : '';
    if (rc !== code || rr !== actualReason) {
      this.replay.diverge('ws.mismatch', `${conn.scope} ws.close ${code ?? '-'} "${actualReason}", recorded ${rc ?? '-'} "${rr}"`);
    }
    this.replay.interactionsChanged();
  }

  /** Error then close 1006, as a browser fails a connection; nothing reaches the network. */
  private fail(conn: Connection): void {
    const socket = conn.socket;
    if (conn.scope !== null) this.replay.interactions.unbind(conn.scope);
    setTimeout(() => {
      if (socket.readyState === CLOSED) return;
      socket._setState(CLOSED);
      socket._dispatch('error');
      socket._dispatch('close', { code: 1006, reason: '', wasClean: false });
    }, 0);
  }

  private deliver(conn: Connection, r: RecordedInteraction): void {
    const socket = conn.socket;
    this.replay.activity();
    switch (r.type) {
      case 'ws.open':
        if (socket.readyState !== CONNECTING) return;
        socket._setState(OPEN, typeof r.data.protocol === 'string' ? r.data.protocol : '', typeof r.data.extensions === 'string' ? r.data.extensions : '');
        socket._dispatch('open');
        return;
      case 'ws.message': {
        if (socket.readyState !== OPEN) return;
        const data = this.messageData(conn, r);
        if (data === undefined) return;
        let origin = '';
        try {
          origin = new URL(conn.url).origin;
        } catch {
          origin = '';
        }
        socket._dispatch('message', { data, origin });
        return;
      }
      case 'ws.error':
        if (socket.readyState === CLOSED) return;
        socket._dispatch('error');
        return;
      case 'ws.close': {
        if (socket.readyState === CLOSED) return;
        socket._setState(CLOSED);
        if (conn.scope !== null) this.replay.interactions.unbind(conn.scope);
        const code = typeof r.data.code === 'number' ? r.data.code : 1005;
        const wasClean = typeof r.data.wasClean === 'boolean' ? r.data.wasClean : code !== 1006;
        socket._dispatch('close', { code, reason: typeof r.data.reason === 'string' ? r.data.reason : '', wasClean });
        return;
      }
    }
  }

  /** The `data` of a recorded message, or undefined (reported) when it cannot be served. */
  private messageData(conn: Connection, r: RecordedInteraction): unknown {
    const p = r.payload('payload');
    const what = `${r.scope} ws.message #${String(r.data.index)}`;
    if (!p || !p.replayable) {
      this.replay.diverge('ws.noPayload', `${what}: ${p ? describePayload(p) : 'no payload'}`);
      return undefined;
    }
    if (p.kind !== 'binary') {
      if (typeof p.value === 'string') return p.value;
      this.replay.diverge('ws.noPayload', `${what}: text frame without a string value`);
      return undefined;
    }
    let bytes: Uint8Array | null;
    try {
      bytes = this.integration.frameBytes(p, { direction: 'message', url: conn.url });
    } catch (e) {
      this.replay.diverge('ws.noPayload', `${what}: binary serializer threw (${String(e)})`);
      return undefined;
    }
    if (!bytes) {
      this.replay.diverge('ws.noPayload', `${what}: no binary serializer for this recording`);
      return undefined;
    }
    const copy = bytes.slice();
    return conn.socket.binaryType === 'arraybuffer' ? copy.buffer : new Blob([copy as BlobPart]);
  }
}

function describePayload(p: InteractionPayload): string {
  return `${p.kind ?? 'value'} ${p.mode}${p.bytes !== undefined ? ` ${p.bytes} B` : ''}`;
}

function domException(message: string, name: string): Error {
  return typeof DOMException === 'function' ? new DOMException(message, name) : Object.assign(new Error(message), { name });
}

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * The replay `WebSocket`: the browser API surface (readyState transitions,
 * `on*` handlers and listeners, `binaryType`, `bufferedAmount`, `protocol`,
 * `extensions`, `send`/`close` validation) over the recording. It never
 * opens a network connection.
 */
function createReplayWebSocket(driver: ReplayDriver): typeof WebSocket {
  const handlerTypes = ['open', 'message', 'error', 'close'] as const;
  type HandlerType = (typeof handlerTypes)[number];

  class WebSocket extends EventTarget implements ReplayWebSocketLike {
    static readonly CONNECTING = CONNECTING;
    static readonly OPEN = OPEN;
    static readonly CLOSING = CLOSING;
    static readonly CLOSED = CLOSED;
    declare readonly CONNECTING: 0;
    declare readonly OPEN: 1;
    declare readonly CLOSING: 2;
    declare readonly CLOSED: 3;

    #url: string;
    #state = CONNECTING;
    #protocol = '';
    #extensions = '';
    #binaryType: BinaryType = 'blob';
    #buffered = 0;
    #handlers = new Map<HandlerType, { fn: unknown; listener: (e: Event) => void }>();

    constructor(url: string | URL, protocols: string | string[] = []) {
      super();
      let parsed: URL;
      try {
        parsed = new URL(String(url), globalThis.document?.baseURI ?? globalThis.location?.href);
      } catch {
        throw domException(`Failed to construct 'WebSocket': The URL '${String(url)}' is invalid.`, 'SyntaxError');
      }
      if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
      else if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
      if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
        throw domException(`Failed to construct 'WebSocket': The URL's scheme must be either 'http', 'https', 'ws', or 'wss'. '${parsed.protocol.slice(0, -1)}' is not allowed.`, 'SyntaxError');
      }
      if (parsed.hash) {
        throw domException(`Failed to construct 'WebSocket': The URL contains a fragment identifier ('${parsed.hash.slice(1)}'). Fragment identifiers are not allowed in WebSocket URLs.`, 'SyntaxError');
      }
      const list = typeof protocols === 'string' ? [protocols] : [...protocols].map(String);
      if (new Set(list).size !== list.length || list.some((p) => !TOKEN.test(p))) {
        throw domException(`Failed to construct 'WebSocket': The subprotocol '${list.join(', ')}' is invalid.`, 'SyntaxError');
      }
      this.#url = parsed.href;
      driver.connect(this, this.#url, list);
    }

    get url(): string {
      return this.#url;
    }
    get readyState(): number {
      return this.#state;
    }
    get bufferedAmount(): number {
      return this.#buffered;
    }
    get protocol(): string {
      return this.#protocol;
    }
    get extensions(): string {
      return this.#extensions;
    }
    get binaryType(): BinaryType {
      return this.#binaryType;
    }
    set binaryType(v: BinaryType) {
      if (v === 'blob' || v === 'arraybuffer') this.#binaryType = v;
    }

    get onopen(): unknown {
      return this.#handler('open');
    }
    set onopen(fn: unknown) {
      this.#setHandler('open', fn);
    }
    get onmessage(): unknown {
      return this.#handler('message');
    }
    set onmessage(fn: unknown) {
      this.#setHandler('message', fn);
    }
    get onerror(): unknown {
      return this.#handler('error');
    }
    set onerror(fn: unknown) {
      this.#setHandler('error', fn);
    }
    get onclose(): unknown {
      return this.#handler('close');
    }
    set onclose(fn: unknown) {
      this.#setHandler('close', fn);
    }

    #handler(type: HandlerType): unknown {
      return this.#handlers.get(type)?.fn ?? null;
    }

    /** Event handler attributes keep their listener position until set to null (HTML §8.1.8). */
    #setHandler(type: HandlerType, fn: unknown): void {
      const value = typeof fn === 'function' || (typeof fn === 'object' && fn !== null) ? fn : null;
      const existing = this.#handlers.get(type);
      if (value === null) {
        if (existing) this.removeEventListener(type, existing.listener);
        this.#handlers.delete(type);
        return;
      }
      if (existing) {
        existing.fn = value;
        return;
      }
      const entry = {
        fn: value,
        listener: (e: Event) => {
          const f = entry.fn;
          if (typeof f === 'function') (f as (this: unknown, e: Event) => unknown).call(this, e);
        },
      };
      this.#handlers.set(type, entry);
      this.addEventListener(type, entry.listener);
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      if (this.#state === CONNECTING) {
        throw domException("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", 'InvalidStateError');
      }
      const payload = normalizeFrame(data);
      if (this.#state !== OPEN) {
        // Like a browser: data sent after close only grows bufferedAmount.
        this.#buffered += frameSize(payload);
        return;
      }
      driver.send(this, payload);
    }

    close(code?: number, reason?: string): void {
      if (code !== undefined && code !== 1000 && !(code >= 3000 && code <= 4999)) {
        throw domException(`Failed to execute 'close' on 'WebSocket': The close code must be either 1000, or between 3000 and 4999. ${code} is neither.`, 'InvalidAccessError');
      }
      if (reason !== undefined && new TextEncoder().encode(String(reason)).length > 123) {
        throw domException("Failed to execute 'close' on 'WebSocket': The close reason must not be greater than 123 UTF-8 bytes.", 'SyntaxError');
      }
      if (this.#state === CLOSING || this.#state === CLOSED) return;
      this.#state = CLOSING;
      driver.close(this, code, reason === undefined ? undefined : String(reason));
    }

    _setState(state: number, protocol?: string, extensions?: string): void {
      this.#state = state;
      if (protocol !== undefined) this.#protocol = protocol;
      if (extensions !== undefined) this.#extensions = extensions;
    }

    _dispatch(type: HandlerType, init: Record<string, unknown> = {}): void {
      this.dispatchEvent(makeEvent(type, init));
    }

    get [Symbol.toStringTag](): string {
      return 'WebSocket';
    }
  }
  for (const target of [WebSocket.prototype]) {
    Object.defineProperties(target, {
      CONNECTING: { value: CONNECTING, enumerable: true },
      OPEN: { value: OPEN, enumerable: true },
      CLOSING: { value: CLOSING, enumerable: true },
      CLOSED: { value: CLOSED, enumerable: true },
    });
  }
  return WebSocket as unknown as typeof globalThis.WebSocket;
}

function makeEvent(type: string, init: Record<string, unknown>): Event {
  if (type === 'message' && typeof MessageEvent === 'function') return new MessageEvent('message', { data: init.data, origin: (init.origin as string) ?? '' });
  if (type === 'close' && typeof CloseEvent === 'function') {
    return new CloseEvent('close', { code: init.code as number, reason: init.reason as string, wasClean: init.wasClean as boolean });
  }
  const e = new Event(type);
  for (const [k, value] of Object.entries(init)) Object.defineProperty(e, k, { value, enumerable: true });
  return e;
}

/** WebSocket capture and offline replay (opt-in; see {@link WebSocketIntegration}). */
export function webSocketIntegration(options: WebSocketOptions = {}): WebSocketIntegration {
  return new WebSocketIntegration(options);
}
