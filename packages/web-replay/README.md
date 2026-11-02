# @bugcapsule/web-replay

The Playwright (Chromium) runner the `bugcapsule` CLI launches for each web
replay attempt. You don't run it yourself: install it as a dev dependency of
your app and the CLI finds it in `node_modules`.

```bash
npm install -D @bugcapsule/web-replay@beta
npx playwright install chromium
```

Replay guide: [docs.bugcapsule.com/web](https://docs.bugcapsule.com/web.html) ·
[CLI reference](https://docs.bugcapsule.com/cli.html)

## How it works

```
bugcapsule-web-runner --replay-url <armed attempt url> --app-url <app url> [--allow-origin <origin>]... [--allow-live <url substring>]... [--headed] [--timeout <s>]
```

Per attempt it loads the capsule and settings from the CLI (loopback,
per-attempt token), opens the app in a fresh Chromium context sized like the
recording, seeds web storage before any page script (only keys the
capsule's recorded `storagePolicy` allows; other keys, and every key of a
capsule without a policy, are skipped and reported as `restore.disallowed`),
lets the app's own SDK (`allowReplay: true`) replay inputs and serve recorded
responses, dispatches pointer input as trusted browser input, and posts the
report back (with a `BUGCAPSULE_RESULT::` stdout fallback). Uses the Chromium
build installed for `playwright-core` 1.63 (`npx playwright install
chromium`), or `BUGCAPSULE_CHROMIUM=/path/to/chrome`.

### Network during replay: deny by default

A replay never talks to a real server. From the app's origin (and any
`--allow-origin`) the page may only load static resources: `GET`/`HEAD`
requests for documents, scripts, stylesheets, images, fonts and media.
Everything else (fetch and XHR the SDK did not serve, `sendBeacon`,
`EventSource`, form posts, other methods, requests from workers, and requests
to any other origin) is aborted and reported as a `network.escaped`
divergence. Real WebSockets are always blocked (`network.escaped`, or
`dependency.live` when the capsule declares a WebSocket dependency); the
SDK's `webSocketIntegration()` serves recorded sockets in the page. These
divergences are material: the attempt cannot count as clean.

`--allow-live <url substring>` (repeatable) is an explicit escape hatch: a
request or WebSocket whose URL contains the substring reaches the real
network, is logged, and is reported as `replay.unsafe_live`. A run with any
such attempt is **UNSAFE** (exit code 5), even if it reproduced the failure,
so use it only to debug the replay setup. Reports also carry the page's
verdict v2 `evidence` unchanged. A dev server's live-reload socket is blocked
too; replay against a production-style build.
