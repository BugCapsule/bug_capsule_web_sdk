import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { BugCapsule } from '../../packages/web/src/bugcapsule.js';
import { decodeCapsuleJson, evaluateRun, validateCapsuleDocument, type ReplayReport } from '../../packages/web/src/core/index.js';
import { networkIntegration } from '../../packages/web/src/integrations/network.js';
import { rawBinarySerializer, webSocketIntegration, WEBSOCKET_ADAPTER_ID, type WebSocketOptions } from '../../packages/web/src/integrations/websocket.js';
import { parseRemoteConfig, type BugCapsuleTransport } from '../../packages/web/src/remote-config.js';
import { MemoryStorage } from '../../packages/web/src/storage/idb.js';
import type { BugCapsuleConfig, UploadResult } from '../../packages/web/src/types.js';

/**
 * The browser `WebSocket` the SDK wraps, with a scripted server. Capture
 * subclasses it; replay must never construct one.
 */
class MockSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockSocket[] = [];
  static server: { connect?(s: MockSocket): void; message?(s: MockSocket, data: unknown): void } = {};
  readonly url: string;
  protocol = '';
  extensions = '';
  readyState = 0;
  binaryType: BinaryType = 'blob';
  bufferedAmount = 0;
  readonly sent: unknown[] = [];
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;

  constructor(url: string | URL, readonly protocols?: string | string[]) {
    super();
    this.url = new URL(String(url)).href;
    MockSocket.instances.push(this);
    queueMicrotask(() => MockSocket.server.connect?.(this));
  }

  send(data: unknown): void {
    if (this.readyState === 0) throw new DOMException("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", 'InvalidStateError');
    if (this.readyState !== 1) return;
    this.sent.push(data);
    MockSocket.server.message?.(this, data);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    setTimeout(() => this.finish(code ?? 1005, reason ?? '', true), 5);
  }

  private fire(type: string, e: Event): void {
    this.dispatchEvent(e);
    const h = (this as unknown as Record<string, ((e: Event) => void) | null>)[`on${type}`];
    h?.call(this, e);
  }

  // server side
  accept(protocol = ''): void {
    this.readyState = 1;
    this.protocol = protocol;
    this.fire('open', new Event('open'));
  }
  push(data: unknown): void {
    if (this.readyState !== 1) return;
    this.fire('message', new MessageEvent('message', { data }));
  }
  finish(code: number, reason: string, wasClean: boolean): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.fire('close', new CloseEvent('close', { code, reason, wasClean }));
  }
  fail(): void {
    this.fire('error', new Event('error'));
    this.finish(1006, '', false);
  }
}

class Transport implements BugCapsuleTransport {
  capsules: Record<string, any>[] = [];
  config: Record<string, unknown> = { enabled: true, sampleRate: 1 };
  async fetchConfig() {
    return { ok: true as const, config: parseRemoteConfig(this.config, Date.now()) };
  }
  async upload(bytes: Uint8Array): Promise<UploadResult> {
    this.capsules.push(JSON.parse(gunzipSync(bytes).toString('utf8')));
    return { status: 'uploaded', serverId: 's' };
  }
}

const realWebSocket = globalThis.WebSocket;
const realFetch = globalThis.fetch;
afterEach(async () => {
  await BugCapsule.resetForTest();
  BugCapsule.setTestOverrides(undefined);
  globalThis.WebSocket = realWebSocket;
  globalThis.fetch = realFetch;
  MockSocket.instances = [];
  MockSocket.server = {};
});

