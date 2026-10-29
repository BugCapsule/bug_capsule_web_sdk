/**
 * A mini checkout server (node:http) enforcing emergency policies at the
 * commit point with idempotency keys, against a fake BugCapsule API. Shows
 * a block activated mid-flight: requests before the guard's refresh pass,
 * requests after are refused with a 503 problem, and a duplicate submission
 * with the same idempotency key returns the first result without charging.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import {
  createEmergencyGuard,
  EmergencyBlockedError,
  IdempotencyConflictError,
  MemoryIdempotencyStore,
  problemResponse,
  sendProblem,
  withIdempotency,
  type EmergencyGuard,
} from '../../../packages/emergency-guard/src/index.js';
import { APP_ID, ENV, FakeBugCapsule, INGEST_KEY, T0, delay, document, makeAnchor, makeKey, policy, signEnvelope } from './helpers.js';

interface Order {
  orderId: string;
  chargeId: string;
  amount: number;
  committedAt: number;
  /** The policy document the commit was checked against (kept for reconciliation). */
  emergencyDocumentRevision: number | null;
}

const key = makeKey('ek_checkout');

class CheckoutApp {
  readonly charges: { chargeId: string; amount: number }[] = [];
  readonly orders: Order[] = [];
  private readonly store = new MemoryIdempotencyStore<{ status: number; body: Order }>();
  private server: Server | null = null;
  url = '';

  constructor(private readonly guard: EmergencyGuard) {}

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((r) => this.server?.close(() => r()) ?? r());
  }

  /** Payment provider stand-in: irreversible, slow. */
  private async charge(amount: number): Promise<string> {
    await delay(20);
    const chargeId = `ch_${this.charges.length + 1}`;
    this.charges.push({ chargeId, amount });
    return chargeId;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { customerId: string; amount: number };
    const idempotencyKey = req.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string') {
      res.writeHead(400).end();
      return;
    }
    try {
      const { result, replayed } = await withIdempotency(
        this.store,
        idempotencyKey,
        async () => {
          // Validation, pricing, stock checks… then, immediately before the irreversible step:
          const decision = await this.guard.enforce({ featureKey: 'checkout.confirm_order', operation: 'write', subject: input.customerId });
          const chargeId = await this.charge(input.amount);
          const order: Order = {
            orderId: `ord_${this.orders.length + 1}`,
            chargeId,
            amount: input.amount,
            committedAt: Date.now(),
            emergencyDocumentRevision: decision.documentRevision,
          };
          this.orders.push(order);
          return { status: 201, body: order };
        },
        { pollMs: 2 },
      );
      res.writeHead(result.status, { 'content-type': 'application/json', 'idempotent-replayed': String(replayed) });
      res.end(JSON.stringify(result.body));
    } catch (e) {
      if (e instanceof EmergencyBlockedError) return sendProblem(res, problemResponse(e, { instance: req.url ?? '/' }));
      if (e instanceof IdempotencyConflictError) {
        res.writeHead(409).end();
        return;
      }
      res.writeHead(500).end();
    }
  }
}

describe('checkout server with a block activated mid-flight', () => {
  let api: FakeBugCapsule;
  let guard: EmergencyGuard;
  let app: CheckoutApp;

  before(async () => {
    api = await new FakeBugCapsule().start();
    api.serve(signEnvelope(key, document({ revision: 1, policies: [] })));
    guard = createEmergencyGuard({
      apiUrl: api.url,
      credential: INGEST_KEY,
      trustAnchor: makeAnchor(APP_ID, [key]),
      environment: ENV,
      // Long interval so the test decides when the refresh happens.
      refreshIntervalMs: 60_000,
      failureModes: { 'checkout.*': 'FAIL_CLOSED' },
      now: () => T0,
      logger: false,
    });
    await guard.start();
    app = new CheckoutApp(guard);
    await app.start();
  });

  after(async () => {
    guard.stop();
    await app.close();
    await api.close();
  });

  const order = (idempotencyKey: string, customerId = 'cust_1', amount = 4999) =>
    fetch(`${app.url}/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify({ customerId, amount }),
    });

  it('runs the scenario', async () => {
    // 1. Normal operation.
    const a = await order('key-a');
    assert.equal(a.status, 201);
    const first = (await a.json()) as Order;
    assert.equal(first.emergencyDocumentRevision, 1);

    // 2. Five concurrent submissions of one checkout (double click, client retry): one charge.
    const dupes = await Promise.all(Array.from({ length: 5 }, () => order('key-b', 'cust_2')));
    const bodies = (await Promise.all(dupes.map((r) => r.json()))) as Order[];
    assert.ok(dupes.every((r) => r.status === 201));
    assert.equal(new Set(bodies.map((b) => b.orderId)).size, 1);
    assert.equal(dupes.filter((r) => r.headers.get('idempotent-replayed') === 'false').length, 1);
    assert.equal(app.charges.length, 2);

    // 3. An operator activates a BLOCK in BugCapsule.
    const activatedAt = Date.now();
    api.serve(signEnvelope(key, document({ revision: 2, policies: [policy({ revision: 5, public_user_message: 'Checkout is paused while we fix prices.' })] })));

    //    Before the guard refreshes, cached checks still pass: this order commits after activation.
    const c = await order('key-c', 'cust_3');
    assert.equal(c.status, 201);
    const late = (await c.json()) as Order;
    assert.equal(late.emergencyDocumentRevision, 1);

    // 4. The guard refreshes (its interval tick): new requests are refused before charging.
    await guard.refresh();
    const d = await order('key-d', 'cust_4');
    assert.equal(d.status, 503);
    assert.equal(d.headers.get('content-type'), 'application/problem+json');
    const problem = (await d.json()) as Record<string, unknown>;
    assert.equal(problem.status, 503);
    assert.equal(problem.code, 'emergency_blocked');
    assert.equal(problem.featureKey, 'checkout.confirm_order');
    assert.equal(problem.action, 'BLOCK');
    assert.equal(problem.reasonCode, 'PRICING_SAFETY');
    assert.equal(problem.policyRevision, 5);
    assert.equal(problem.documentRevision, 2);
    assert.equal(problem.detail, 'Checkout is paused while we fix prices.');
    assert.equal(problem.retryable, true);
    assert.equal(problem.instance, '/orders');
    assert.equal(app.charges.length, 3);

    // 5. A duplicate of an order committed before the block returns the first result; no new charge.
    const again = await order('key-a');
    assert.equal(again.status, 201);
    assert.equal(again.headers.get('idempotent-replayed'), 'true');
    assert.deepEqual(await again.json(), first);
    assert.equal(app.charges.length, 3);

    // 6. Reconciliation: orders committed after the activation against an older document.
    const toReview = app.orders.filter((o) => o.committedAt >= activatedAt && (o.emergencyDocumentRevision ?? 0) < 2);
    assert.deepEqual(
      toReview.map((o) => o.orderId),
      [late.orderId],
    );

    // 7. The block is lifted: the refused request's key was never stored, so its retry goes through.
    api.serve(signEnvelope(key, document({ revision: 3, policies: [] })));
    await guard.refresh();
    const retry = await order('key-d', 'cust_4');
    assert.equal(retry.status, 201);
    assert.equal(((await retry.json()) as Order).emergencyDocumentRevision, 3);
    assert.equal(app.charges.length, 4);
  });
});
