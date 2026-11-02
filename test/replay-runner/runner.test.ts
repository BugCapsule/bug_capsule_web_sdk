import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { after, before, beforeEach, describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';
import { assessAttempt, type ReplayReport } from '../../packages/web/src/core/index.js';
import { isStaticLoad, runReplayAttempt } from '../../packages/web-replay/src/index.js';
import { sdkBundle } from '../browser/harness.js';

/**
 * bugcapsule-web-runner end to end (BC-ENT-015, BC-ENT-013): a tiny app served
 * on loopback tries to reach its own origin and a canary server in every way a
 * page can while it is being replayed. Nothing may arrive, and each attempt is
 * reported. Uses the Chromium installed for Playwright.
 */

interface Hit {
  method: string;
  url: string;
}

interface Recorder {
  server: Server;
  origin: string;
  hits: Hit[];
  upgrades: string[];
}

async function listen(handle: (req: IncomingMessage, body: string, rec: Recorder) => { status?: number; type?: string; body: string | Buffer }): Promise<Recorder> {
  const rec = { hits: [], upgrades: [] } as unknown as Recorder;
  rec.server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      rec.hits.push({ method: req.method ?? 'GET', url: req.url ?? '/' });
      const out = handle(req, body, rec);
      res.writeHead(out.status ?? 200, { 'content-type': out.type ?? 'text/plain', 'access-control-allow-origin': '*' });
      res.end(out.body);
    });
  });
  rec.server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    rec.upgrades.push(req.url ?? '/');
    socket.destroy();
  });
  await new Promise<void>((r) => rec.server.listen(0, '127.0.0.1', r));
  rec.origin = `http://127.0.0.1:${(rec.server.address() as AddressInfo).port}`;
  return rec;
}

const GIF = Buffer.from('R0lGODlhAQABAAAAACw=', 'base64');

/** The page: before BugCapsule.init it fires every kind of request at `targets`, then starts the replay. */
function appHtml(targets: string[], live: string | null): string {
  return `<!doctype html><html><head><link rel="icon" href="data:,"><link rel="stylesheet" href="/static/app.css"></head><body>
<script src="/sdk.js"></script>
<script>
(async () => {
  const snapshot = (s) => { const o = {}; for (let i = 0; i < s.length; i++) o[s.key(i)] = s.getItem(s.key(i)); return o; };
  new Image().src = '/probe.gif?ls=' + encodeURIComponent(JSON.stringify(snapshot(localStorage))) + '&ss=' + encodeURIComponent(JSON.stringify(snapshot(sessionStorage)));
  const waits = [];
  const settle = (p) => waits.push(Promise.race([Promise.resolve(p).catch(() => {}), new Promise((r) => setTimeout(r, 2000))]));
  for (const target of ${JSON.stringify(targets)}) {
    const base = target || location.origin;
    settle(fetch(base + '/api/fetch-post', { method: 'POST', body: 'x' }));
    settle(fetch(base + '/api/fetch-get'));
    settle(fetch(base + '/api/fetch-put', { method: 'PUT', body: 'x' }));
    settle(new Promise((r) => { const x = new XMLHttpRequest(); x.open('POST', base + '/api/xhr'); x.onloadend = r; x.send('x'); }));
    navigator.sendBeacon(base + '/api/beacon', 'x');
    settle(new Promise((r) => { const es = new EventSource(base + '/api/events'); es.onerror = () => { es.close(); r(); }; }));
    settle(new Promise((r) => { const ws = new WebSocket(base.replace(/^http/, 'ws') + '/api/ws'); ws.onclose = r; ws.onerror = r; }));
    settle(new Promise((r) => {
      const w = new Worker(URL.createObjectURL(new Blob([
        "Promise.allSettled([fetch(" + JSON.stringify(base + '/api/worker-post') + ", { method: 'POST', body: 'x' }), fetch(" + JSON.stringify(base + '/api/worker-get') + ")]).then(() => postMessage(1));"
      ], { type: 'text/javascript' })));
      w.onmessage = r; w.onerror = r;
    }));
    settle(new Promise((r) => {
      const sink = document.createElement('iframe');
      sink.name = 'sink-' + waits.length;
      document.body.appendChild(sink);
      const f = document.createElement('form');
      f.method = 'POST'; f.action = base + '/api/form'; f.target = sink.name;
      document.body.appendChild(f);
      sink.addEventListener('load', r, { once: true });
      f.submit();
    }));
  }
  ${live ? `settle(fetch(${JSON.stringify(live)}, { method: 'POST', body: 'x' }));` : ''}
  await Promise.all(waits);
  await window.BC.BugCapsule.init({ appVersion: '1.0.0', appBuild: '7', mode: 'qa', allowReplay: true, consoleBreadcrumbs: false });
})();
</script></body></html>`;
}

