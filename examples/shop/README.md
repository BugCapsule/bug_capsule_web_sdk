# BugCapsule Shop (web demo)

A React + React Router app (Vite) using `@bugcapsule/web` and
`@bugcapsule/react`, talking to a demo API on its own origin
(`api-server.mjs`, `http://127.0.0.1:4318`) with randomized latency and data.

| Bug | Kind | How to trigger | What replay needs |
|---|---|---|---|
| Picks scored before the profile arrives | timing-sensitive network | **Refresh picks** until it fails (~1 in 3) | recorded response latencies |
| Legacy cart cache | state restoration | **Simulate upgrade from v0.9**, reload | `localStorage` from the launch checkpoint |
| Discontinued item | data-dependent | open **Cart** until an item is "unavailable", **Checkout** | the response with `price: null` |
| Negative total | data-dependent assertion | cart without unavailable items, coupon `SAVE100`, **Apply** | tracked text + response + `cart_total_non_negative` |

Fix toggles for verification, applied at build time without editing sources:
`VITE_BUGCAPSULE_DEMO_FIX=race|legacy|discontinued|coupon` (comma-separated).

## Run it

```bash
# repository root
npm install && npm run build
node examples/shop/api-server.mjs                       # demo API on :4318
# backend with CORS for the demo origin: CORS_ALLOWED_ORIGINS=http://127.0.0.1:4317
cd examples/shop
# the SDK token from the dashboard (or VITE_BUGCAPSULE_BACKEND_URL + VITE_BUGCAPSULE_INGEST_KEY)
VITE_BUGCAPSULE_TOKEN=bcsdk.v1.… \
VITE_BUGCAPSULE_ALLOW_REPLAY=true npx vite build && npx vite preview --port 4317 --strictPort --host 127.0.0.1
```

Drive a bug by hand, or with the QA automation script (headless Chromium;
prints the backend id of the uploaded capsule):

```bash
node scripts/capture.mjs --bug race
node scripts/capture.mjs --bug discontinued --offline-then-reload   # queued offline, uploaded after a reload
```

Then stop the preview (the CLI serves its own build) and:

```bash
export BUGCAPSULE_URL=http://127.0.0.1:8787 BUGCAPSULE_SECRET_KEY=bcs_…
bugcapsule inspect <id>
bugcapsule run <id> -n 3 -p examples/shop                          # REPRODUCED 3/3
bugcapsule verify <id> -n 3 -p examples/shop                       # STILL FAILING 3/3
VITE_BUGCAPSULE_DEMO_FIX=race bugcapsule verify <id> -n 3 -p examples/shop   # FIXED
bugcapsule regress add <id> -p examples/shop
VITE_BUGCAPSULE_DEMO_FIX=race bugcapsule regress run -p examples/shop -n 2
```

Measured results are in [docs/e2e-evidence.md](../../docs/e2e-evidence.md).
