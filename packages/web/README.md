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
