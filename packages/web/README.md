# @bugcapsule/web

The BugCapsule SDK for the browser. It records what led up to a bug as a
portable `.bugcapsule` file you can replay against your real app, verify a fix
against, and keep as a regression test. It also reports errors, release
health, performance traces and user feedback. No framework, no dependencies,
TypeScript types included.

```bash
npm install @bugcapsule/web
```

```ts
import { BugCapsule } from '@bugcapsule/web';

await BugCapsule.init({ token: 'bcsdk.v1.…' });   // SDK token from the BugCapsule dashboard
renderApp();
```

> SDK tokens arrive in the release after `0.4.0-beta.1`. On `0.4.0-beta.1`,
> pass `backend: { url: 'https://api.bugcapsule.com', ingestKey: 'bci_…' }`
> instead of `token`.

**Get started:** [Web SDK guide](https://docs.bugcapsule.com/web.html) ·
[README with the full setup](https://github.com/BugCapsule/bug_capsule_web_sdk#readme) ·
[Monitoring options](https://github.com/BugCapsule/bug_capsule_web_sdk/blob/main/docs/monitoring.md)

## Entry points

- `@bugcapsule/web`: `BugCapsule` (capture, `status()`, `captureException`,
  `captureMessage`, `captureFeedback`, scope, `startTransaction` /
  `startSpan`, `showFeedbackWidget`, `flush`), the integrations
  (`networkIntegration`, `fetchIntegration`, `xhrIntegration`,
  `historyIntegration`, `localStorageIntegration`,
  `sessionStorageIntegration`, `indexedDbIntegration`, `sentryCompanion`) and
  types.
- `@bugcapsule/web/core`: the environment-neutral capsule model, codec with
  bounded decoding, validator, redaction, request keys, flight recorder and
  replay protocol types. Works in browsers, workers and Node.

Related packages: [`@bugcapsule/react`](https://www.npmjs.com/package/@bugcapsule/react),
[`@bugcapsule/web-replay`](https://www.npmjs.com/package/@bugcapsule/web-replay),
[`@bugcapsule/cli`](https://www.npmjs.com/package/@bugcapsule/cli).

## Using BugCapsule with Sentry

If the app already uses Sentry for errors, keep it: Sentry stays the error
and issue tool, and BugCapsule captures the replayable capsule for the same
failure. The `sentryCompanion()` integration (since 0.4.0-beta.1)
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
npm install @bugcapsule/web @sentry/browser
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
  token: 'bcsdk.v1.…',                      // SDK token from the BugCapsule dashboard
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
