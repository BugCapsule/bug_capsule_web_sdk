# BugCapsule web SDK

BugCapsule turns a failure QA saw in the browser into a portable `.bugcapsule`
capsule that a developer can **replay against the real app** in Chromium,
**verify after a fix**, and keep as a **regression test**: the same
capture → replay → verify → regression workflow as the
[Flutter SDK](../bug_capsule_flutter_sdk), with the same capsule format
([spec v1](../bug_capsule_flutter_sdk/spec/capsule-v1.md), runtime contracts in
[runtimes-v1](../bug_capsule_flutter_sdk/spec/runtimes-v1.md)) and the same
`bugcapsule` CLI and backend.

```
QA hits a bug ─► capsule captured, redacted, queued in IndexedDB, uploaded
                 bugcapsule run <id>          ─► REPRODUCED 3/3   (Playwright drives the real app)
fix the code ─►  bugcapsule verify <id>       ─► FIXED 3/3
                 bugcapsule regress add <id> && bugcapsule regress run
```

| Package | What it is |
|---|---|
| [`@bugcapsule/web`](packages/web) | Framework-independent SDK (TypeScript types included). `@bugcapsule/web/core` is the environment-neutral model/codec/redaction/request-key core. |
| [`@bugcapsule/react`](packages/react) | Thin React helpers: actions, tracked inputs, state, error boundary, capture button, React Router listener (`@bugcapsule/react/react-router`). |
| [`@bugcapsule/web-replay`](packages/web-replay) | Node + Playwright runner the CLI launches per replay attempt (dev dependency). |
| [`@bugcapsule/cli`](packages/cli) | Build tooling: `sourcemaps inject` (debug ids) and `sourcemaps upload` for symbolicated stack traces. |
| [`examples/shop`](examples/shop) | React demo with four planted bugs. |

## Quickstart

```bash
npm install @bugcapsule/web @bugcapsule/react
npm install -D @bugcapsule/web-replay   # only where you run `bugcapsule run|verify`
```

Generate an SDK token in the BugCapsule dashboard (Project settings → Keys →
SDK tokens), then:

```ts
// main.ts: the first thing the app does
import { BugCapsule } from '@bugcapsule/web';

await BugCapsule.init({ token: 'bcsdk.v1.…' });
renderApp();
```

That is a complete connection. The token carries your BugCapsule address
and an ingest-only credential: it can send Capsules and events and read
capture settings, nothing else, so it is safe in a web bundle. Hosted and
self-hosted BugCapsule work the same way; the token knows where to go.
`appVersion` defaults to the version part of `release`, else `unknown`.

Check the connection from the app:

```ts
console.log(BugCapsule.status());
// connection.state: 'connected' once the configuration was fetched;
// connection.firstEventAcceptedAt / firstCapsuleAcceptedAt once data arrived;
// instrumentation.missing: the replay adapters not set up yet
```

| `connection.state` | Meaning |
|---|---|
| `connecting` | No configuration fetched yet in this page session |
| `connected` | Configuration fetched: address, token and network work |
| `offline` | BugCapsule can't be reached; data stays in the outbox and is retried |
| `rejected` | The token was refused: `reason` is `token_revoked`, `token_expired` or `token_unknown`, `message` says what to do. Capture and uploads stop for the page session |
| `invalid_token` / `unsupported_token_version` | The token can't be read (damaged, a key pasted instead, or made for a newer SDK). One `[bugcapsule]` line in the console says why; the app runs without BugCapsule |
| `disabled` | `enabled: false`, or capture switched off for the project |

A wrong, revoked or unreachable token never throws from `init` and never
delays your app's start.

### Complete capture and replay (progressive)

The token connects. Faithful replay also needs the app's network, navigation
and state, which you add as you go:

```ts
import { BugCapsule, networkIntegration, historyIntegration, localStorageIntegration } from '@bugcapsule/web';

await BugCapsule.init({
  token: 'bcsdk.v1.…',
  appVersion: '1.4.0',
  appBuild: '52',
  mode: 'qa',                                   // 'debug' | 'qa' | 'production' (sampled)
  gitSha: import.meta.env.VITE_BUGCAPSULE_GIT_SHA,
  integrations: [
    networkIntegration({ rules: [{ method: 'POST', path: '/api/checkout', ignoreBodyFields: ['timestamp', 'nonce'] }] }),
    historyIntegration(),
    localStorageIntegration({ allowPrefixes: ['shop.'] }),
  ],
  allowReplay: import.meta.env.DEV || import.meta.env.VITE_BUGCAPSULE_ALLOW_REPLAY === 'true',
});

renderApp();
```