const until = async (cond: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const base: BugCapsuleConfig = { appVersion: '1.0.0', appBuild: '7', mode: 'qa', gitSha: 'abc', monitoring: false };

async function capture(t: Transport, options: WebSocketOptions = {}, extra: Partial<BugCapsuleConfig> = {}) {
  globalThis.WebSocket = MockSocket as unknown as typeof WebSocket;
  BugCapsule.setTestOverrides({ storage: new MemoryStorage(), transport: t, random: () => 0.01, bridge: null });
  await BugCapsule.init({ ...base, integrations: [webSocketIntegration(options)], ...extra });
  await sleep(5); // the session anchor
}

interface Replayed {
  reports: ReplayReport[];
}

async function replay(capsule: unknown, integrations = [webSocketIntegration()], settings: Record<string, unknown> = {}): Promise<Replayed> {
  globalThis.WebSocket = MockSocket as unknown as typeof WebSocket;
  MockSocket.instances = [];
  const out: Replayed = { reports: [] };
  BugCapsule.setTestOverrides({
    storage: new MemoryStorage(),
    random: () => 0.01,
    bridge: {
      load: async () => ({ capsule, settings: { strategy: 'semantic', settleTimeoutMs: 400, attempt: 1, kind: 'replay', strictNetwork: true, idleCompression: true, ...settings } }),
      pointer: async () => {},
      report: async (r) => void out.reports.push(r),
    },
  });
  await BugCapsule.init({ ...base, allowReplay: true, integrations });
  return out;
}

/**
 * The quotes app: two sockets to the same URL, the same subscribe frame on
 * each, and a bug that depends on the order quotes arrive in.
 */
function quotesApp(fixed = false): { log: string[] } {
  const state = { log: [] as string[] };
  const open = (name: string) => {
    const ws = new WebSocket('wss://quotes.example.com/v1/stream?token=abc123&ts=1');
    ws.onopen = () => ws.send(JSON.stringify({ op: 'subscribe', symbol: 'ACME' }));
    ws.onmessage = (e) => {
      state.log.push(`${name}:${String(e.data)}`);
      if (state.log.length === 3) {
        // Bug: assumes the first quote comes from socket a.
        if (!fixed && !state.log[0]!.startsWith('a:')) BugCapsule.fail('quotes.order', state.log.join(' '));
        ws.close(1000, 'done');
      }
    };
  };
  open('a');
  open('b');
  return state;
}

/** Server for {@link quotesApp}: answers on b first, then a, b and a twice in the same millisecond. */
function quotesServer(): void {
  MockSocket.server = {
    connect: (s) => setTimeout(() => s.accept('quotes.v1'), 10),
    message: (s) => {
      if (s !== MockSocket.instances[1]) return;
      // One task: the three frames share a timestamp.
      setTimeout(() => {
        MockSocket.instances[1]!.push('q1');
        MockSocket.instances[0]!.push('q2');
        MockSocket.instances[1]!.push('q3');
      }, 30);
    },
  };
}

describe('WebSocket adapter: capture → capsule → replay', () => {
  it('omits frames when body capture is off', async () => {
    const t = new Transport();
    await capture(t, {}, { captureNetworkBodies: false });
    quotesServer();
    quotesApp();
    await until(() => t.capsules.length === 1);
    const frames = t.capsules[0]!.events.filter((e: any) => e.type === 'ws.send' || e.type === 'ws.message');
    assert.ok(frames.length > 0);
    for (const f of frames) {
      assert.equal(f.data.payload.mode, 'omitted');
      assert.equal(f.data.payload.replayable, false);
      assert.equal('value' in f.data.payload, false);
    }
  });

  it('replays a race on concurrent identical sockets in recorded order, without the network', async () => {
    const t = new Transport();
    await capture(t);
    quotesServer();
    const captured = quotesApp();
    await until(() => t.capsules.length === 1);
    assert.deepEqual(captured.log, ['b:q1', 'a:q2', 'b:q3']);
    const doc = t.capsules[0]!;

    // capsule-v2 writer: dependency entry, spec v2, valid for v2 readers.
    assert.equal(doc.specVersion, 2);
    assert.equal(validateCapsuleDocument(doc), null);
    assert.equal(decodeCapsuleJson(new TextEncoder().encode(JSON.stringify(doc))).manifest.dependencies?.[0]?.adapter, WEBSOCKET_ADAPTER_ID);
    const [dep] = doc.manifest.dependencies;
    assert.equal(dep.id, 'ws');
    assert.equal(dep.kind, 'websocket');
    assert.equal(dep.schema, 1);
    assert.equal(dep.required, true);
    assert.equal(dep.coverage, 'complete');
    assert.deepEqual(dep.operations, ['connect', 'send', 'close']);
    assert.ok(dep.tested.some((x: { package: string }) => x.package === 'chromium'));
    assert.equal(dep.stats.events, doc.events.filter((e: { type: string }) => e.type.startsWith('ws.')).length);
    assert.equal(doc.manifest.eligibility.status, 'eligible');

    const ws = doc.events.filter((e: { type: string }) => e.type.startsWith('ws.'));
    const connects = ws.filter((e: any) => e.type === 'ws.connect');
    assert.deepEqual(
      connects.map((e: any) => [e.data.conn, e.data.occurrence, e.data.attempt, e.data.key, e.data.url]),
      [
        ['ws1', 0, 0, 'wss://quotes.example.com/v1/stream?token=[REDACTED]', 'wss://quotes.example.com/v1/stream?token=[REDACTED]&ts=1'],
        ['ws2', 1, 0, 'wss://quotes.example.com/v1/stream?token=[REDACTED]', 'wss://quotes.example.com/v1/stream?token=[REDACTED]&ts=1'],
      ],
    );
    const messages = ws.filter((e: any) => e.type === 'ws.message');
    assert.deepEqual(messages.map((e: any) => [e.data.conn, e.data.index, e.data.payload.value]), [['ws2', 0, 'q1'], ['ws1', 0, 'q2'], ['ws2', 1, 'q3']]);
    assert.equal(new Set(messages.map((e: any) => e.t)).size, 1, 'the three quotes share one timestamp');
    const sends = ws.filter((e: any) => e.type === 'ws.send');
    assert.deepEqual(sends[0].data.payload, { mode: 'full', replayable: true, value: '{"op":"subscribe","symbol":"ACME"}', bytes: 34, kind: 'text' });
    assert.ok(ws.some((e: any) => e.type === 'ws.close' && e.data.initiator === 'client' && e.data.code === 1000));
    assert.ok(ws.some((e: any) => e.type === 'ws.close' && e.data.initiator === 'unknown' && e.data.wasClean === true));
    await BugCapsule.resetForTest();

    // Replay: same app, served from the capsule.
    const r = await replay(doc);
    const replayed = quotesApp();
    await until(() => r.reports.length === 1);
    assert.equal(MockSocket.instances.length, 0, 'replay never opens a real socket');
    const report = r.reports[0]!;
    assert.equal(report.outcome, 'reproduced');
    assert.deepEqual(replayed.log, ['b:q1', 'a:q2', 'b:q3']);
    assert.deepEqual(report.divergences.filter((d) => d.type.startsWith('ws.') && d.type !== 'ws.unusedAfterFailure'), []);
    await BugCapsule.resetForTest();

    // Verify a fix: every recorded interaction is used, nothing material.
    const v = await replay(doc, [webSocketIntegration()], { kind: 'verify' });
    const fixedApp = quotesApp(true);
    await until(() => v.reports.length === 1);
    assert.equal(v.reports[0]!.outcome, 'not_reproduced');
    assert.deepEqual(fixedApp.log, ['b:q1', 'a:q2', 'b:q3']);
    assert.deepEqual(v.reports[0]!.divergences.filter((d) => d.type !== 'build.gitSha'), []);
    assert.equal(evaluateRun('verify', 1, v.reports).verdict, 'fixed');
  });

  it('an unrecorded connect fails like a network error and is reported; nothing reaches the network', async () => {
    const t = new Transport();
    await capture(t);
    quotesServer();
    quotesApp();
    await until(() => t.capsules.length === 1);
    await BugCapsule.resetForTest();

    const r = await replay(t.capsules[0]);
    quotesApp();
    const seen: string[] = [];
    const other = new WebSocket('wss://other.example.com/feed');
    other.onerror = () => seen.push(`error:${other.readyState}`);
    other.onclose = (e) => seen.push(`close:${e.code}:${e.wasClean}`);
    assert.throws(() => other.send('x'), { name: 'InvalidStateError' });
    await until(() => r.reports.length === 1);
    assert.deepEqual(seen, ['error:3', 'close:1006:false']);
    assert.equal(MockSocket.instances.length, 0);
    assert.deepEqual(
      r.reports[0]!.divergences.filter((d) => d.type === 'ws.unrecorded').map((d) => d.detail),
      ['ws.connect wss://other.example.com/feed'],
    );
  });

  it('a capsule without any WebSocket recording never reaches the network, with or without the adapter', async () => {
    const t = new Transport();
    await capture(t, {}, { integrations: [] });
    BugCapsule.fail('no.sockets');
    await until(() => t.capsules.length === 1);
    assert.equal(t.capsules[0]!.specVersion, 1);
    await BugCapsule.resetForTest();

    for (const integrations of [[webSocketIntegration()], []]) {
      const r = await replay(t.capsules[0], integrations);
      const ws = new WebSocket('wss://quotes.example.com/v1/stream');
      const closed = new Promise<number>((resolve) => (ws.onclose = (e) => resolve(e.code)));
      assert.equal(await closed, 1006);
      BugCapsule.fail('no.sockets');
      await until(() => r.reports.length === 1);
      assert.equal(MockSocket.instances.length, 0);
      assert.deepEqual(r.reports[0]!.divergences.filter((d) => d.type.startsWith('ws.')).map((d) => d.type), ['ws.unrecorded']);
      await BugCapsule.resetForTest();
      assert.equal(globalThis.WebSocket, MockSocket, 'the page WebSocket is restored on dispose');
    }
  });

  it('a different send is a mismatch; a send the recording never saw is unrecorded', async () => {
    const t = new Transport();
    await capture(t);
    quotesServer();
    quotesApp();
    await until(() => t.capsules.length === 1);
    await BugCapsule.resetForTest();

    const r = await replay(t.capsules[0], [webSocketIntegration()], { kind: 'verify' });
    const ws = [0, 1].map(() => new WebSocket('wss://quotes.example.com/v1/stream?token=xyz&ts=2'));
    ws[0]!.onopen = () => ws[0]!.send(JSON.stringify({ op: 'subscribe', symbol: 'OTHER' }));
    ws[1]!.onopen = () => {
      ws[1]!.send(JSON.stringify({ op: 'subscribe', symbol: 'ACME' }));
      ws[1]!.send('extra');
    };
    await until(() => r.reports.length === 1);
    const d = r.reports[0]!.divergences;
    assert.deepEqual(d.filter((x) => x.type === 'ws.mismatch').map((x) => x.detail), ['ws:ws1 ws.send #0: text full 35 B, recorded text full 34 B']);
    assert.deepEqual(d.filter((x) => x.type === 'ws.unrecorded').map((x) => x.detail), ['ws:ws2 ws.send #1']);
    assert.equal(evaluateRun('verify', 1, r.reports).verdict, 'inconclusive');
    assert.ok(evaluateRun('verify', 1, r.reports).reasonCodes.includes('interaction.mismatch'));
  });

  it('binary frames are metadata without a serializer (replay reports ws.noPayload) and bytes with one', async () => {
    const run = async (options: WebSocketOptions) => {
      const t = new Transport();
      await capture(t, options);
      MockSocket.server = { connect: (s) => setTimeout(() => s.accept(), 5), message: (s) => setTimeout(() => s.push(new Uint8Array([1, 2, 3, 250]).buffer), 5) };
      const got: unknown[] = [];
      const ws = new WebSocket('wss://bin.example.com/');
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => ws.send(new Uint8Array([9, 9]));
      ws.onmessage = (e) => {
        got.push([...new Uint8Array(e.data as ArrayBuffer)]);
        BugCapsule.fail('binary.seen');
      };
      await until(() => t.capsules.length === 1);
      assert.deepEqual(got, [[1, 2, 3, 250]]);
      await BugCapsule.resetForTest();
      return t.capsules[0]!;
    };

    const meta = await run({});
    const frames = meta.events.filter((e: any) => e.type === 'ws.send' || e.type === 'ws.message').map((e: any) => e.data.payload);
    assert.deepEqual(frames, [
      { mode: 'metadata', replayable: false, bytes: 2, kind: 'binary' },
      { mode: 'metadata', replayable: false, bytes: 4, kind: 'binary' },
    ]);
    const dep = meta.manifest.dependencies[0];
    assert.equal(dep.coverage, 'partial');
    assert.deepEqual(dep.gaps.map((g: any) => [g.code, g.count]), [['payload.binaryMetadata', 2]]);
    assert.equal(meta.manifest.eligibility.status, 'partial');
    assert.ok(meta.manifest.eligibility.missing.some((m: any) => m.dependency === 'dependency.ws'));

    let r = await replay(meta);
    const got: unknown[] = [];
    let ws = new WebSocket('wss://bin.example.com/');
    ws.onopen = () => ws.send(new Uint8Array([9, 9]));
    ws.onmessage = (e) => got.push(e.data);
    await until(() => r.reports.length === 1);
    assert.deepEqual(got, []);
    assert.equal(r.reports[0]!.outcome, 'not_reproduced');
    assert.deepEqual(r.reports[0]!.divergences.filter((d) => d.type.startsWith('ws.')).map((d) => d.type), ['ws.noPayload']);
    assert.ok(evaluateRun('verify', 1, r.reports).reasonCodes.includes('interaction.incomplete'));
    await BugCapsule.resetForTest();

    const raw = await run({ binary: rawBinarySerializer });
    assert.deepEqual(raw.events.find((e: any) => e.type === 'ws.message').data.payload, { mode: 'full', replayable: true, value: { $t: 'bytes', b64: 'AQID+g==' }, bytes: 4, kind: 'binary' });
    assert.equal(raw.manifest.dependencies[0].coverage, 'complete');
    r = await replay(raw, [webSocketIntegration({ binary: rawBinarySerializer })]);
    const bytes: number[][] = [];
    ws = new WebSocket('wss://bin.example.com/');
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => ws.send(new Uint8Array([9, 9]));
    ws.onmessage = (e) => {
      bytes.push([...new Uint8Array(e.data as ArrayBuffer)]);
      BugCapsule.fail('binary.seen');
    };
    await until(() => r.reports.length === 1);
    assert.equal(r.reports[0]!.outcome, 'reproduced');
    assert.deepEqual(bytes, [[1, 2, 3, 250]]);
  });

  it('text frames are redacted before they are recorded', async () => {
    const t = new Transport();
    await capture(t);
    MockSocket.server = { connect: (s) => setTimeout(() => s.accept(), 5) };
    const ws = new WebSocket('wss://chat.example.com/');
    ws.onopen = () => {
      ws.send(JSON.stringify({ op: 'auth', token: 'abc123' }));
      BugCapsule.fail('chat.auth');
    };
    await until(() => t.capsules.length === 1);
    const send = t.capsules[0]!.events.find((e: any) => e.type === 'ws.send');
    assert.deepEqual(send.data.payload, { mode: 'redacted', replayable: false, value: '{"op":"auth","token":"[REDACTED]"}', bytes: 30, kind: 'text' });
    assert.ok(t.capsules[0]!.manifest.dependencies[0].gaps.some((g: any) => g.code === 'payload.redacted'));
  });

  it('remote kill switch: disabledAdapters stops WebSocket capture and keeps HTTP capture', async () => {
    const t = new Transport();
    t.config = { enabled: true, sampleRate: 1, disabledAdapters: [WEBSOCKET_ADAPTER_ID] };
    globalThis.fetch = (async () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })) as typeof fetch;
    await capture(t, {}, { integrations: [webSocketIntegration(), networkIntegration()] });
    await BugCapsule.refreshRemoteConfig();
    quotesServer();
    quotesApp();
    await fetch('https://api.example.com/quote');
    await until(() => t.capsules.length === 1);
    const doc = t.capsules[0]!;
    assert.equal(doc.specVersion, 1);
    assert.equal(doc.manifest.dependencies, undefined);
    assert.deepEqual(doc.events.filter((e: any) => e.type.startsWith('ws.')), []);
    assert.equal(doc.events.filter((e: any) => e.type === 'http').length, 1);
    assert.ok(doc.manifest.eligibility.missing.some((m: any) => m.dependency === 'dependency.ws' && m.reason.includes('disabledAdapters')));
    assert.equal(MockSocket.instances.length, 2, 'the app still gets real sockets');
  });

  it('remote maxInteractionPayloadBytes lowers the per-frame limit', async () => {
    const t = new Transport();
    t.config = { enabled: true, sampleRate: 1, maxInteractionPayloadBytes: 16 };
    await capture(t);
    await BugCapsule.refreshRemoteConfig();
    quotesServer();
    quotesApp();
    await until(() => t.capsules.length === 1);
    const doc = t.capsules[0]!;
    const sends = doc.events.filter((e: any) => e.type === 'ws.send');
    assert.ok(sends.length > 0);
    for (const s of sends) assert.deepEqual(s.data.payload, { mode: 'truncated', replayable: false, bytes: 34, kind: 'text' });
    const messages = doc.events.filter((e: any) => e.type === 'ws.message');
    assert.deepEqual(messages.map((e: any) => e.data.payload.mode), ['full', 'full', 'full']);
    assert.ok(doc.manifest.dependencies[0].gaps.some((g: any) => g.code === 'payload.truncated'));
    assert.equal(parseRemoteConfig({ maxInteractionPayloadBytes: 1e9 }).maxInteractionPayloadBytes, 64 * 1024);
    assert.equal(parseRemoteConfig({}).maxInteractionPayloadBytes, null);
  });

  it('switching the adapter off mid-session drops buffered WebSocket events only', async () => {
    const t = new Transport();
    globalThis.fetch = (async () => new Response('{}', { headers: { 'content-type': 'application/json' } })) as typeof fetch;
    await capture(t, {}, { integrations: [webSocketIntegration(), networkIntegration()] });
    await BugCapsule.refreshRemoteConfig();
    MockSocket.server = { connect: (s) => s.accept() };
    new WebSocket('wss://a.example.com/');
    await fetch('https://api.example.com/x');
    await sleep(20);
    t.config = { enabled: true, sampleRate: 1, disabledAdapters: [WEBSOCKET_ADAPTER_ID] };
    await BugCapsule.refreshRemoteConfig();
    BugCapsule.fail('after.disable');
    await until(() => t.capsules.length === 1);
    const doc = t.capsules[0]!;
    assert.deepEqual(doc.events.filter((e: any) => e.type.startsWith('ws.')), []);
    assert.equal(doc.events.filter((e: any) => e.type === 'http').length, 1);
    assert.equal(doc.specVersion, 1);
    assert.ok(!doc.manifest.eligibility.missing.some((m: any) => m.dependency === 'events.redaction'));
  });

  it('preflight: a capsule needing an adapter this build lacks ends incompatible before the app runs', async () => {
    const t = new Transport();
    await capture(t);
    quotesServer();
    quotesApp();
    await until(() => t.capsules.length === 1);
    await BugCapsule.resetForTest();

    const r = await replay(t.capsules[0], []);
    await until(() => r.reports.length === 1);
    const report = r.reports[0]!;
    assert.equal(report.outcome, 'incompatible');
    assert.match(report.message ?? '', /^dependency\.unsupported: bugcapsule-web\.websocket schema 1/);
    assert.equal(report.expectedSignature, t.capsules[0]!.manifest.failure.signature);
    const e = evaluateRun('verify', 1, r.reports);
    assert.equal(e.verdict, 'incompatible');
    assert.deepEqual(e.reasonCodes, ['dependency.unsupported']);
    await BugCapsule.resetForTest();

    const schema = structuredClone(t.capsules[0]!);
    schema.manifest.dependencies[0].schema = 2;
    const r2 = await replay(schema);
    await until(() => r2.reports.length === 1);
    assert.match(r2.reports[0]!.message ?? '', /^dependency\.schema: /);
    await BugCapsule.resetForTest();

    const open = structuredClone(t.capsules[0]!);
    open.checkpoint.data.interactions = { open: [{ dep: 'ws', type: 'ws', id: 'ws1', restorable: false }] };
    const r3 = await replay(open);
    await until(() => r3.reports.length === 1);
    assert.match(r3.reports[0]!.message ?? '', /^dependency\.unrestorable: /);
  });

  it('capsules without sockets stay v1; at most maxConnections sockets are captured', async () => {
    const t = new Transport();
    await capture(t, { maxConnections: 1 });
    MockSocket.server = { connect: (s) => s.accept() };
    new WebSocket('wss://a.example.com/');
    new WebSocket('wss://b.example.com/');
    await sleep(20);
    BugCapsule.fail('two.sockets');
    await until(() => t.capsules.length === 1);
    const dep = t.capsules[0]!.manifest.dependencies[0];
    assert.equal(t.capsules[0]!.events.filter((e: any) => e.type === 'ws.connect').length, 1);
    assert.deepEqual(dep.gaps.map((g: any) => [g.code, g.count]), [['connections.limit', 1]]);
    await BugCapsule.resetForTest();

    const t2 = new Transport();
    await capture(t2);
    BugCapsule.fail('no.sockets');
    await until(() => t2.capsules.length === 1);
    assert.equal(t2.capsules[0]!.specVersion, 1);
    assert.equal(t2.capsules[0]!.manifest.dependencies, undefined);
  });
});

