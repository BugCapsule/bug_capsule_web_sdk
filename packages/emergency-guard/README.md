# @bugcapsule/emergency-guard

Server-side enforcement of BugCapsule emergency policies for Node.js 20+.

When something goes wrong in production (a pricing bug, a payment provider
outage, a broken release), an operator can activate an emergency policy in
BugCapsule: block `checkout.confirm_order`, make `wallet.*` read-only, and so
on. The mobile and web SDKs apply the same signed policy to their UI, but a
flag in a client never stops money from moving: old app versions, scripts
and direct API calls go straight to your backend. This package is the check
your backend runs **right before it commits an irreversible operation**.

The guard:

- fetches the signed policy document for your application and environment,
- verifies the ECDSA P-256 signature against the trust anchor you configure
  (a key inside a response is never trusted),
- refuses replays of older documents and documents that arrive expired,
- keeps the document in memory (optionally on disk) and evaluates it
  synchronously, without a network call per request,
- enforces it: throws `EmergencyBlockedError`, which maps to an RFC 9457
  `503` problem response.

It has no runtime dependencies (`node:crypto` only), never keeps your
process alive, and never logs your credential.

```bash
npm install @bugcapsule/emergency-guard@beta
```

## Quick start

```ts
import { createEmergencyGuard, EmergencyBlockedError, problemResponse, sendProblem } from '@bugcapsule/emergency-guard';

const guard = createEmergencyGuard({
  credential: process.env.BUGCAPSULE_SDK_TOKEN!,      // bcsdk.v1… (or bct_… together with apiUrl)
  trustAnchor: process.env.BUGCAPSULE_EMERGENCY_ANCHOR!, // bcek.v1…, from the dashboard; never fetched
  environment: 'production',
  failureModes: { 'checkout.*': 'FAIL_CLOSED' },      // default for every other key: FAIL_OPEN
});
await guard.start(); // resolves after the first fetch, even if it failed

app.post('/orders', async (req, res) => {
  const input = validate(req.body);                     // validation, pricing, stock…
  try {
    const decision = await guard.enforce({
      featureKey: 'checkout.confirm_order',
      operation: 'write',
      subject: req.user.id,                             // pseudonymous actor id, never an email
    });
    const order = await db.transaction(async (tx) => {
      const order = await tx.orders.insert({ ...input, emergencyDocumentRevision: decision.documentRevision });
      await payments.charge(order, { idempotencyKey: req.get('Idempotency-Key') });
      return order;
    });
    res.status(201).json(order);
  } catch (e) {
    if (e instanceof EmergencyBlockedError) return sendProblem(res, problemResponse(e, { instance: req.originalUrl }));
    throw e;
  }
});
```

Where to get the values: in the BugCapsule dashboard, **Project settings →
Keys → SDK tokens** gives the connection token (`bcsdk.v1…`, it carries the
API URL and an ingest-only key), and **Emergency → Settings → Signing keys**
gives the trust anchor (`bcek.v1…`). Secret keys (`bcs_…`) are refused: the
guard never needs one. Ship the anchor with your configuration; during a key
rotation the dashboard's anchor lists the current and the next key, so update
it when the dashboard asks you to.

## API

### `createEmergencyGuard(options)`

| Option | Default | |
|---|---|---|
| `credential` | required | `bcsdk.v1…` connection token, or an ingest key `bct_…` (legacy `bci_…`). |
| `apiUrl` | from the token | Required with an ingest key; overrides the token's URL. |
| `trustAnchor` | required | `bcek.v1…`. An invalid anchor turns policies off (one warning; every decision uses its failure mode). |
| `environment` | required | e.g. `production`. |
| `refreshIntervalMs` | `5000` | Minimum `1000`. |
| `failureModes` | `{}` (FAIL_OPEN) | Per key: exact (`checkout.confirm_order`) or prefix (`checkout.*`); exact wins, then the longest prefix. No global wildcard. |
| `strongTimeoutMs` | `1500` | Bound on the extra fetch of `consistency: 'strong'`. |
| `strongMaxStalenessMs` | `0` | Let strong checks reuse a confirmation from a fetch that started at most this long ago. |
| `requestTimeoutMs` | `10000` | Whole-request timeout for policy fetches. |
| `cacheFile` | none | Keeps the last verified envelope and the highest accepted revision across restarts (written atomically, mode `0600`, re-verified on load). |
| `appVersion` | `null` | Your service's version, for policies that target version ranges. |
| `receipts` | `true` | Report applied/failed revisions to BugCapsule (fire-and-forget). |
| `fetch`, `now`, `random`, `logger` | Node globals | Injection points for tests; `logger: false` silences the guard. |

### Methods

- `await guard.start()` – loads `cacheFile`, does the first fetch, schedules
  refreshes. Never rejects because of the network.
