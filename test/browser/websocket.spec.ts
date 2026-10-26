import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { validateCapsuleDocument } from '../../packages/web/src/core/validator.js';
import { BACKEND, ORIGIN, decodeUpload, newBackend, setUpRoutes, type BackendState } from './harness.js';

const INGEST = 'bci_test_key_0123456789abcdefghij';
const QUOTES = 'ws://api.bc.test/quotes';

let backend: BackendState;
test.beforeEach(async ({ page }) => {
  backend = newBackend();
  await setUpRoutes(page, backend);
});

async function init(page: Page, extra: Record<string, unknown> = {}) {
  await page.evaluate(
    async ({ BACKEND, INGEST, extra }) => {
      const { BugCapsule, webSocketIntegration } = (window as any).BC;
      await BugCapsule.init({
        appVersion: '1.0.0',
        appBuild: '7',
        mode: 'qa',
        gitSha: 'abc123',
        backend: { url: BACKEND, ingestKey: INGEST },
        integrations: [webSocketIntegration()],
        ...extra,
      });
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
    },
    { BACKEND, INGEST, extra },
  );
}

/** Two sockets to the same URL with the same subscribe frame; a bug that depends on the order quotes arrive in. */
async function quotesApp(page: Page, fixed = false): Promise<void> {
  await page.evaluate(
    ({ QUOTES, fixed }) => {
      const w = window as any;
      w.__log = [];
      const open = (name: string) => {
        const ws = new WebSocket(`${QUOTES}?token=abc123`);
        ws.onopen = () => ws.send(JSON.stringify({ op: 'subscribe', symbol: 'ACME' }));
        ws.onmessage = (e) => {
          w.__log.push(`${name}:${e.data}`);
          if (w.__log.length === 3) {
            if (!fixed && !w.__log[0].startsWith('a:')) w.BC.BugCapsule.fail('quotes.order', w.__log.join(' '));
            ws.close(1000, 'done');
          }
        };
      };
      open('a');
      open('b');
    },
    { QUOTES, fixed },
  );
}

interface Bridge {
  reports: any[];
}

async function withBridge(page: Page, capsule: unknown, settings: Record<string, unknown> = {}): Promise<Bridge> {
  const bridge: Bridge = { reports: [] };
  await page.addInitScript(() => {
    (window as any).__BUGCAPSULE_REPLAY__ = { version: 1 };
  });
  await page.exposeBinding('__bugcapsuleReplayCall', async (_source, op: string, payload: any) => {
    if (op === 'load') {
      return { capsule, settings: { strategy: 'semantic', settleTimeoutMs: 1000, attempt: 1, kind: 'replay', strictNetwork: true, idleCompression: true, attemptId: 'att-ws', ...settings } };
    }
    if (op === 'report') bridge.reports.push(payload);
    return null;
  });
  return bridge;
}

test('WebSocket race: capture → capsule (v2) → replay in recorded order, offline', async ({ page, context }) => {
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket(`${QUOTES}**`, (ws) => {
    sockets.push(ws);
    ws.onMessage(() => {
      if (sockets.length < 2 || ws !== sockets[1]) return;
      // The server answers on b first, then a, then b.
      sockets[1]!.send('q1');
      sockets[0]!.send('q2');
      sockets[1]!.send('q3');
    });
  });
  await page.goto(`${ORIGIN}/`);
  await init(page);
  await quotesApp(page);
  await expect.poll(() => backend.uploads.length, { timeout: 10_000 }).toBe(1);
  const captured: string[] = await page.evaluate(() => (window as any).__log);

  const doc = decodeUpload(backend.uploads[0]!);
  expect(validateCapsuleDocument(doc)).toBeNull();
  expect(doc.specVersion).toBe(2);
  expect(doc.manifest.dependencies).toHaveLength(1);
  expect(doc.manifest.dependencies[0]).toMatchObject({ id: 'ws', kind: 'websocket', adapter: 'bugcapsule-web.websocket', schema: 1, required: true, coverage: 'complete' });
  const ws = doc.events.filter((e: any) => e.type.startsWith('ws.'));
  const connects = ws.filter((e: any) => e.type === 'ws.connect');
  expect(connects.map((e: any) => [e.data.occurrence, e.data.key, e.data.url])).toEqual([
    [0, 'ws://api.bc.test/quotes?token=[REDACTED]', 'ws://api.bc.test/quotes?token=[REDACTED]'],
    [1, 'ws://api.bc.test/quotes?token=[REDACTED]', 'ws://api.bc.test/quotes?token=[REDACTED]'],
  ]);
  expect(ws.filter((e: any) => e.type === 'ws.message').map((e: any) => e.data.payload.value)).toEqual(captured.map((l) => l.slice(2)));

  // Replay: a fresh page, sockets served from the capsule, the network never reached.
  const replayPage = await context.newPage();
  const bridge = await withBridge(replayPage, doc);
  let live = 0;
  await replayPage.routeWebSocket('**', (route) => {
    live++;
    route.close();
  });
  await replayPage.goto(`${ORIGIN}/`);
  await init(replayPage, { allowReplay: true });
  await quotesApp(replayPage);
  await expect.poll(() => bridge.reports.length, { timeout: 15_000 }).toBe(1);
  const r = bridge.reports[0];
  expect(captured).toEqual(['b:q1', 'a:q2', 'b:q3']);
  expect(r.outcome).toBe('reproduced');
  expect(await replayPage.evaluate(() => (window as any).__log)).toEqual(captured);
  expect(r.divergences.filter((d: any) => d.type.startsWith('ws.') && d.type !== 'ws.unusedAfterFailure')).toEqual([]);
  expect(live).toBe(0);
});

