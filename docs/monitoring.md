# Monitoring (errors, release health, tracing, feedback)

Besides capsules, the web SDK sends light, high-volume monitoring signals to
BugCapsule with the same SDK token (or ingest key). Overview for every
platform: [docs.bugcapsule.com/monitoring](https://docs.bugcapsule.com/monitoring.html).



| Signal | Envelope item | What the SDK does |
|---|---|---|
| Errors and messages | `event` | `error`, `unhandledrejection`, `reportError`, `check`/`fail`, React error boundary, opt-in `console.error`, `captureException` / `captureMessage`; stack frames, debug images, breadcrumbs, scope |
| Release health | `session` | one session per page load, ended on `pagehide` |
| Performance | `transaction` | pageload and navigation transactions, fetch/XHR, resource and long-task spans, web vitals, custom spans, `traceparent` / `baggage` |
| User feedback | `feedback` | `captureFeedback` and an opt-in widget |

When a capsule is written for a failure, the error event carries the capsule's
`capsuleId` and the capsule carries `manifest.monitoring = {eventId, traceId,
release, environment}`, so the issue lists the capsules that replay it.

Monitoring is on whenever a `token` or `backend` is configured. `monitoring: false`
turns it off (capsules unaffected); your project settings can turn it off remotely,
and the project's kill switch stops everything. Nothing is sent during replay.

Apps that use Sentry for monitoring can turn BugCapsule monitoring off and
link capsules to Sentry events instead: see
[Using BugCapsule with Sentry](../packages/web/README.md#using-bugcapsule-with-sentry).

## Setup

```ts
import { BugCapsule, networkIntegration, historyIntegration } from '@bugcapsule/web';

await BugCapsule.init({
  appVersion: '1.4.0',
  appBuild: '52',
  mode: 'production',
  token: 'bcsdk.v1.…',
  integrations: [networkIntegration(), historyIntegration()],

  release: 'shop-web@1.4.0+52',       // match what `sourcemaps upload --release` uses
  environment: 'production',          // default from mode: production | qa | development (debug)
  tracesSampleRate: 0.2,              // the backend's tracesSampleRate overrides it
  tracePropagationTargets: ['api.example.com', /^https:\/\/pay\./],
  beforeSend: (event) => (event.exception?.values.at(-1)?.type === 'ChunkLoadError' ? null : event),
});

BugCapsule.setUser({ id: user.id, segment: user.plan });
```

Your app's origin must be allowed for your BugCapsule project (send the exact
origins to your BugCapsule contact; envelopes over 1 KiB are sent gzipped with a
`Content-Encoding` header). APIs
on other origins listed in `tracePropagationTargets` must allow the
`traceparent` and `baggage` request headers in their CORS configuration.

## Options

| Option | Default | |
|---|---|---|
| `monitoring` | `true` | `false`: no envelopes at all |
| `release`, `dist` | none | `release` ≤ 200 chars |
| `environment` | from `mode` | `production`, `qa`, `development` |
| `errorSampleRate` | `1` | the lower of this and the backend's; `fatal` and capsule-linked events are always sent |
| `tracesSampleRate` | `0` | the backend's `tracesSampleRate` replaces it unless `tracesSampler` is set |
| `tracesSampler(context)` | none | `{name, op, parentSampled?, location?}` → rate or boolean |
| `tracePropagationTargets` | same origin | substrings, `"/regex/"` strings or RegExps; the backend's list replaces it |
| `enableAutoSessionTracking` | `true` | the backend's `sessionTracking: false` also turns sessions off |
| `crashOnUnhandled` | `true` | an unhandled error marks the session `crashed` |
| `maxBreadcrumbs` | `100` | the lower of this and the backend's, at most 100 |
| `beforeSend(event, hint)` | none | return `null` to drop; `hint.originalException` is the thrown value |
| `beforeSendTransaction(t)` | none | |
| `beforeBreadcrumb(b, hint)` | none | |
| `inAppIncludes` / `inAppExcludes` | none | substrings or RegExps on the script URL; includes win |
| `attachStacktrace` | `false` | stack trace (as the current thread) on `captureMessage` events |
| `sendDefaultPii` | `false` | `true`: `user.ipAddress: "{{auto}}"` (kept only with the project's `storeIpAddresses`) |
| `enableWebVitals` | `true` | LCP, INP, CLS, FCP, TTFB |
| `enableUserInteractionTracing` | `false` | `ui.action.click` transactions for clicks outside pageload/navigation |
| `captureConsoleErrors` | `false` | `console.error` → error event (mechanism `logging`) |
| `consoleBreadcrumbs` | `true` | console calls → breadcrumbs |
| `captureCapsuleWithFeedback` | `true` in `qa` | feedback also writes a capsule (recording sessions only) |
| `envelopeOutboxLimits` | 30 / 5 MiB / 7 days | |

## API

```ts
BugCapsule.captureException(error, { level, tags, extra, fingerprint, contexts, user }); // → eventId
BugCapsule.captureMessage('payment provider slow', 'warning');                            // → eventId
BugCapsule.reportError(error);           // a failure: capsule (when recording) + event, linked
BugCapsule.lastEventId();

BugCapsule.setUser({ id, email, username, segment }); // null clears
BugCapsule.setTag('screen', 'checkout'); BugCapsule.setTags({ … });
BugCapsule.setExtra('cartSize', 3);       BugCapsule.setExtras({ … });
BugCapsule.setContext('order', { id });   // null removes
BugCapsule.setLevel('warning');
BugCapsule.setFingerprint(['{{ default }}', 'payments']);
BugCapsule.addBreadcrumb({ category: 'cart', message: 'coupon applied', data: { code } });
BugCapsule.clearBreadcrumbs();
BugCapsule.withScope((scope) => { scope.setTag('flow', 'pay'); BugCapsule.captureException(e); });
BugCapsule.configureScope((scope) => scope.setTag('tenant', id));

const tx = BugCapsule.startTransaction({ name: 'checkout', op: 'task' }); // active until finished
const span = tx.startChild({ op: 'serialize', description: 'cart' }); span.setData('items', 3); span.finish();
tx.setStatus('ok'); tx.finish();
await BugCapsule.startSpan({ name: 'load cart', op: 'task' }, async (span) => { … });
BugCapsule.getActiveSpan();
BugCapsule.getTraceparent(); BugCapsule.getBaggage();   // for WebSocket / worker messages
BugCapsule.continueTrace(traceparent, baggage);         // <meta name="traceparent"> is read automatically

BugCapsule.startSession(); BugCapsule.endSession();     // manual control (automatic by default)

BugCapsule.captureFeedback({ message, name, email, eventId, url, tags, captureCapsule }); // → feedbackId
const widget = BugCapsule.showFeedbackWidget({ theme: { accent: '#0a7' }, position: 'bottom-left' });
widget.open(); widget.close(); widget.remove();

await BugCapsule.flush(2000);  // → true when everything queued was sent
await BugCapsule.close();      // ends the session, flushes, shuts the SDK down
```

`captureException` only sends an event. `reportError` treats the error as a
failure: it can trigger a capsule (in recording sessions) and sends the event
linked to it. Uncaught errors, unhandled rejections, `check`/`fail` and the
React error boundary go through `reportError`'s path.

## Errors

* **Mechanisms**: `onerror` and `unhandledrejection` (unhandled),
  `manual` (`captureException`, `reportError`, error boundary; handled),
  `assertion` (`check`/`fail`; grouped by assertion id, no stack), `logging`
  (`console.error`), `uncaught` (React 19 `onUncaughtError`).
* **Exceptions**: the thrown error and its `cause` chain (≤ 10), innermost
  cause first. Non-`Error` values become `String` / `Error` with a description.
* **Frames**: parsed from Chromium, Firefox and Safari stacks, oldest call
  first; `absPath` is the script URL, `filename` its path, `lineno`/`colno`
  1-based; `inApp` is true for same-origin scripts not under `node_modules`
  (Vite `/@vite/`, `.vite/deps`, webpack runtime excluded), adjusted by
  `inAppIncludes` / `inAppExcludes`. The server recomputes `inApp` after
  source-map symbolication.
* **Debug images**: one `sourcemap` image per script with a debug id
  injected by `@bugcapsule/cli sourcemaps inject`.
* **Contexts**: `browser`, `os`, `screen`, `culture`, `app`, `trace` (the
  active span, else the page's propagation context), plus `setContext`.
  `request` is the page URL with the user agent.
* **Dedupe**: an error identical to the previous event (type, value and
  frames) is sent once, except when it is linked to a capsule.

## Breadcrumbs

Derived from what the SDK already observes, so nothing is hooked twice:

| Source | Breadcrumb |
|---|---|
| Flight recorder (`action`, `log`, `state`, `lifecycle` events) | `user`/`ui.action`, `debug`/`log`, `state`, `navigation`/`app.lifecycle` |
| `networkIntegration` (or monitoring's own fetch/XHR hook when the app has none) | `http`, category `fetch` / `xhr`, method, redacted URL, status, duration |
| `historyIntegration`, `BugCapsule.route`, `BugCapsuleRouteListener` | `navigation` with `from` / `to` |
| Clicks | `user`/`ui.click` with a selector-like description (never the text) |
| Console | `debug`/`console` (`consoleBreadcrumbs`) |
| Earlier events | `error`/`bugcapsule.event` |

Tracked input values (`text` events) and pointer moves never become
breadcrumbs.

## Release health

One session per page load: an `init` update at start, an update on the first
error and when it crashes, and `exited` on `pagehide` (sent with
`keepalive` and also queued; the server deduplicates by `sid` + `seq`). A page
restored from the back/forward cache starts a new session. `did` is
`user.id` when set, else a random install id kept in IndexedDB. Sessions are
never sampled.

## Tracing

* **pageload** starts at navigation start (`performance.timeOrigin`), waits
  for `load`, and finishes after 1 s without open spans (at most 30 s).
  **navigation** starts on every path change (History API, React Router) and
  finishes the same way; one trace per navigation. Names are route patterns
  from `BugCapsuleRouteListener routes={…}` or the path with id-like segments
  replaced by `:id`.
* **Spans**: `http.client` for fetch/XHR (status mapped like
  OpenTelemetry), `resource.script|css|img|…`, `browser.request`,
  `browser.response`, `browser.dom_content_loaded`, `browser.load`,
  `browser.paint`, `mark`, `measure`, `ui.long-task`; custom spans with
  `startSpan` / `startChild`.
* **Web vitals** on the pageload transaction: `lcp`, `fcp`, `ttfb`, `cls`
  and, when there were interactions, `inp`. INP measured after the pageload
  finished is sent when the page is hidden, as a `ui.webvital.inp`
  transaction.
* **Sampling** is decided once per trace root and propagated. Unsampled
  traces still propagate (`traceparent` flag `00`).
* **Propagation**: requests to `tracePropagationTargets` (default same
  origin) get `traceparent` (unless the app set one) and `baggage` (merged
  with existing members). The capsule records requests as the app made them:
  request keys and recorded headers never include these headers, and replay
  never adds them.

## Feedback widget

`BugCapsule.showFeedbackWidget(options)` (or `<BugCapsuleFeedbackWidget />`
from `@bugcapsule/react`) adds a floating button that opens a form (name,
email, message). It lives in a shadow root, follows `prefers-color-scheme`
(`colorScheme: 'light' | 'dark' | 'auto'`), and is themed with `theme` /
`darkTheme` (`accent`, `accentForeground`, `background`, `foreground`,
`muted`, `border`, `radius`, `fontFamily`, `zIndex`). Labels are options
(`triggerLabel`, `title`, `submitLabel`, …); `showTrigger: false` hides the
button for your own trigger (`widget.open()`). The feedback is linked to
`lastEventId()` unless `attachLastEvent: false`. The widget is marked
`data-bugcapsule-ignore` and `data-bugcapsule-sensitive`.

## Privacy

Every item goes through the capsule redaction rules before it is written to
the outbox: sensitive keys (`password`, `token`, `authorization`,
`redactKeys`, the backend's keys …) in tags, extras, contexts, user data and
breadcrumb data; sensitive headers; URL user info and sensitive query
parameters in `request.url`, frame URLs, breadcrumb and span URLs; credentials
in free text (bearer tokens, JWTs, API keys, card numbers) in messages and
exception values; `redactPatterns`. Ids and timestamps are left alone. No IP
address is sent unless `sendDefaultPii: true`. `setUser({ email })` is sent as
given (it is not a credential); leave it out if you do not want it stored.

## Delivery

Envelopes are stored in their own IndexedDB store (`envelopes`, 30 envelopes
/ 5 MiB / 7 days, oldest evicted first), separate from the capsule outbox,
and sent oldest first by one tab at a time with the capsule outbox rules:
backoff 30 s → 1 h with jitter, `Retry-After` honoured (also across reloads),
rejected envelopes dropped, sending only with a remote config fetched within
`maxStaleConfigMs`. `monitoringEnabled: false` purges the queue. Delivery is
at least once; the server deduplicates by `eventId`, `sid` + `seq` and
`feedbackId`.

## Source maps

```bash
npx @bugcapsule/cli sourcemaps inject dist
BUGCAPSULE_SECRET_KEY=bcs_… npx @bugcapsule/cli sourcemaps upload dist \
  --url https://api.bugcapsule.com --release shop-web@1.4.0+52 --url-prefix '~/'
find dist -name '*.map' -delete    # do not deploy the maps
```

See [`packages/cli`](../packages/cli/README.md).

## Limitations

* Async context: the active span set by `startSpan` is visible to code that
  runs synchronously inside the callback and until its promise settles, but
  concurrent async work shares the page-wide scope (browsers have no async
  context). Spans created without an active span attach to the running
  pageload/navigation transaction.
* Requests made while the page unloads (the final session update) cannot be
  confirmed; the queued copy is retried on the next page load.
* Errors in cross-origin scripts without CORS headers arrive as `Script
  error.` without frames.
* Long tasks, LCP, INP and CLS need Chromium's PerformanceObserver entry
  types; other browsers send what they support.
