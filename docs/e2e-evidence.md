# Web end-to-end evidence (2026-10-21)

Environment: macOS 26 (arm64), Node 24.4, Playwright 1.63 Chromium 153
(headless), BugCapsule backend 0.3.0 on `http://127.0.0.1:8787` (fresh
database, `CORS_ALLOWED_ORIGINS=http://127.0.0.1:4317,http://localhost:4317`),
demo API on `:4318`, demo QA build (`VITE_BUGCAPSULE_ALLOW_REPLAY=true`, ingest
key from the env) on `:4317`. CLI: `dart run bin/bugcapsule.dart` in
`bug_capsule_flutter_sdk/packages/bug_capsule` with `BUGCAPSULE_URL` and
`BUGCAPSULE_SECRET_KEY` in the environment. Outputs trimmed to the relevant lines.

## 1–3. Integration, automatic capture, persistence and upload

```
$ node scripts/capture.mjs --bug race
bug "race" fired after 3 tries: Cannot read properties of null (reading 'tier')
uploaded capsule 35f3c4ba-c7d2-4930-9d9b-fb9326f07acc (capsuleId a83d0cb3-…, partial, web)

$ node scripts/capture.mjs --bug legacy        → e0f8f7b2-3857-4c0f-bf25-076091835452
$ node scripts/capture.mjs --bug discontinued  → 6d92cd47-7c74-441e-8b32-fe62ce78872c
$ node scripts/capture.mjs --bug coupon        → a088bb03-3719-40d0-8528-10b1e5a55f29 (assertion)
```

The capsule is written to IndexedDB (outbox + saved captures) and uploaded
cross-origin through the backend's CORS (preflight + `Authorization: Bearer bci_…`).
`partial` = no git SHA (the SDK directory is not a git checkout); see §10 for an
`eligible` capsule built from a commit.

## 4. Inspection

```
$ bugcapsule list
35f3c4ba-…  new  partial  qa 1.0.0+1 web HeadlessChrome 153  exception:TypeError:Cannot read properties of null (reading 'tier')
$ bugcapsule inspect 35f3c4ba-…
  platform   web HeadlessChrome 153  1280×720 @1.0x
  runtime    web HeadlessChrome 153  javascript  frameworks: react
  sdk        @bugcapsule/web 0.3.0  integrations: network, history, local_storage, state
Failure  exception:TypeError:Cannot read properties of null (reading 'tier')
Events  pointer 6 · action 3 · http 6 · failure 1
Network
     1.32s  GET    /api/recommendations         200  278ms json
     1.32s  GET    /api/profile                 200  292ms json
```

## 5. Replay → REPRODUCED

```
$ bugcapsule run 35f3c4ba-… -n 3 -p examples/shop
Building the web app (npm run build)… ✓ 0.8s
Serving http://127.0.0.1:4317/ (npm run preview)… ✓ 0.3s
Target chromium (Playwright) → http://127.0.0.1:4317/
  replay #1  REPRODUCED  1.6s  pointer, 6 inputs, 6 responses
  replay #2  REPRODUCED  1.6s  pointer, 6 inputs, 6 responses
  replay #3  REPRODUCED  1.6s  pointer, 6 inputs, 6 responses
Result: REPRODUCED 3/3
```

Other capsules: legacy cart (state restoration) REPRODUCED 2/2 (0 inputs:
it crashes at startup once storage is restored), discontinued item REPRODUCED
2/2, negative-total assertion REPRODUCED 2/2.

Negative control: the legacy capsule with `checkpoint.data.local_storage`
removed → `NOT REPRODUCED 0/2`. Replay depends on the restored checkpoint.

## 6–7. Isolated fix and verification

Fixes are build-time toggles (`VITE_BUGCAPSULE_DEMO_FIX`), no source edits.

```
$ bugcapsule verify 35f3c4ba-… -n 3 -p examples/shop
Result: STILL FAILING 3/3
$ VITE_BUGCAPSULE_DEMO_FIX=race bugcapsule verify 35f3c4ba-… -n 3 -p examples/shop
  verify #1  PASS  9.6s  pointer, 6 inputs, 6 responses   (×3)
Result: FIXED — failure gone in 3/3 valid runs
backend: status fixed; runs: replay reproduced 3/3, verify reproduced 3/3, verify not_reproduced 3/3 (validAttempts 3)

$ VITE_BUGCAPSULE_DEMO_FIX=legacy bugcapsule verify e0f8f7b2-… -n 2
Result: FIXED — failure gone in 2/2 valid runs
```

FIXED is withheld when replay cannot prove the fix: with the discontinued-item
fix, checkout continues into `POST /api/checkout`, which the recording never
saw. Strict replay blocks it and reports it:

```
$ VITE_BUGCAPSULE_DEMO_FIX=discontinued bugcapsule verify 5200d4bc-… -n 2
  verify #1  INVALID  8.3s  … unexpected failure: …no recorded response for POST …/api/checkout
Result: INCONCLUSIVE — 0 of 2 attempts ran validly; nothing is verified
  • divergence network.unrecorded
```

## 8. Regression

```
$ bugcapsule regress add 35f3c4ba-… -p examples/shop --name "race: picks scored before profile"
✓ added bugcapsule/regressions/a83d0cb3-….bugcapsule (1 tests)
$ bugcapsule regress run -p examples/shop -n 2
  → fail          1 of 1 regression capsules fail.        (exit 1)
$ VITE_BUGCAPSULE_DEMO_FIX=race bugcapsule regress run -p examples/shop -n 2
  → pass          All 1 regression capsules pass.
```

## 9. Offline capture, reload, later upload

```
$ node scripts/capture.mjs --bug discontinued --offline-then-reload
bug "discontinued" fired after 1 try: Cannot read properties of null (reading 'amount')
offline: 1 capsule(s) queued in IndexedDB, uploads so far: 0
after reload: uploads [201], queued 0
uploaded capsule 5200d4bc-3c15-43d3-8550-bd88e43ef492
$ bugcapsule run 5200d4bc-… -n 2  →  REPRODUCED 2/2
```

## 10. Source-revision replay

In a scratch git copy of this repository: built at commit `a3fb24b`
(`BUGCAPSULE_GIT_SHA` embedded → capsule `eligible`), captured the race,
committed a fix (`838b480`), then:

```
$ bugcapsule run 36729a48-… -n 2 -p <scratch>/examples/shop
Pinned to capsule commit a3fb24b0 (…/bugcapsule-pin-a3fb24b0aeb5/examples/shop)
Installing dependencies (npm install && npm run build)… ✓ 6.5s
Building the web app (npm run build)… ✓ 1.8s
Result: REPRODUCED 2/2
$ bugcapsule verify 36729a48-… -n 2 -p <scratch>/examples/shop
Result: FIXED — failure gone in 2/2 valid runs
  • build.gitSha: capsule a3fb24b… vs build 838b480… ×2   (expected divergence)
```

## Automated suites

* `npm run test:unit`: 189 passed (capsule fixtures, request-key/signature/redaction
  conformance, bounded decoding, outbox, remote config).
* `npm run test:browser`: 16 passed in Chromium (capture + redaction, streams,
  offline + reload, Retry-After, kill switch, rejected key, outbox bounds,
  cross-tab single upload, XHR, production sampling, replay: pointer, semantic,
  strict network, production protection, runtime mismatch, XHR replay, invalid
  capsules).
* Packed tarballs installed into a clean project: strict type-check
  (`skipLibCheck: false`), Node import of `@bugcapsule/web/core`, runner bin.
