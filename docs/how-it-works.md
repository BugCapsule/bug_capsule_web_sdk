# How the web SDK works

Reference details behind the [README](../README.md): what is captured, how
network replay matches requests, where data is stored, and the known
limitations. The capsule format itself is documented at
[docs.bugcapsule.com/capsule-format](https://docs.bugcapsule.com/capsule-format.html).

## Capture

| Area | How it is captured | How it is replayed |
|---|---|---|
| Pointer (mouse, touch, pen) | `pointerdown/up/cancel` and moves while pressed, in viewport CSS px, plus a target descriptor on `down` (`data-bugcapsule-action`, a `data-testid`/`id` selector, visible text) | Real browser input through Playwright at the recorded coordinates. `pointer.mismatch`, `selector.ambiguous` or `selector.missing` are reported when the target moved. |
| Semantic actions | `BugCapsule.action` / `useBugCapsuleAction` | Invoked by id (or by clicking the element that declares it) |
| Tracked input | `trackInput` / `trackValue` / React hooks | Native value setter plus `input`/`change` events |
| Navigation | `historyIntegration` (pushState, replaceState, popstate, hashchange); `BugCapsuleRouteListener` for React Router | Reproduced by the inputs; the runner opens the checkpoint's location |
| Errors | `error`, `unhandledrejection`, `reportError`, error boundary | Matched by signature |
| Assertions | `check` / `fail` | Matched by id |
| Network | `fetch` and `XMLHttpRequest` (`networkIntegration`) | Recorded responses served in the page with the recorded latency, status, headers, errors, cancellation and timeouts |
| WebSockets | `WebSocket` in the page (`webSocketIntegration`, opt-in): connect, open, send, message, error, close | An in-memory `WebSocket` serves the recorded server side; it never opens a connection |
| Storage | Allowlisted `localStorage` / `sessionStorage` keys; IndexedDB adapters; registered state | Restored before the app renders (the runner also restores web storage before any page script) |
| Lifecycle | `visibilitychange`, `pagehide`, `pageshow` | Synthetic events with an overridden `document.visibilityState` (`partial`) |

Never captured automatically: input values (only tracked inputs), DOM
content, cookies, storage outside the allowlist, password inputs.

## Network capture and replay

- Request keys, query normalization, body hashing, endpoint rules and
  occurrence order follow the capsule v1 rules, checked against the shared
  conformance fixtures in `spec-fixtures/`.
- Bodies are never buffered whole. The SDK reads a `clone()` of the response
  up to `maxBodyBytes` (256 KiB text, 64 KiB binary), then cancels the clone;
  the app consumes the original stream unchanged. Larger bodies are marked
  `truncated`, and `text/event-stream` responses `omitted`. Streaming request
  bodies (`ReadableStream`), `FormData` and XHR `Blob` bodies are never read:
  they are keyed without a body hash.
- App wrappers installed after `init` sit above the SDK's, so your
  interceptors and transformations still run during replay; only the bytes
  on the wire come from the capsule.
- Replay is strict. An unrecorded request fails like a network error and
  reports `network.unrecorded`; nothing reaches real services. The runner also
  blocks every browser request to an origin other than the app's (images,
  scripts, requests from code that bypassed the SDK) and reports
  `network.escaped`. Allow static origins with `web.allowOrigins` in
  `bugcapsule.json`.

## WebSocket capture and replay

Capsule format v2 adds interaction dependencies. A capsule that recorded
sockets lists the `bugcapsule-web.websocket` adapter (schema 1) in
`manifest.dependencies` and is written as v2. Capsules without sockets stay
v1. Readers of earlier versions refuse v2 capsules instead of misreading them.

- **Capture.** The integration replaces `WebSocket` in the page with a
  subclass of the browser's, so the app keeps a real socket. Each connection
  records a redacted URL and a match key: the redacted URL without fragment
  and without `ignoreQuery` parameters (default `_`, `ts`, `timestamp`,
  `nonce`, `cachebust`), query sorted. It also records an occurrence (earlier
  connects with the same key) and a reconnect attempt. Frames are recorded as
  payloads. Text frames are redacted like JSON bodies. Binary frames are kept
  as their size unless a serializer is set, and `Blob` frames always are (use
  `binaryType = 'arraybuffer'` to record them). Closes record the initiator,
  code and reason. A `send` that throws (still connecting) is recorded for
  diagnosis only.
- **Bounds.** 64 KiB per frame, 1 MiB of frame payloads per 5-minute
  window, 32 sockets captured at once. Anything beyond is `truncated`,
  metadata only, or not captured. It is listed as a gap on the dependency,
  which makes coverage `partial` and adds a `dependency.ws` eligibility entry.
- **Clock.** Events recorded in one task (a message and the send it
  triggers, frames delivered together) share a timestamp. Replay then orders
  them by their recorded order, never by rounding.
