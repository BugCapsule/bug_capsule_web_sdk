# BugCapsule CLI

Install with Node.js 20 or newer:

```sh
npm install -g @bugcapsule/cli@0.4.0-beta.3
bugcapsule login
bugcapsule --help
```

No Dart or Flutter installation is required. The first command downloads and
verifies the standalone CLI engine (0.4.1-beta.7), then caches it in
`~/.bugcapsule/bin`. macOS ARM64/x64, Linux ARM64/x64 and Windows x64 are
supported. Direct binaries are available from the [CLI release](https://github.com/BugCapsule/bug_capsule_flutter_sdk/releases/tag/v0.4.1-beta.7).

Use `bugcapsule inspect`, `run`, `verify`, `regress`, and `gate` for capsules
from all four runtimes. Replay/build operations need only the target app's
toolchain. Existing `bugcapsule-cli sourcemaps` commands remain supported;
`bugcapsule sourcemaps` works too.


Build tooling for the [BugCapsule web SDK](https://github.com/BugCapsule/bug_capsule_web_sdk#readme):
injects debug ids into your bundles and uploads source maps, so error events
from minified code show your original files and lines. Guide:
[Release symbols and source maps](https://docs.bugcapsule.com/symbols.html).

The same package installs the standalone `bugcapsule` replay CLI described above.

```bash
npm install -D @bugcapsule/cli

# 1. after the build, before deploying
npx bugcapsule-cli sourcemaps inject dist

# 2. in CI, with the project secret key from your CI secrets (never in the app)
BUGCAPSULE_SECRET_KEY=bcs_… npx bugcapsule-cli sourcemaps upload dist \
  --url https://api.bugcapsule.com --release shop-web@1.4.0+52

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

`upload` sends, for every bundle with a map (gzipped):

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
Uploads retry on rate limits and temporary server errors (honouring `Retry-After`).

The functions are also exported (`injectFile`, `uploadSourcemaps`,
`findBundles`, `debugIdFromContent`) for bundler plugins.
