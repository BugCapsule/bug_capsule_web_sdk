# @bugcapsule/web-replay

The Playwright (Chromium) runner the `bugcapsule` CLI launches for each web
replay attempt. Install it as a dev dependency of the app; the CLI finds it in
`node_modules`.

```
bugcapsule-web-runner --replay-url <armed attempt url> --app-url <app url> [--allow-origin <origin>]... [--headed] [--timeout <s>]
```

Per attempt it loads the capsule and settings from the CLI (loopback,
per-attempt token), opens the app in a fresh Chromium context sized like the
recording, restores allowlisted web storage before any page script, blocks
requests to origins other than the app's (`network.escaped`), lets the app's
own SDK (`allowReplay: true`) replay inputs and serve recorded responses,
dispatches pointer input as trusted browser input, and posts the report back
(with a `BUGCAPSULE_RESULT::` stdout fallback). Uses the Chromium build
installed for `playwright-core` 1.63 (`npx playwright install chromium`), or
`BUGCAPSULE_CHROMIUM=/path/to/chrome`.
