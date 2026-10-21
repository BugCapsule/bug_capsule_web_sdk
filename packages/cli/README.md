# @bugcapsule/cli

Build tooling for BugCapsule web monitoring: debug ids and source-map upload,
so the backend can symbolicate minified stack frames
([monitoring-v1 §3, §5.4](../../../bug_capsule_backend/docs/monitoring-v1.md)).

```bash
npm install -D @bugcapsule/cli

# 1. after the build, before deploying
npx bugcapsule-cli sourcemaps inject dist

# 2. in CI, with the project secret key (never the ingest key, never in the app)
BUGCAPSULE_SECRET_KEY=bcs_… npx bugcapsule-cli sourcemaps upload dist \
  --url https://bugcapsule.example.com --release shop-web@1.4.0+52

# 3. do not deploy the maps
find dist -name '*.map' -delete
```

`inject` gives every bundle (`.js`, `.mjs`, `.cjs`; `node_modules` skipped) a
debug id derived from its content and writes it

* into the bundle: `//# debugId=<id>` and a one-line snippet that registers
  the id at runtime (the SDK reads it into the event's `debugImages`). Both
  are appended before the `sourceMappingURL` comment, so no mapping moves;
* into the source map (found through `sourceMappingURL` or `<bundle>.map`):
  `"debugId"`.

It is idempotent: bundles that already have a debug id are left alone.

`upload` sends, for every bundle with a map, to `POST /v1/debug-files`
(gzipped):

* the map: `kind=sourcemap`, `debugId`, `release` (with `--release`), `name`
  (`<url-prefix><path>.map`);
* with `--release`, the bundle: `kind=minified_source`, `release`, `name`,
  `debugId` (`--no-sources` skips it).

Bundles without a debug id are uploaded by `release` + `name` only (run
`inject` first for exact matching). `--url-prefix` (default `~/`, which
matches any origin) must match the path the bundles are served from, e.g.
`--url-prefix '~/static/js'` for `dist/app.js` served as `/static/js/app.js`.
`--url` defaults to `BUGCAPSULE_URL`; `--key` (or `BUGCAPSULE_SECRET_KEY`) is
the project secret key. `--dry-run` shows what would change or be uploaded.
Uploads retry on `429`/`5xx` (honouring `Retry-After`).

The functions are also exported (`injectFile`, `uploadSourcemaps`,
`findBundles`, `debugIdFromContent`) for bundler plugins.
