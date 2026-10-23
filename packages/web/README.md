# @bugcapsule/web

Framework-independent BugCapsule SDK for the browser, with TypeScript types.
Captures failures as portable `.bugcapsule` capsules (fetch/XHR, pointer,
actions, tracked inputs, navigation, errors, assertions, allowlisted storage,
registered state), queues them in IndexedDB and uploads them to the BugCapsule
backend; replays them against the real app with the `bugcapsule` CLI. Also
sends monitoring envelopes (error events, release-health sessions,
transactions and spans with web vitals, user feedback; see
[docs/monitoring.md](../../docs/monitoring.md)).

Entry points:

* `@bugcapsule/web`: `BugCapsule` (capsules, plus `captureException`,
  `captureMessage`, `captureFeedback`, scope, `startTransaction` /
  `startSpan`, `showFeedbackWidget`, `flush`), integrations (`networkIntegration`,
  `fetchIntegration`, `xhrIntegration`, `historyIntegration`,
  `localStorageIntegration`, `sessionStorageIntegration`,
  `indexedDbIntegration`), types.
* `@bugcapsule/web/core`: environment-neutral capsule model, codec with
  bounded decoding, validator, redaction, request keys, fixtures, flight
  recorder, replay protocol types (browser, workers, Node).

See the [repository README](../../README.md) for the quickstart and details.

## Using BugCapsule with Sentry

If the app already uses Sentry for errors, keep it: Sentry stays the error
and issue tool, and BugCapsule captures the replayable capsule for the same
failure. The `sentryCompanion()` integration (in source; not in the published 0.3.0 tarballs)
records each side's id on the other, so one Sentry event maps to one capsule
by id (never by message or time):

* the Sentry event gets the tags `bugcapsule.capsule_id` (when a capsule was
  scheduled) and `bugcapsule.capture`, and the context
  `contexts.bugcapsule = { capsule_id, capture }`;
* the capsule gets `manifest.links.sentry = { eventId, projectId, orgId,
  release, environment }` (`projectId` and `orgId` come from the DSN; `orgId`
  only for `o<digits>.ingest…` hosts).

The package has no dependency on `@sentry/*`: the companion is a plain
object shaped like a Sentry integration. It needs the integration hooks of
the Sentry JavaScript SDK v8 and later (`processEvent`); it was tested with
`@sentry/browser` 10.76.2.

### Install and set up

```bash
# Until the next release, build the SDK from this repository.
npm install && npm run build
npm pack -w @bugcapsule/web
# In your application, install the resulting tarball and Sentry:
npm install /path/to/bugcapsule-web-0.3.0.tgz @sentry/browser
```

```ts
import * as Sentry from '@sentry/browser';
import { BugCapsule, sentryCompanion, networkIntegration, historyIntegration } from '@bugcapsule/web';

Sentry.init({
  dsn: 'https://…@o123.ingest.sentry.io/4567',
  release: 'shop-web@1.4.0+52',
  integrations: [sentryCompanion()],        // or later: Sentry.addIntegration(sentryCompanion())
  beforeSend: (event) => event,             // your own beforeSend keeps working
});

await BugCapsule.init({
  appVersion: '1.4.0',
  appBuild: '52',
  mode: 'qa',
  gitSha: import.meta.env.VITE_BUGCAPSULE_GIT_SHA,
  backend: { url: 'https://bugcapsule.example.com', ingestKey: 'bci_…' },
  integrations: [networkIntegration(), historyIntegration()],
  monitoring: false,                        // Sentry is the monitoring tool
});
```

Initialization order does not matter: either SDK may be initialized first,
and either one's global `error` / `unhandledrejection` handler may run first.
One thrown error yields at most one BugCapsule failure, one capsule and one
link. Errors the app catches and passes to `Sentry.captureException(err)`
also get a capsule, even though BugCapsule never saw them; calling both
`Sentry.captureException(err)` and `BugCapsule.reportError(err)` for the same
error is fine (still one capsule).

`monitoring: false` is the recommended companion configuration: BugCapsule
then sends no error events, release-health sessions, transactions or
feedback of its own, and adds no `traceparent` / `baggage` headers, so errors
are not reported twice. Capsule capture, upload and replay work as before.
With monitoring left on, BugCapsule also sends its own event for failures
its handlers see (one per failure, linked to the same capsule), but not for
errors that only reached it through Sentry.

The companion does not set or wrap `beforeSend`, does not touch `fetch` or
`XMLHttpRequest`, and composes with your other integrations and event
processors. It never throws (on an internal error the event goes to Sentry
unchanged) and never waits for an upload: the capsule is written about
300 ms after the failure and uploaded in the background. BugCapsule's own
requests use the `fetch` it found at `BugCapsule.init`; if Sentry wrapped
`fetch` before that, Sentry's breadcrumbs can list those requests (URLs
only).

### `bugcapsule.capture` values

| Value | Meaning |
|---|---|
| `scheduled` | A capsule was scheduled for this failure; `bugcapsule.capsule_id` is its id. |
| `not_recording` | This session is not recording for another reason: capture setup failed or timed out, or `BugCapsule.init` had not finished. |
| `sampled_out` | A `production` session that sampling did not select (`productionSampleRate`, or the backend's sample rate). |
| `limit` | `maxCapsulesPerSession` was reached. |
| `duplicate` | The same failure (same failure signature this session, or the same thrown error already linked to another Sentry event) already had its capsule chance. |
| `replaying` | The app runs under the BugCapsule replay runner: no capsule, no link. |
| `disabled` | BugCapsule is not initialized, `enabled: false`, the backend kill switch is on, or `autoCaptureOnFailure: false`. |
| `not_a_failure` | `ignoreError` returned true for the error, or the event has no exception (for example `Sentry.captureMessage(…, 'error')`). |

Only error events are annotated (events with an exception or level `error`
/ `fatal`); transactions and other typed events are left alone. Tag keys and
values stay within Sentry's limits (32 / 200 characters).

### What the companion does not do

* No Sentry data is imported into BugCapsule; nothing recorded by BugCapsule
  is copied into Sentry (only the capsule id and the capture reason).
* No capsule without recording at failure time: redaction, sampling, the
  kill switch and the capture limits apply as usual. A capsule only covers
  what the session recorded before the failure.
* Web only: there are no Flutter, Android or iOS companions.
* `BugCapsule.fail` / `check` assertions are not Sentry events and are not
  linked.

### Limitations

* If a later step drops the Sentry event after the companion linked it (your
  `beforeSend`, an integration or event processor that runs after the
  companion, Sentry's `sampleRate` (applied after `beforeSend` in 10.76.2),
  rate limits or a transport failure), the capsule still carries
  `links.sentry.eventId` for an event Sentry never stored. Events Sentry
  drops before the companion runs (for example its `ignoreErrors` filters,
  set up before your integrations) get no link; an uncaught one can still
  get an unlinked capsule from BugCapsule's own handler.
* The link reaches the capsule only if Sentry processes the event before the
  capsule is written (about 300 ms after the failure). Event processors that
  delay the event longer, or a `Sentry.captureException(err)` for an error
  BugCapsule captured earlier, leave the tags on the Sentry event but no
  `links.sentry` in the capsule.
* Thrown non-objects (strings, numbers, `undefined`) cannot be told apart by
  identity; they are matched by failure signature for 5 seconds.
* In replay, failures Sentry reports are passed to the replay runner only if
  Sentry runs in that build. For caught errors that should reproduce in
  replay, also call `BugCapsule.reportError(err)`.