/** A small valid capsule: no inputs, an exception that the app above never throws. */
function capsule(storage: { policy?: unknown; local?: Record<string, string>; session?: Record<string, string> } = {}): Buffer {
  const doc = JSON.parse(readFileSync(new URL('../../spec-fixtures/capsule-v1/valid/web-runtime.json', import.meta.url), 'utf8')).document;
  doc.events = [];
  doc.manifest.stats.eventCount = 0;
  doc.manifest.source.gitSha = null;
  if (storage.policy) doc.manifest.storagePolicy = storage.policy;
  else delete doc.manifest.storagePolicy;
  doc.checkpoint.data = {
    history: { location: '/' },
    ...(storage.local ? { local_storage: storage.local } : {}),
    ...(storage.session ? { session_storage: storage.session } : {}),
  };
  return gzipSync(JSON.stringify(doc));
}

let app: Recorder;
let canary: Recorder;
let cli: Recorder;
let page = '';
let capsuleBytes: Buffer = capsule();
let posted: ReplayReport[] = [];

before(async () => {
  canary = await listen(() => ({ body: 'canary' }));
  app = await listen((req) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/sdk.js') return { type: 'text/javascript', body: sdkBundle() };
    if (path === '/static/app.css') return { type: 'text/css', body: 'body { margin: 0 }' };
    if (path === '/probe.gif') return { type: 'image/gif', body: GIF };
    if (path.startsWith('/api/')) return { body: 'live' };
    return { type: 'text/html', body: page };
  });
  cli = await listen((req, body) => {
    const path = req.url ?? '/';
    if (path.endsWith('/settings')) return { type: 'application/json', body: JSON.stringify({ strategy: 'auto', settleTimeoutMs: 300, attempt: 1, kind: 'replay', strictNetwork: true, idleCompression: true, attemptId: 'att-runner', runtime: 'web' }) };
    if (path.endsWith('/capsule')) return { type: 'application/gzip', body: capsuleBytes };
    if (path.endsWith('/result')) {
      posted.push(JSON.parse(body));
      return { type: 'application/json', body: '{}' };
    }
    return { status: 404, body: '' };
  });
});

after(async () => {
  for (const r of [app, canary, cli]) {
    r.server.closeAllConnections();
    await new Promise((done) => r.server.close(done));
  }
});

beforeEach(() => {
  app.hits.length = 0;
  app.upgrades.length = 0;
  canary.hits.length = 0;
  canary.upgrades.length = 0;
  posted = [];
  capsuleBytes = capsule();
});

const lines: string[] = [];
async function replay(extra: { allowLive?: string[] } = {}): Promise<ReplayReport> {
  lines.length = 0;
  const report = await runReplayAttempt({
    replayUrl: `${cli.origin}/a/tok`,
    appUrl: `${app.origin}/`,
    timeoutMs: 45_000,
    log: (l) => lines.push(l),
    ...extra,
  });
  assert.equal(posted.length, 1, 'the report is posted to the CLI');
  return report;
}

const apiHits = (r: Recorder) => r.hits.filter((h) => h.url.startsWith('/api/'));
const escapedTo = (report: ReplayReport, origin: string) => report.divergences.filter((d) => d.type === 'network.escaped' && d.detail.includes(origin)).map((d) => d.detail);

describe('static load rule', () => {
  const allowed = new Set(['http://127.0.0.1:4317']);
  it('allows only GET/HEAD document, script, stylesheet, image, font and media from allowed origins', () => {
    for (const t of ['document', 'script', 'stylesheet', 'image', 'font', 'media']) assert.equal(isStaticLoad('http://127.0.0.1:4317/x', 'GET', t, allowed), true, t);
    assert.equal(isStaticLoad('http://127.0.0.1:4317/x', 'HEAD', 'image', allowed), true);
    for (const t of ['fetch', 'xhr', 'eventsource', 'websocket', 'ping', 'other', 'manifest']) assert.equal(isStaticLoad('http://127.0.0.1:4317/x', 'GET', t, allowed), false, t);
    assert.equal(isStaticLoad('http://127.0.0.1:4317/x', 'POST', 'document', allowed), false, 'form POST');
    assert.equal(isStaticLoad('http://127.0.0.1:9/x', 'GET', 'script', allowed), false, 'other origin');
    assert.equal(isStaticLoad('not a url', 'GET', 'script', allowed), false);
  });
});