- `guard.evaluate(featureKey, { subject? })` – synchronous decision from
  memory: `{ featureKey, allowed, action, reasonCode, policyId,
  policyRevision, documentRevision, publicUserMessage, requiredVersion,
  fallback, fallbackAvailable, source }`. `source` is `policy`,
  `stale_policy` or `failure_mode`.
- `await guard.enforce({ featureKey, operation, subject, consistency, timeoutMs })`
  – returns the decision or throws `EmergencyBlockedError`. `operation` is
  `'write'` (default) or `'read'`: only `ALLOW` permits writes; `READ_ONLY`
  also permits reads. Every other action (`BLOCK`, `REQUIRE_UPDATE`,
  `SHOW_MAINTENANCE`, `DISABLE_FEATURE`, `USE_SAFE_FALLBACK`) refuses both;
  use `evaluate()` if you implement a fallback path yourself.
- `guard.status()` – `state` (`none` / `usable` / `expired`), `revision`,
  `issuedAt`, `expiresAt`, `lastFetchAt`, `lastSuccessAt`, `lastError`,
  `credentialRejected`, `consecutiveFailures`, `nextFetchAt`, … Export it to
  your health checks and metrics.
- `guard.onChange(listener)` – called after a new document is in place, after
  the cache file is loaded, and when the document stops being usable. Returns
  an unsubscribe function. A throwing listener never affects the guard.
- `await guard.refresh()` – fetch now (joins a fetch already in flight).
- `guard.stop()` – stops scheduled work; evaluation keeps using the cache.

`subject` is the rollout subject for partial rollouts: pass the actor or
operation id (a pseudonymous id, never an email address). If you omit it, the
guard uses its per-process installation id, so a 10 % rollout would apply to
roughly 10 % of your server processes. `subject: null` means "no subject",
which keeps partial rollouts applying to everyone (fails safe).

### `EmergencyBlockedError`

`code: 'emergency_blocked'`, `status: 503`, `retryable: true`, `featureKey`,
`operation`, `action`, `reasonCode`, `publicUserMessage` (safe to show to end
users), `policyId`, `policyRevision`, `documentRevision`, `decision`.
`toProblem({ type?, instance? })` returns the RFC 9457 body:

```json
{
  "type": "urn:bugcapsule:problem:emergency-blocked",
  "title": "Temporarily unavailable",
  "status": 503,
  "detail": "Checkout is temporarily unavailable.",
  "code": "emergency_blocked",
  "featureKey": "checkout.confirm_order",
  "operation": "write",
  "action": "BLOCK",
  "reasonCode": "PRICING_SAFETY",
  "policyId": "…",
  "policyRevision": 3,
  "documentRevision": 42,
  "requiredVersion": null,
  "fallback": null,
  "source": "policy",
  "retryable": true
}
```

When the refusal comes from a failure mode, `reasonCode` is
`POLICY_UNAVAILABLE` and `source` is `failure_mode`.

### HTTP helpers

```ts
import { checkRequest, emergencyMiddleware } from '@bugcapsule/emergency-guard';

// Any framework: get the decision or a ready response ({ status, headers, body }).
const r = await checkRequest(guard, { featureKey: 'checkout.confirm_order', subject: userId });
if (!r.ok) return new Response(r.response.body, { status: r.response.status, headers: r.response.headers });

// Express / Connect / node:http: answers 503 application/problem+json, or calls next()
// with the decision in res.locals.emergencyDecision.
app.post('/orders', emergencyMiddleware(guard, {
  featureKey: 'checkout.confirm_order',
  operation: 'write',
  subject: (req) => req.user?.id,
  retryAfterSeconds: 30,
}), createOrder);
```

A middleware runs at the start of the request. If your handler does slow work
(calls to other services, long validation) before committing, call
`guard.enforce()` again right before the commit.

### Idempotency

```ts
import { MemoryIdempotencyStore, withIdempotency } from '@bugcapsule/emergency-guard';

const store = new MemoryIdempotencyStore<Order>();
const { result, replayed } = await withIdempotency(store, req.get('Idempotency-Key')!, async () => {
  await guard.enforce({ featureKey: 'checkout.confirm_order', subject: userId });
  return createAndChargeOrder(input);
});
```

`withIdempotency` runs the function at most once per key. A duplicate gets
the first result (`replayed: true`); a concurrent duplicate waits for the
first request (up to `waitMs`, then `IdempotencyConflictError`, status 409).
If the function throws (for example because the operation was blocked), the
claim is released and nothing is stored, so the client's retry runs once the
block is lifted.