test('binary frames are metadata; an unrecorded connect fails offline; disabledAdapters stops WebSocket capture', async ({ page, context }) => {
  await page.routeWebSocket(`${QUOTES}**`, (ws) => {
    ws.onMessage(() => ws.send(Buffer.from([1, 2, 3, 4])));
  });
  await page.goto(`${ORIGIN}/`);
  await init(page);
  await page.evaluate((QUOTES) => {
    const ws = new WebSocket(QUOTES);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => ws.send('hello');
    ws.onmessage = () => (window as any).BC.BugCapsule.fail('binary.seen');
  }, QUOTES);
  await expect.poll(() => backend.uploads.length, { timeout: 10_000 }).toBe(1);
  const doc = decodeUpload(backend.uploads[0]!);
  const message = doc.events.find((e: any) => e.type === 'ws.message');
  expect(message.data.payload).toEqual({ mode: 'metadata', replayable: false, bytes: 4, kind: 'binary' });
  expect(doc.manifest.dependencies[0].coverage).toBe('partial');
  expect(doc.manifest.dependencies[0].gaps.map((g: any) => g.code)).toEqual(['payload.binaryMetadata']);

  const replayPage = await context.newPage();
  const bridge = await withBridge(replayPage, doc);
  let live = 0;
  await replayPage.routeWebSocket('**', (route) => {
    live++;
    route.close();
  });
  await replayPage.goto(`${ORIGIN}/`);
  await init(replayPage, { allowReplay: true });
  const seen = await replayPage.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const out: string[] = [];
        const ws = new WebSocket('ws://elsewhere.bc.test/feed');
        ws.onerror = () => out.push(`error:${ws.readyState}`);
        ws.onclose = (e) => {
          out.push(`close:${e.code}:${e.wasClean}`);
          resolve(out);
        };
      }),
  );
  expect(seen).toEqual(['error:3', 'close:1006:false']);
  await expect.poll(() => bridge.reports.length, { timeout: 15_000 }).toBe(1);
  expect(bridge.reports[0].divergences.map((d: any) => d.type)).toContain('ws.unrecorded');
  expect(live).toBe(0);

  // The project's capture settings switch the adapter off: HTTP and the rest keep recording.
  backend.config = { ...backend.config, disabledAdapters: ['bugcapsule-web.websocket'] };
  const killPage = await context.newPage();
  await killPage.routeWebSocket(`${QUOTES}**`, () => {});
  await killPage.goto(`${ORIGIN}/`);
  await init(killPage, { storageName: 'bc-kill' });
  await killPage.evaluate(async () => {
    await (window as any).BC.BugCapsule.refreshRemoteConfig();
  });
  await killPage.evaluate((QUOTES) => {
    new WebSocket(QUOTES);
    setTimeout(() => (window as any).BC.BugCapsule.fail('after.kill'), 100);
  }, QUOTES);
  await expect.poll(() => backend.uploads.length, { timeout: 10_000 }).toBe(2);
  const killed = decodeUpload(backend.uploads[1]!);
  expect(killed.specVersion).toBe(1);
  expect(killed.events.filter((e: any) => e.type.startsWith('ws.'))).toEqual([]);
});