describe('replay runner egress (Chromium)', { timeout: 120_000 }, () => {
  it('nothing reaches the app API or a canary server; every attempt is reported', async () => {
    page = appHtml(['', canary.origin], null);
    const report = await replay();
    assert.equal(report.attemptId, 'att-runner');
    assert.notEqual(report.outcome, 'error', report.message ?? '');
    assert.deepEqual(apiHits(app), [], 'the app origin served no API request');
    assert.deepEqual(app.upgrades, [], 'no WebSocket reached the app');
    assert.deepEqual(canary.hits, [], 'the canary received nothing');
    assert.deepEqual(canary.upgrades, []);
    assert.ok(app.hits.some((h) => h.url === '/sdk.js'), 'scripts load');
    assert.ok(app.hits.some((h) => h.url === '/static/app.css'), 'styles load');

    for (const origin of [app.origin, canary.origin]) {
      const d = escapedTo(report, origin);
      for (const what of ['POST fetch', 'GET fetch', 'PUT fetch', 'POST xhr', 'GET eventsource', 'POST document']) {
        assert.ok(d.some((x) => x.startsWith(what) && x.includes('/api/')), `${what} to ${origin} reported: ${JSON.stringify(d)}`);
      }
      assert.ok(d.some((x) => x.startsWith('POST') && x.includes('/api/beacon')), `beacon to ${origin} reported`);
      assert.ok(d.some((x) => x.includes('/api/worker-post')) && d.some((x) => x.includes('/api/worker-get')), `worker requests to ${origin} reported`);
      assert.ok(
        report.divergences.some((x) => x.type === 'network.escaped' && x.detail.startsWith('WebSocket ws://') && x.detail.includes(origin.replace('http://', ''))),
        `WebSocket to ${origin} reported`,
      );
    }
    const a = assessAttempt(report);
    assert.equal(a.status, 'invalid');
    assert.ok(a.reasons.some((r) => r.startsWith('divergence network.escaped')));
  });

  it('--allow-live lets matching requests through, logs them and makes the attempt invalid', async () => {
    page = appHtml([canary.origin], `/api/live`);
    const report = await replay({ allowLive: ['/api/live'] });
    assert.deepEqual(apiHits(app), [{ method: 'POST', url: '/api/live' }]);
    assert.deepEqual(canary.hits, []);
    const live = report.divergences.filter((d) => d.type === 'replay.unsafe_live');
    assert.ok(live.some((d) => d.detail.startsWith('POST fetch') && d.detail.endsWith('/api/live')), JSON.stringify(live));
    assert.ok(lines.some((l) => l.includes('live request (--allow-live): POST fetch')));
    const a = assessAttempt(report);
    assert.equal(a.status, 'invalid');
    assert.deepEqual(a.reasonCodes, ['replay.unsafe_live']);
  });

  it('seeds only storage keys the capsule policy allows, and none without a policy (BC-ENT-013)', async () => {
    page = appHtml([], null);
    const probe = () => {
      const h = app.hits.find((x) => x.url.startsWith('/probe.gif'))!;
      const q = new URL(h.url, app.origin).searchParams;
      return { ls: JSON.parse(q.get('ls')!), ss: JSON.parse(q.get('ss')!) };
    };
    capsuleBytes = capsule({
      policy: { local_storage: { allowPrefixes: ['shop.'], denyPrefixes: ['shop.secret'] }, session_storage: { allowPrefixes: ['tab.'] } },
      local: { 'shop.cart': '[1]', 'shop.secret.k': 's', 'auth.admin': 'true' },
      session: { 'tab.id': '7', 'feature.flag': 'on' },
    });
    let report = await replay();
    assert.deepEqual(probe(), { ls: { 'shop.cart': '[1]' }, ss: { 'tab.id': '7' } });
    assert.deepEqual(
      report.divergences.filter((d) => d.type === 'restore.disallowed').map((d) => d.detail),
      ['local_storage.shop.secret.k', 'local_storage.auth.admin', 'session_storage.feature.flag'],
    );

    app.hits.length = 0;
    posted = [];
    capsuleBytes = capsule({ local: { 'shop.cart': '[1]' } });
    report = await replay();
    assert.deepEqual(probe(), { ls: {}, ss: {} });
    assert.deepEqual(report.divergences.filter((d) => d.type === 'restore.disallowed').map((d) => d.detail), ['local_storage.shop.cart']);
  });
});