**Explicit backend (setups from before tokens).** `backend: { url:
'https://bugcapsule.example.com', ingestKey: 'bci_…' }` still works and wins
over `token`. Never put a `bcs_` secret key in an app.

Await `init` before rendering: in replay it restores storage and state
there. Call it before any code keeps its own reference to `fetch`.

The same `init` also turns on **monitoring** (errors, release health,
tracing, user feedback; [docs/monitoring.md](docs/monitoring.md)). Add a
`release` and, for performance data, a `tracesSampleRate`:

```ts
await BugCapsule.init({
  …,
  release: 'shop-web@1.4.0+52',
  tracesSampleRate: 0.2,
  tracePropagationTargets: ['api.example.com'],   // default: same origin
});
BugCapsule.setUser({ id: user.id });
```

### Make more bugs replayable

| Hook | Why |
|---|---|
| `onClick={BugCapsule.action('cart.checkout', checkout)}` + `data-bugcapsule-action="cart.checkout"` | Semantic replay by id; the attribute is also the stable selector for click replay |
| `BugCapsule.trackInput('login.email', inputEl)` / React `useTrackedInput`, `useTrackedState` | Typed text is replayed. Password inputs, `data-bugcapsule-sensitive` elements, `sensitive: true` and sensitive-looking ids record `[REDACTED]` |
| `BugCapsule.check('cart_total_non_negative', total >= 0)` / `BugCapsule.fail(id)` | Wrong behaviour that does not throw becomes a checkable failure |
| `BugCapsule.reportError(e)` / `<BugCapsuleErrorBoundary>` | Errors your code or React catches never reach `window.onerror` |
| `BugCapsule.registerState('cart', { serialize, restore })` / `useBugCapsuleState` | App-owned state in checkpoints, restored in replay |
| `indexedDbIntegration([{ name, snapshot, restore }])` | Application-owned IndexedDB stores, through adapters you write (the SDK never reads IndexedDB itself) |
| `BugCapsule.now()` / `BugCapsule.date()` instead of `Date.now()` | Replay returns the recorded wall clock |
| `BugCapsule.random()` instead of `Math.random()` | Seeded per session, same seed in replay |

React:

```tsx
import { useBugCapsuleAction, useTrackedState, BugCapsuleErrorBoundary, BugCapsuleCaptureButton } from '@bugcapsule/react';
import { BugCapsuleRouteListener } from '@bugcapsule/react/react-router';

<BrowserRouter>
  <BugCapsuleRouteListener />              {/* route events with push/pop/replace */}
  <BugCapsuleErrorBoundary fallback={<Oops />}><Routes>…</Routes></BugCapsuleErrorBoundary>
  <BugCapsuleCaptureButton />              {/* QA builds only */}
</BrowserRouter>
```

## Monitoring

Every page load (not only sampled capsule sessions) sends light envelopes to
`POST /v1/envelope` ([monitoring-v1](../bug_capsule_backend/docs/monitoring-v1.md)):

| Signal | How |
|---|---|
| Error events | `error`, `unhandledrejection`, `reportError`, `check`/`fail`, React error boundary and React 19 root callbacks, opt-in `console.error`, `captureException` / `captureMessage`. Frames parsed from Chromium, Firefox and Safari stacks with `inApp`, `debugImages` from injected debug ids, the `cause` chain, breadcrumbs derived from the flight recorder plus clicks, fetch/XHR, navigation and console, the scope (`setUser`, `setTag`, `setContext`, `withScope` …), `beforeSend`, fingerprints |
| Capsule link | an event for a failure that gets a capsule carries `capsuleId`; the capsule carries `manifest.monitoring = {eventId, traceId, release, environment}` |
| Release health | one session per page load, `crashed` on an unhandled error, `exited` on `pagehide` |
| Tracing | pageload and navigation transactions (History API, React Router route patterns), `http.client` spans, resource / paint / long-task spans, web vitals (LCP, INP, CLS, FCP, TTFB), `startTransaction` / `startSpan`, `tracesSampleRate` / `tracesSampler`, `traceparent` + `baggage` to `tracePropagationTargets` |
| User feedback | `captureFeedback`, and an opt-in themeable widget (`showFeedbackWidget`, `<BugCapsuleFeedbackWidget />`), optionally with a capsule |

Envelopes are redacted with the capsule rules before they are stored, kept
in their own IndexedDB outbox (30 envelopes / 5 MiB) and sent with the same
backoff and `Retry-After` handling as capsules. Nothing is sent during
replay, and the trace headers never enter capsules or request keys. The
backend can lower sampling and turn monitoring off remotely; `monitoring:
false` turns it off locally. Symbolication: `npx @bugcapsule/cli sourcemaps
inject dist` then `sourcemaps upload` in CI ([packages/cli](packages/cli)).

