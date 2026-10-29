import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { checkRequest, createEmergencyGuard, emergencyMiddleware, type EmergencyGuard } from '../../../packages/emergency-guard/src/index.js';
import { APP_ID, ENV, FakeBugCapsule, INGEST_KEY, T0, document, makeAnchor, makeKey, policy, signEnvelope } from './helpers.js';

const key = makeKey('ek_http');

describe('HTTP helpers', () => {
  let api: FakeBugCapsule;
  let guard: EmergencyGuard;

  before(async () => {
    api = await new FakeBugCapsule().start();
    api.serve(
      signEnvelope(
        key,
        document({
          revision: 4,
          policies: [policy({ key: 'checkout.*', public_user_message: null }), policy({ policy_id: 'ro', key: 'wallet.*', action: 'READ_ONLY' })],
        }),
      ),
    );
    guard = createEmergencyGuard({ apiUrl: api.url, credential: INGEST_KEY, trustAnchor: makeAnchor(APP_ID, [key]), environment: ENV, now: () => T0, logger: false });
    await guard.refresh();
  });

  after(async () => {
    guard.stop();
    await api.close();
  });

  it('checkRequest returns the decision or a ready 503 problem response', async () => {
    const ok = await checkRequest(guard, { featureKey: 'search.query' });
    assert.equal(ok.ok, true);
    const blocked = await checkRequest(guard, { featureKey: 'checkout.pay', subject: 'u1', retryAfterSeconds: 30, type: 'https://example.com/problems/paused' });
    assert.equal(blocked.ok, false);
    if (blocked.ok) return;
    assert.equal(blocked.response.status, 503);
    assert.deepEqual(blocked.response.headers, { 'content-type': 'application/problem+json', 'cache-control': 'no-store', 'retry-after': '30' });
    const body = JSON.parse(blocked.response.body) as Record<string, unknown>;
    assert.equal(body.type, 'https://example.com/problems/paused');
    assert.equal(body.title, 'Temporarily unavailable');
    assert.match(String(body.detail), /temporarily unavailable/i);
    assert.equal(body.featureKey, 'checkout.pay');
    await assert.rejects(checkRequest(guard, { featureKey: 'Not A Key' }), TypeError);
  });

  it('emergencyMiddleware works with a plain node:http server (Express-compatible signature)', async () => {
    type Req = IncomingMessage & { userId?: string };
    const blockedSeen: string[] = [];
    const mw = (featureKey: string, operation: 'read' | 'write') =>
      emergencyMiddleware<Req, ServerResponse & { locals?: Record<string, unknown> }>(guard, {
        featureKey,
        operation,
        subject: (req) => req.userId,
        onBlocked: (e) => blockedSeen.push(e.featureKey),
      });
    const routes: Record<string, ReturnType<typeof mw>> = {
      '/pay': mw('checkout.pay', 'write'),
      '/balance': mw('wallet.balance', 'read'),
      '/transfer': mw('wallet.transfer', 'write'),
      '/bad': mw('BAD KEY', 'write'),
    };
    const server = createServer((req: Req, res: ServerResponse & { locals?: Record<string, unknown> }) => {
      req.userId = 'user-9';
      res.locals = {};
      routes[req.url ?? '']!(req, res, (err?: unknown) => {
        if (err) {
          res.writeHead(500).end(String((err as Error).name));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(res.locals!.emergencyDecision));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const pay = await fetch(`${base}/pay`, { method: 'POST' });
      assert.equal(pay.status, 503);
      assert.equal(pay.headers.get('content-type'), 'application/problem+json');
      assert.equal(((await pay.json()) as { code: string }).code, 'emergency_blocked');

      const balance = await fetch(`${base}/balance`);
      assert.equal(balance.status, 200);
      assert.equal(((await balance.json()) as { action: string }).action, 'READ_ONLY');

      const transfer = await fetch(`${base}/transfer`, { method: 'POST' });
      assert.equal(transfer.status, 503);
      assert.equal(((await transfer.json()) as { action: string }).action, 'READ_ONLY');

      const bad = await fetch(`${base}/bad`);
      assert.equal(bad.status, 500);
      assert.equal(await bad.text(), 'TypeError');

      assert.deepEqual(blockedSeen, ['checkout.pay', 'wallet.transfer']);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