- **Replay.** Before the app starts, a capsule that needs an adapter this
  build doesn't have (or a schema it doesn't support) ends `incompatible`
  with `dependency.unsupported` (or `dependency.schema`). So does one with a
  socket open at a periodic checkpoint (`dependency.unrestorable`).
  `WebSocket` is then an in-memory socket with the browser API: ready states,
  `on*` handlers and listeners, `binaryType`, `bufferedAmount`, `protocol`,
  and `send`/`close` validation. Connects are matched by key and occurrence,
  sends and client closes by order. Recorded server events are delivered
  their recorded delay after the operation that released them, and equal
  times go in recorded order. Idle compression never skips past a due
  delivery, and an open but quiet socket doesn't hold replay up.
- **Divergences.** A connection or send the recording doesn't have reports
  `ws.unrecorded` and fails like a network error: an `error` event, then
  close 1006. This also happens when the capsule has no WebSocket recording
  at all, and when the app didn't set up the integration, so replay never
  opens a real socket. A send that differs from the recording reports
  `ws.mismatch`. A message without a replayable payload reports
  `ws.noPayload`. Recorded events left unused report `ws.unused`, or
  `ws.unusedAfterFailure` after the failure, which is expected. All except
  the last make an attempt invalid, so they can't produce a "fixed" verdict.
  The runner also blocks real sockets that escaped the page's `WebSocket`
  (workers, early references) and reports `dependency.live`.
- **Switching it off.** Your project's capture settings can disable the
  adapter (`bugcapsule-web.websocket`). Capture of new sockets stops,
  buffered WebSocket events are dropped, and HTTP and other capture continue.

## Storage and uploads

- IndexedDB (`bugcapsule` database) holds the upload outbox (10 capsules /
  10 MiB / 7 days, oldest evicted first), the newest 20 saved captures and the
  cached remote configuration. When IndexedDB is blocked by privacy settings,
  the SDK keeps them in memory.
- Writes are single IndexedDB transactions. Quota errors, corrupt records and
  unavailable storage drop the capsule, never the app.
- Queues survive reloads. Several tabs share one queue and only one uploads at
  a time (Web Locks, or a lease record on insecure origins without them).
- Uploads retry from 30 s to 1 h with jitter and honour `Retry-After`; a
  server deadline also survives reloads. Nothing relies on an upload
  finishing while the page unloads: the next page load uploads.
- Uploads need a remote configuration fetched within the last 7 days. The
  project kill switch purges the queue and saved captures and stays on across
  reloads. A rejected token or ingest key stops capture for the page session.
- Your app's origin must be allowed for your BugCapsule project, or the
  browser blocks the requests (CORS errors in the console).

## Replay runner

Each attempt opens a fresh browser context (isolated storage), sized like
the recording, and the app's own SDK (`allowReplay: true`) drives the replay.
The CLI refuses to start when something already serves `web.url`, because it
might be an old build. Runner details: [`packages/web-replay`](../packages/web-replay).

Replay activates only when the app passes `allowReplay: true` *and* the page
was opened by the runner (Playwright bindings). In a build with
`allowReplay: true`, a script already running in the page could imitate the
runner's bindings, which is one more reason to keep such builds out of
production.

## Limitations

- Lifecycle replay is synthetic (`partial`). `Date.now()`, timers, animations
  and `Math.random()` are not virtualized; use `BugCapsule.now()` /
  `BugCapsule.random()`.
- Hover-only interactions are not recorded (moves are recorded only while a
  pointer is pressed). Keyboard input is replayed only through tracked inputs.
- WebSockets are captured only with `webSocketIntegration()` and only in
  the page realm. Sockets in workers, iframes or other realms aren't
  captured, nor are sockets created before `BugCapsule.init` or through a
  `WebSocket` reference taken before it. Ping/pong and frame-level details
  aren't recorded. Binary frames need a serializer, and `Blob` frames are
  always recorded as their size.
- EventSource payloads, service workers (blocked during replay),
  `navigator.sendBeacon` and third-party iframes are not captured.
- A fix that makes the app send requests the recording never saw cannot be
  verified as `FIXED`: strict replay reports `network.unrecorded` and the
  verdict is `INCONCLUSIVE`. Capture a capsule that covers the fixed path.
- Synchronous XHR is replayed without its recorded latency.
- Cross-origin script errors without CORS headers arrive as `Script error.`.
- Capsules replay only in the web runtime (no cross-runtime replay).
- Replay runs in Chromium only.
- Monitoring: the active span of `startSpan` is shared page-wide while async
  work runs (browsers have no async context), and the final session update
  sent during unload is not confirmed (its queued copy is retried on the next
  load). See [monitoring.md](monitoring.md#limitations).