### Alongside Sentry

Apps that keep Sentry for errors add `sentryCompanion()` to `Sentry.init`
and set `monitoring: false` in `BugCapsule.init`: each Sentry error event
gets a `bugcapsule.capsule_id` tag and the capsule gets
`manifest.links.sentry.eventId`. See
[Using BugCapsule with Sentry](packages/web/README.md#using-bugcapsule-with-sentry).

## What is captured

| Area | How | Replay |
|---|---|---|
| Pointer (mouse, touch, pen) | `pointerdown/up/cancel` and moves while pressed, viewport CSS px, plus a target descriptor on `down` (`data-bugcapsule-action`, `data-testid`/`id` selector, visible text) | Real browser input through Playwright at the recorded coordinates; `pointer.mismatch`, `selector.ambiguous`, `selector.missing` when the target moved |
| Semantic actions | `BugCapsule.action` / `useBugCapsuleAction` | Invoked by id (or clicks the element declaring it) |
| Tracked input | `trackInput` / `trackValue` / React hooks | Native value setter + `input`/`change` events |
| Navigation | `historyIntegration` (pushState, replaceState, popstate, hashchange); `BugCapsuleRouteListener` for React Router | Reproduced by the inputs; the runner opens the checkpoint's location |
| Errors | `error`, `unhandledrejection`, `reportError`, error boundary | Matched by signature |
| Assertions | `check` / `fail` | Matched by id |
| Network | `fetch` and `XMLHttpRequest` (`networkIntegration`) | Recorded responses served in page with recorded latency, status, headers, errors, cancellation and timeouts |
| Storage | allowlisted `localStorage` / `sessionStorage` keys; IndexedDB adapters; registered state | Restored before the app renders (the runner also restores web storage before any page script) |
| Lifecycle | `visibilitychange`, `pagehide`, `pageshow` | Synthetic events with an overridden `document.visibilityState` (`partial`) |

Never captured automatically: input values (only tracked inputs), DOM
content, cookies, storage outside the allowlist, password inputs.

## Network capture and replay

* Request keys, query normalization, body hashing, endpoint rules and
  occurrence order are exactly the capsule-v1 rules (checked against the
  shared conformance fixtures).
* Bodies are never buffered whole: the SDK reads a `clone()` of the response
  up to `maxBodyBytes` (256 KiB text, 64 KiB binary) and then cancels the
  clone; the app consumes the original stream unchanged. Larger bodies are
  `truncated`, `text/event-stream` responses `omitted`. Streaming request
  bodies (`ReadableStream`), `FormData` and XHR `Blob` bodies are never read:
  they are keyed without a body hash.
* App wrappers installed after `init` sit above the SDK's, so app
  interceptors and transformations still run during replay; only the bytes on
  the wire come from the capsule.
* Replay is strict: an unrecorded request fails like a network error and
  reports `network.unrecorded`; nothing reaches real services. The runner
  additionally blocks every browser request to an origin other than the app's
  (images, scripts, requests made by code that bypassed the SDK) and reports
  `network.escaped`. Allow static origins with `web.allowOrigins`.

## Privacy controls

Redaction runs on the device before anything is stored or uploaded, with the
same rules as every BugCapsule SDK (capsule-v1 *Redaction*): sensitive keys
in bodies, storage and state; sensitive headers; URL user info and sensitive
query/fragment parameters; credentials in free text (bearer tokens, JWTs, API
key formats, card numbers). Add `redactKeys`, `redactHeaders`,
`redactPatterns`, `beforeRecord`, `beforeCheckpoint`,
`networkIntegration({ exclude })` and `historyIntegration({ sanitizeLocation })`.
The backend can add redaction keys, turn body capture off, lower sampling and
switch capture off remotely. Inspect real capsules with `bugcapsule inspect`
before widening a rollout. Redaction does not find personal data that is not
a credential (names, emails, addresses) or secrets in URL paths.

## Storage and uploads

* IndexedDB (`bugcapsule` database): upload outbox (10 capsules / 10 MiB /
  7 days, oldest evicted first), the newest 20 saved captures, the cached
  remote config. Without IndexedDB (blocked by privacy settings) the SDK keeps
  them in memory.
* Writes are single IndexedDB transactions; quota errors, corrupt records and
  unavailable storage drop the capsule, never the app.
* Queues survive reloads. Several tabs share one queue; only one uploads at a
  time (Web Locks, or a lease record on insecure origins without them).
* Uploads retry 30 s → 1 h with jitter, honouring `Retry-After` (a server
  deadline also survives reloads). Nothing relies on an upload finishing while
  the page unloads: the next page load uploads.
* Uploads need a remote config fetched within 7 days; a kill switch purges the
  queue and saved captures and persists; a rejected ingest key stops capture
  for the page session.
* The backend must allow your origin: `CORS_ALLOWED_ORIGINS=https://app.example.com`
  ([backend README](../bug_capsule_backend/README.md)).

## Replay with the CLI

`bugcapsule.json` next to the app:

```json
{
  "runtime": "web",
  "web": {
    "url": "http://127.0.0.1:4317/",
    "installCommand": "npm ci",
    "buildCommand": "npm run build",
    "serveCommand": "npm run preview -- --port 4317 --strictPort",
    "env": { "VITE_BUGCAPSULE_ALLOW_REPLAY": "true" }
  }
}
```

```bash
bugcapsule run <id> -n 3            # builds (on the capsule's commit when pinned), serves, replays in Chromium
bugcapsule verify <id> -n 3         # builds the working tree
bugcapsule run <id> --app-url http://127.0.0.1:4317/   # replay against an already running build
```

Each attempt opens a fresh browser context (isolated storage), sized like
the recording, with the app's own SDK (`allowReplay: true`) driving the
replay. The CLI refuses to start when something already serves `web.url`
(it might be an old build). See [CLI runtimes](../bug_capsule_flutter_sdk/docs/cli-runtimes.md).

**Production protection.** Replay activates only when the app passes
`allowReplay: true` *and* the page was opened by the runner (Playwright
bindings). Wire `allowReplay` to a dev/test build flag; production builds
leave it false, and then nothing (URLs, storage, messages, network, scripts in
the page) can turn replay on. In a build with `allowReplay: true`, a script
already running in the page could imitate the runner's bindings, which is one
more reason to keep such builds out of production.

## Supported browsers

| Browser | Capture | Replay |
|---|---|---|
| Chromium / Chrome / Edge | implemented, tested (Playwright Chromium 153) | implemented, tested |
| Firefox, Safari | uses only standard APIs (fetch, XHR, IndexedDB, CompressionStream, Pointer Events); **not tested** | not implemented (`web.browser` other than `chromium` is refused) |

## Limitations

* Lifecycle replay is synthetic (`partial`). `Date.now()`, timers,
  animations and `Math.random()` are not virtualized; use `BugCapsule.now()` /
  `random()`.
* Hover-only interactions are not recorded (moves are recorded only while a
  pointer is pressed). Keyboard input is replayed only through tracked inputs.
* WebSockets, EventSource payloads, service workers (blocked during replay),
  `navigator.sendBeacon`, and third-party iframes are not captured.
* A fix that makes the app send requests the recording never saw cannot be
  verified as FIXED: strict replay reports `network.unrecorded` and the
  verdict is INCONCLUSIVE. Capture a capsule that covers the fixed path.
* Synchronous XHR is replayed without its recorded latency.
* Cross-origin script errors without CORS headers arrive as `Script error.`.
* Capsules replay only in the web runtime (no cross-runtime replay).
* Monitoring: the active span of `startSpan` is shared page-wide while async
  work runs (browsers have no async context); the final session update sent
  during unload is not confirmed (its queued copy is retried on the next
  load). See [docs/monitoring.md](docs/monitoring.md#limitations).

## Development

```bash
npm install
npm run build                 # packages/*/dist (the demo uses the built packages)
npm run test:unit             # core conformance (shared fixtures), outbox, remote config, monitoring, CLI
npm run test:browser          # SDK in Chromium: capture, redaction, offline, kill switch, cross-tab, XHR, replay, monitoring, React
npm run pack:all              # dist-packages/*.tgz for review (not published)
```

The shared fixtures in `spec-fixtures/` are a copy of
`bug_capsule_flutter_sdk/spec/fixtures` (`tool/sync_spec.sh` there); the unit
tests fail when they differ.

## Release procedure

1. `npm run build && npm test` and the demo E2E ([examples/shop](examples/shop/README.md)).
2. Bump the version in the four `package.json` files and `SDK_VERSION` in
   `packages/web/src/runtime.ts` (written into every capsule and envelope).
3. `npm run pack:all`, inspect the tarballs (`tar -tzf`), install them in a
   clean project and type-check (as done for 0.3.0).
4. Publish from a clean checkout (`npm publish -w … --access public`) only
   after review; record the git SHA of the release.

## Release validation (2026-10-23)

This repository is proprietary to Bug Capsule. Use, copying, modification, and distribution require prior written permission (see LICENSE). Local candidates are
prepared without publishing. See `docs/release-readiness.md` for the current
validation evidence and remaining release gates.