describe('WebSocket adapter: replay fake', () => {
  it('implements the browser API surface', async () => {
    const t = new Transport();
    await capture(t);
    MockSocket.server = { connect: (s) => setTimeout(() => s.accept('chat.v2'), 5), message: (s, d) => s.push(`echo ${String(d)}`) };
    const ws = new WebSocket('wss://chat.example.com/room', ['chat.v2', 'chat.v1']);
    ws.onopen = () => ws.send('hi');
    ws.onmessage = () => {
      ws.close(4000, 'bye');
      BugCapsule.fail('chat.done');
    };
    await until(() => t.capsules.length === 1);
    await BugCapsule.resetForTest();

    const r = await replay(t.capsules[0]);
    const WS = globalThis.WebSocket;
    assert.equal(WS.OPEN, 1);
    assert.throws(() => new WS('https://chat.example.com/#x'), { name: 'SyntaxError' });
    assert.throws(() => new WS('ftp://chat.example.com/'), { name: 'SyntaxError' });
    assert.throws(() => new WS('wss://chat.example.com/', ['a', 'a']), { name: 'SyntaxError' });
    const sock = new WS('wss://chat.example.com/room', ['chat.v2', 'chat.v1']);
    assert.ok(sock instanceof WS);
    assert.equal(sock.url, 'wss://chat.example.com/room');
    assert.equal(sock.readyState, WS.CONNECTING);
    assert.equal(sock.binaryType, 'blob');
    sock.binaryType = 'nonsense' as BinaryType;
    assert.equal(sock.binaryType, 'blob');
    const seen: string[] = [];
    sock.addEventListener('open', () => seen.push(`open:${sock.protocol}`));
    sock.onopen = () => {
      seen.push('onopen');
      sock.send('hi');
    };
    sock.onmessage = (e) => {
      seen.push(`message:${String(e.data)}`);
      assert.throws(() => sock.close(1001), { name: 'InvalidAccessError' });
      sock.close(4000, 'bye');
      assert.equal(sock.readyState, WS.CLOSING);
      sock.send('late');
      assert.equal(sock.bufferedAmount, 4);
      BugCapsule.fail('chat.done');
    };
    sock.onclose = (e) => seen.push(`close:${e.code}:${sock.readyState}`);
    await until(() => r.reports.length === 1);
    await until(() => seen.length >= 4);
    assert.deepEqual(seen, ['open:chat.v2', 'onopen', 'message:echo hi', 'close:4000:3']);
    assert.equal(r.reports[0]!.outcome, 'reproduced');
  });
});
