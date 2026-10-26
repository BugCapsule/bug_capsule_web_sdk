# BugCapsule Web SDK

BugCapsule records what led up to a bug in your web app and saves it as a
portable `.bugcapsule` file. A developer can **replay** that file against the
real app in Chromium, **verify** a fix against it, and keep it as a
**regression test**. The same SDK also reports errors, release health,
performance traces and user feedback, and links each error to the capsule that
replays it.

```
QA hits a bug      ─► capsule captured, redacted on the device, uploaded
bugcapsule run     ─► REPRODUCED 3/3   (Playwright drives your real app)
fix the code
bugcapsule verify  ─► FIXED 3/3
bugcapsule regress ─► runs in CI from now on
```

📖 Full documentation: **[docs.bugcapsule.com/web](https://docs.bugcapsule.com/web.html)**

## Contents

- [Packages](#packages)
- [Requirements](#requirements)
- [Install](#install)
- [Connect your app](#connect-your-app)
- [Make bugs replayable](#make-bugs-replayable)
- [Replay, verify and keep a regression test](#replay-verify-and-keep-a-regression-test)
- [Monitoring](#monitoring)
- [Privacy](#privacy)
- [Going to production](#going-to-production)
- [Supported browsers](#supported-browsers)
- [Limitations](#limitations)
- [Demo app](#demo-app)
- [More documentation](#more-documentation)
- [Support and license](#support-and-license)

## Packages

| Package | What it is |
|---|---|
| [`@bugcapsule/web`](packages/web) | The SDK. No framework, no dependencies, TypeScript types included. `@bugcapsule/web/core` holds the environment-neutral capsule model, codec and redaction. |
| [`@bugcapsule/react`](packages/react) | React hooks and components: actions, tracked inputs and state, error boundary, capture button, feedback widget, React Router listener. |
| [`@bugcapsule/web-replay`](packages/web-replay) | The Playwright runner the `bugcapsule` CLI starts for each replay attempt. Dev dependency. |
| [`@bugcapsule/cli`](packages/cli) | Build tooling: injects debug ids and uploads source maps so minified stack traces become readable. |
| [`examples/shop`](examples/shop) | A React demo shop with four planted bugs. |

## Requirements

- A BugCapsule project. Sign in at [app.bugcapsule.com](https://app.bugcapsule.com).
- A modern browser for capture. Replay runs in Chromium.
- Node 20+ for the replay runner and the source-map CLI.
- React 18+ for `@bugcapsule/react`. React Router 6.4+ for the route listener (optional).
- The `bugcapsule` CLI for replay ([install it](#install-the-cli)).

## Install

```bash
npm install @bugcapsule/web@beta @bugcapsule/react@beta     # @bugcapsule/react only for React apps
npm install -D @bugcapsule/web-replay@beta             # only where you run `bugcapsule run` / `verify`
npm install -D @bugcapsule/cli@beta                    # only for source-map upload in CI
```

Install `@bugcapsule/web` and `@bugcapsule/react` at the same version: the React
package needs that exact version as a peer dependency.

> **Versions.** SDK tokens and connection status are available starting with `0.4.0-beta.2`.
> Existing explicit backend configuration remains supported.

## Connect your app

### 1. Get an SDK token

In the dashboard, open **Project settings → Keys → SDK tokens** and generate a
token. It looks like `bcsdk.v1.…` and is shown once, so copy it right away.

The SDK token is the only value your app needs. It holds your BugCapsule
address and a send-only credential: it can upload capsules and events and read
capture settings, nothing else. That makes it safe to ship in a browser bundle.
You can rotate or revoke it in the dashboard at any time.

### 2. Initialize the SDK first

```ts
// main.ts: the first thing your app does
import { BugCapsule } from '@bugcapsule/web';

await BugCapsule.init({ token: 'bcsdk.v1.…' });
renderApp();
```

That is a complete connection. A few rules:

- **Await `init` before you render.** In replay, `init` restores storage and
  state before your app reads it.
- **Call it before any code keeps its own reference to `fetch`.** Code that
  grabbed `fetch` earlier bypasses capture and replay.
- **It never breaks your app.** A wrong, revoked or unreachable token never
  throws and never delays startup; the app simply runs without BugCapsule.

### 3. Get your origin allowed

Browsers only let the SDK reach BugCapsule from origins your project allows.
Send your BugCapsule contact the exact origins your app runs on, including
scheme and port (for example `https://app.example.com` and
`http://localhost:5173`). Until an origin is allowed, the browser console shows
CORS errors and nothing is uploaded.

### 4. Check the connection

```ts
const { connection, instrumentation } = BugCapsule.status();
connection.state;                   // 'connected' once the configuration was fetched
connection.firstCapsuleAcceptedAt;  // set once a capsule reached your project
connection.firstEventAcceptedAt;    // set once a monitoring event arrived
instrumentation.missing;            // replay adapters you have not added yet
```

| `connection.state` | Meaning | What to do |
|---|---|---|
| `connecting` | No configuration fetched yet in this page session. | Wait a moment. |
| `connected` | The configuration was fetched: address, token and network work. | Nothing. |
| `offline` | BugCapsule can't be reached. Data stays in the outbox and is retried. | Check the network and the console for CORS errors. |
| `rejected` | The token was refused. `reason` is `token_revoked`, `token_expired` or `token_unknown`; `message` says what to do. Capture stops for this page session. | Generate a new token. |
| `invalid_token` / `unsupported_token_version` | The token can't be read: damaged, a key pasted instead, or made for a newer SDK. One `[bugcapsule]` console line says why. | Paste the full `bcsdk.v1.…` token, or update the SDK. |
| `disabled` | `enabled: false`, or capture is switched off for the project. | — |

The dashboard's onboarding shows the same two confirmations: **configuration
fetched** (the app reached BugCapsule) and **first event or capsule received**
(captured data arrived).

### Connect with an address and ingest key

For self-hosted setups, older SDK versions, or apps that already pass an
address explicitly:

```ts
await BugCapsule.init({
  backend: { url: 'https://api.bugcapsule.com', ingestKey: 'bci_…' },
});
```

`backend` wins when both `backend` and `token` are set. The ingest key is
public like the token. **Never put a `bcs_…` secret key in an app.**

## Make bugs replayable

Being connected is not the same as faithful replay. Replay also needs your
app's network, navigation and state. Add them as you go;
`BugCapsule.status().instrumentation.missing` tells you what is left.

```ts
import {
  BugCapsule,
  networkIntegration,
  historyIntegration,
  localStorageIntegration,
} from '@bugcapsule/web';

await BugCapsule.init({
  token: 'bcsdk.v1.…',
  appVersion: '1.4.0',
  appBuild: '52',
  mode: 'qa',                                  // 'debug' | 'qa' | 'production' (sampled, the default)
  gitSha: import.meta.env.VITE_BUGCAPSULE_GIT_SHA,
  integrations: [
    // Fields that change on every run must not affect request matching.
    networkIntegration({ rules: [{ method: 'POST', path: '/api/checkout', ignoreBodyFields: ['timestamp', 'nonce'] }] }),
    historyIntegration(),
    localStorageIntegration({ allowPrefixes: ['shop.'] }),
  ],
  // Replay only in dev and test builds. Keep this false in production.
  allowReplay: import.meta.env.DEV || import.meta.env.VITE_BUGCAPSULE_ALLOW_REPLAY === 'true',
});
```

> Leaving out `mode` means `'production'`, which records only a sample of
> sessions (10% by default). Use `'qa'` in QA builds so every session records.

### Hooks that make more bugs reproducible

| Add this | Why |
|---|---|
| `onClick={BugCapsule.action('cart.checkout', checkout)}` and `data-bugcapsule-action="cart.checkout"` | Replay can invoke the action by id; the attribute is also a stable selector for click replay. |
| `BugCapsule.trackInput('login.email', inputEl)`, or `useTrackedInput` / `useTrackedState` in React | Typed text is replayed. Password inputs, `data-bugcapsule-sensitive` elements and `sensitive: true` are recorded as `[REDACTED]`. |
| `BugCapsule.check('cart_total_non_negative', total >= 0)` / `BugCapsule.fail(id)` | Wrong behaviour that doesn't throw becomes a failure replay can check. |
| `BugCapsule.reportError(e)` / `<BugCapsuleErrorBoundary>` | Errors your code or React catches never reach `window.onerror`. |
| `BugCapsule.registerState('cart', { serialize, restore })` / `useBugCapsuleState` | Your app's own state is saved in checkpoints and restored in replay. |
| `indexedDbIntegration([{ name, snapshot, restore }])` | Your IndexedDB stores, through adapters you write. The SDK never reads IndexedDB on its own. |
| `BugCapsule.now()` / `BugCapsule.date()` instead of `Date.now()` | Replay returns the recorded time. |
| `BugCapsule.random()` instead of `Math.random()` | Seeded per session, same seed in replay. |

### React

```tsx
import { BugCapsuleErrorBoundary, BugCapsuleCaptureButton } from '@bugcapsule/react';
import { BugCapsuleRouteListener } from '@bugcapsule/react/react-router';

<BrowserRouter>
  <BugCapsuleRouteListener />                {/* route changes, named transactions */}
  <BugCapsuleErrorBoundary fallback={<Oops />}>
    <Routes>…</Routes>
  </BugCapsuleErrorBoundary>
  <BugCapsuleCaptureButton />                {/* QA builds only; hidden in production mode */}
</BrowserRouter>
```

See [`packages/react`](packages/react) for every hook and component.

### What is captured

| Area | Captured | In replay |
|---|---|---|
| Pointer (mouse, touch, pen) | presses, releases, moves while pressed, plus the target element | Real browser input at the recorded coordinates |
| Actions | `BugCapsule.action` / `useBugCapsuleAction` | Invoked by id |
| Text | tracked inputs only | Value set and `input`/`change` dispatched |
| Navigation | History API, hash changes, React Router | Reproduced by the inputs |
| Errors and assertions | `error`, `unhandledrejection`, `reportError`, error boundary, `check` / `fail` | Matched by signature or id |
| Network | `fetch` and `XMLHttpRequest` | Recorded responses served with the recorded latency, status and errors |
| WebSockets (opt-in, `webSocketIntegration()`) | connects, opens, sends, messages, errors and closes of `WebSocket` in the page | An in-memory socket replays the recorded server side; nothing connects for real |
| Storage | allowlisted `localStorage` / `sessionStorage` keys, IndexedDB adapters, registered state | Restored before your app renders |

**Never captured:** untracked input values, DOM content, cookies, storage
outside your allowlist, password inputs.

Details on request matching, body limits and storage:
[docs/how-it-works.md](docs/how-it-works.md).

### WebSockets

WebSocket capture is opt-in. Add the integration next to the others:

```ts
import { webSocketIntegration } from '@bugcapsule/web';

integrations: [networkIntegration(), webSocketIntegration()],
```

- Connection URLs are redacted. Text frames go through the same redaction as
  JSON bodies. A frame that redaction changed is not replayed (pass
  `redactedReplayable: true` when your app doesn't branch on those fields).
- Binary frames are recorded as their size only. Replay can't deliver those,
  and verification reports them. To keep them, pass a serializer:
  `webSocketIntegration({ binary: { decode, encode } })`.
  `rawBinarySerializer` keeps bytes as they are, without redaction.
- Limits: 64 KiB per frame, 1 MiB of frames per 5 minutes, and 32 sockets
  open at once. Anything beyond that is recorded as a gap, so such a capsule
  can't verify a fix.
- In replay, `WebSocket` is an in-memory socket. Connections are matched by
  URL (minus `ignoreQuery` parameters) and by order. Sends are compared with
  the recording. Server messages arrive in recorded order with their recorded
  delays. A connection the recording doesn't have fails like a network error
  (close code 1006).
- Your project's capture settings can switch off WebSocket capture
  (adapter `bugcapsule-web.websocket`) without affecting the rest.
- Capsules with WebSockets use capsule format v2. Update the CLI and the
  other BugCapsule tools before you turn the integration on.
- Tested in Chromium 153, Firefox 155 and WebKit 26.6 (Playwright 1.63).

## Replay, verify and keep a regression test

### Install the CLI

The `bugcapsule` CLI replays capsules from every BugCapsule SDK. It is a Dart
tool shipped in the Flutter package, so it needs
[Flutter](https://docs.flutter.dev/get-started/install) installed even for web
projects.

```bash
dart pub global activate bug_capsule 0.4.1-beta.2
bugcapsule --version
```

If the shell can't find `bugcapsule`, add `~/.pub-cache/bin` to your `PATH`.

Log in with a personal token from **Project settings → Keys & CLI access**.
In CI, use a service token in `BUGCAPSULE_TOKEN` instead.

```bash
bugcapsule login --url https://api.bugcapsule.com --token bcp_…
```

### Configure replay

Add a `bugcapsule.json` next to your app's `package.json`:

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

### Run it

```bash
bugcapsule list                         # capsules in your project
bugcapsule inspect <id>                 # failure, eligibility, network, timeline
bugcapsule run <id> -n 3                # builds the capsule's commit, serves it, replays in Chromium
bugcapsule verify <id> -n 3             # builds your working tree; FIXED when the bug is gone
bugcapsule regress add <id>             # keep it as a regression test
bugcapsule regress run                  # in CI: exit 1 when a regression fails
bugcapsule run <id> --app-url http://127.0.0.1:4317/   # replay against a build that is already running
```

Each attempt opens a fresh browser context sized like the recording. The CLI
refuses to start when something already serves `web.url`, because it might be
an old build. See the [CLI reference](https://docs.bugcapsule.com/cli.html)
and [how verdicts work](https://docs.bugcapsule.com/verdicts.html).

**Replay is off in production.** It only turns on when your app passes
`allowReplay: true` *and* the page was opened by the replay runner. Tie
`allowReplay` to a dev or test build flag. With it `false`, nothing in the
page (URLs, storage, messages, scripts) can turn replay on.

## Monitoring

The same `init` also turns on monitoring for every page load, not only for
sessions that record a capsule:

| Signal | What you get |
|---|---|
| Errors | Uncaught errors and rejections, `reportError`, `check`/`fail`, React error boundaries, `captureException` / `captureMessage`; stack frames, breadcrumbs, user and tags |
| Release health | One session per page load, marked `crashed` on an unhandled error |
| Performance | Pageload and navigation transactions, `fetch`/XHR spans, web vitals (LCP, INP, CLS, FCP, TTFB), custom spans |
| User feedback | `captureFeedback`, and an optional themeable widget |

When a capsule is written for an error, the error links to it, so each issue
lists the capsules that replay it.

```ts
await BugCapsule.init({
  token: 'bcsdk.v1.…',
  release: 'shop-web@1.4.0+52',
  tracesSampleRate: 0.2,
  tracePropagationTargets: ['api.example.com'],   // default: same origin only
});

BugCapsule.setUser({ id: user.id });
BugCapsule.captureException(error);
```

`monitoring: false` turns monitoring off; capsules keep working. All options:
[docs/monitoring.md](docs/monitoring.md).

**Readable stack traces.** Upload source maps from CI with
[`@bugcapsule/cli`](packages/cli):

```bash
npx bugcapsule-cli sourcemaps inject dist
BUGCAPSULE_SECRET_KEY=bcs_… npx bugcapsule-cli sourcemaps upload dist \
  --url https://api.bugcapsule.com --release shop-web@1.4.0+52
```

### Already using Sentry?

Keep it. Add `sentryCompanion()` to `Sentry.init` and set `monitoring: false`
in `BugCapsule.init`. Each Sentry error then carries a `bugcapsule.capsule_id`
tag pointing to the capsule that replays it. Setup and details:
[Using BugCapsule with Sentry](packages/web/README.md#using-bugcapsule-with-sentry).

## Privacy

Redaction runs in the browser before anything is stored or uploaded:
sensitive keys in bodies, storage and state; sensitive headers; credentials in
URLs; and tokens, JWTs, API keys and card numbers in free text.

Tighten it with `redactKeys`, `redactHeaders`, `redactPatterns`,
`beforeRecord`, `beforeCheckpoint`, `networkIntegration({ exclude })` and
`historyIntegration({ sanitizeLocation })`. Your project settings can also add
redaction keys, turn off body capture, lower sampling or switch capture off
remotely.

Redaction is pattern-based. It does **not** find personal data that isn't a
credential (names, emails, addresses) or secrets in URL paths. Inspect real
capsules with `bugcapsule inspect` before a wider rollout. More:
[Privacy and redaction](https://docs.bugcapsule.com/privacy.html).

## Going to production

- Use `mode: 'production'` with a deliberate `productionSampleRate` (default `0.1`).
- Keep `allowReplay` `false` in production builds.
- Learn the kill switch before you need it: `bugcapsule capture --on` stops capture
  for every client. `bugcapsule capture --off` resumes it.
- Upload source maps for every release, then remove the `.map` files from the deployment.
- Read the [production checklist](https://docs.bugcapsule.com/production.html).

Data waits in an IndexedDB outbox (10 capsules / 10 MiB / 7 days), survives
reloads, and is shared safely between tabs. Storage errors drop a capsule,
never your app.

## Supported browsers

| Browser | Capture | Replay |
|---|---|---|
| Chrome, Edge, other Chromium | Supported and tested | Supported and tested |
| Firefox, Safari | Uses only standard APIs; covered by the browser test suite but not certified | Not supported |

## Limitations

- `Date.now()`, timers, animations and `Math.random()` are not virtualized; use
  `BugCapsule.now()` and `BugCapsule.random()`.
- Hover-only interactions aren't recorded. Keyboard input is replayed only for
  tracked inputs.
- WebSockets are captured only with `webSocketIntegration()`, and only in
  the page itself. Sockets in workers or iframes aren't captured, nor are
  sockets opened before `BugCapsule.init` or through a `WebSocket` reference
  taken before it. EventSource, service workers, `navigator.sendBeacon` and
  third-party iframes are not captured.
- Replay is strict: a request the recording never saw fails like a network
  error. A fix that sends new requests verifies as `INCONCLUSIVE`; capture a
  capsule that covers the fixed path.
- Capsules replay only in the web runtime.

Full list: [docs/how-it-works.md#limitations](docs/how-it-works.md#limitations).

## Demo app

[`examples/shop`](examples/shop) is a React shop with four planted
"can't reproduce" bugs (a race, a stale cache, bad server data and a wrong
total) to try the whole capture → replay → verify loop.

## More documentation

| Topic | Where |
|---|---|
| Web SDK guide | [docs.bugcapsule.com/web](https://docs.bugcapsule.com/web.html) |
| Quickstart (30 minutes, capture to verified fix) | [docs.bugcapsule.com/quickstart](https://docs.bugcapsule.com/quickstart.html) |
| CLI reference | [docs.bugcapsule.com/cli](https://docs.bugcapsule.com/cli.html) |
| Monitoring options | [docs/monitoring.md](docs/monitoring.md) |
| How capture, replay and uploads work | [docs/how-it-works.md](docs/how-it-works.md) |
| Troubleshooting | [docs.bugcapsule.com/troubleshooting](https://docs.bugcapsule.com/troubleshooting.html) |
| Working on this repository | [docs/development.md](docs/development.md) |

## Support and license

Questions or access requests: [contact@bugcapsule.com](mailto:contact@bugcapsule.com).

This SDK is proprietary software of Bug Capsule. Use, copying, modification
and distribution require prior written permission. See [LICENSE](LICENSE).

## Optional capsule screenshots (unreleased)

Opt-in PNG frames are stored inside capsules and displayed against event time.
See [capture, privacy, limits and platform examples](docs/screenshots-v1.md).