`MemoryIdempotencyStore` protects a single process and forgets everything on
restart. **In production, implement `IdempotencyStore` on your database:**
a row with a unique key, claimed with `INSERT … ON CONFLICT DO NOTHING`, and
completed in the **same transaction** that creates the order, so the record
and the effect commit or roll back together. Pass the same key to your
payment provider's idempotency mechanism too. Choose `leaseMs` longer than
the slowest run of the operation: a lease that expires while the first
attempt is still running lets a second attempt start.

## Consistency: what the guard can and cannot guarantee

Read this before relying on the guard for money.

1. **`consistency: 'cached'` (default) is eventually consistent.** Decisions
   come from the document in memory. After an operator activates a policy,
   a server keeps allowing the operation until its next refresh completes:
   the window is bounded by `refreshIntervalMs` plus the fetch latency
   (about 5 s with defaults), longer while BugCapsule is unreachable. During
   failures the guard backs off (`interval × 2^(n−1)`, at most 15 min, ±20 %
   jitter, never sooner than `Retry-After`), so the window grows with an
   outage.

2. **`consistency: 'strong'` narrows the window but does not close it.**
   Before deciding, the guard does a conditional fetch (`If-None-Match`; an
   unchanged document costs a `304`) that started after your call, bounded by
   `strongTimeoutMs` (default 1.5 s). Concurrent strong checks share one
   fetch. The remaining window is the time between that fetch and your
   commit. An operation that already passed the check and commits after the
   policy was activated still goes through: no check can stop an operation
   that is past it. Strong checks add latency and one API request per burst
   of concurrent checks; BugCapsule's rate limits apply, and a rate-limited
   strong check counts as a failed fetch (see 4).

3. **What to do about the window.**
   - Use idempotency keys on every irreversible operation (above), so retries
     and duplicates never charge twice.
   - Call `enforce()` inside the request, immediately before the
     irreversible step (after validation and other slow work), not only in
     an early middleware.
   - Log the decision's `documentRevision` (and `policyRevision`) with every
     committed operation. After an incident, reconcile: find operations
     committed after the block's activation time with a document revision
     lower than the one that carried the block, and review or refund them.
     Each emergency policy records its activation time (`activatedAt`), and
     the emergency audit log records who activated it.

4. **During BugCapsule outages** (network errors, timeouts, `5xx`, `429`):
   - While the last verified document is usable (until its `expires_at` plus
     300 s; documents normally live for an hour and are refreshed long
     before), the guard keeps enforcing it. Policies activated during the
     outage are not seen until it ends.
   - Once it is no longer usable, or if there never was one, each feature's
     failure mode applies: `FAIL_OPEN` (default) allows with
     `reasonCode: POLICY_UNAVAILABLE`; `FAIL_CLOSED` refuses; and
     `USE_LAST_VALID_POLICY` keeps evaluating the expired document
     (`source: stale_policy`), allowing if there was none.
   - A `strong` check whose fetch fails or times out refuses with
     `POLICY_UNAVAILABLE` under `FAIL_CLOSED`, and otherwise falls back to
     the cached decision. A failed strong check never loosens a cached
     restriction.
   - `FAIL_CLOSED` turns a BugCapsule outage into an outage of that feature.
     Use it only for operations where an unchecked commit is worse than a
     refusal, typically ones that move money.
   - If the API refuses the credential (`401`, `403`, `404`), scheduled
     fetches stop for the process (logged once) and the cached document is
     used until it expires; strong checks then use the failure mode without
     calling the API. A successful `guard.refresh()` resumes the schedule.
   - With `cacheFile`, a restart during an outage starts from the last
     verified document instead of the failure mode, and the highest accepted
     revision survives restarts, so an older document cannot be replayed.

5. **No guarantee of zero loss.** The guard reduces the number of operations
   committed after an emergency policy takes effect; it cannot make that
   number zero. Clock skew between your servers and BugCapsule, refresh
   intervals, in-flight requests, outages and failure modes all leave room
   for operations to commit after activation. Treat the guard as one layer
   alongside idempotency, provider-side limits and reconciliation.

## Security notes

- The trust anchor is configuration, never fetched. Only keys in the anchor
  can sign documents; the guard verifies the signature over the exact bytes
  received before parsing them, and checks that the document is bound to
  your application and environment.
- Documents with a lower revision than the highest one accepted are refused
  (`stale_revision`), as are documents that expired more than 300 s before
  they arrived (`expired_on_arrival`). Responses over 1 MiB are refused.
- The credential is sent only as a bearer token to `apiUrl` and is never
  logged or written to the cache file.
- Receipts carry a random per-process installation id, the environment,
  `platform: SERVER`, the revision and an error code; nothing about your
  users.

## Wire contract

The guard implements the BugCapsule emergency client contract v1 (signed
envelope, verification order, acceptance and evaluation rules) and passes
the shared test vectors in `spec-fixtures/emergency-v1/` of this repository.

License: see [LICENSE](LICENSE).
