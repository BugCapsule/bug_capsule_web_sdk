# Working on the web SDK

For maintainers of this repository. App developers want the
[README](../README.md) instead.

## Build and test

```bash
npm install
npm run build                 # packages/*/dist (the demo uses the built packages)
npm run test:unit             # core conformance (shared fixtures), outbox, remote config, monitoring, CLI
npm run test:browser          # SDK in Chromium: capture, redaction, offline, kill switch, cross-tab, XHR, replay, monitoring, React
npm run pack:all              # dist-packages/*.tgz for review (not published)
```

## Shared fixtures

`spec-fixtures/` is a copy of the Flutter SDK's `spec/fixtures` (synced with
`tool/sync_spec.sh` in
[bug_capsule_flutter_sdk](https://github.com/BugCapsule/bug_capsule_flutter_sdk)).
The unit tests fail when the copies differ.

## Release procedure

1. `npm run build && npm test`, then the demo end-to-end run
   ([examples/shop](../examples/shop/README.md)).
2. Bump the version in the four `package.json` files and `SDK_VERSION` in
   `packages/web/src/version.ts` (it is written into every capsule and
   envelope).
3. `npm run pack:all`, inspect the tarballs (`tar -tzf`), install them in a
   clean project and type-check.
4. Publish from a clean checkout (`npm publish -w … --access public`) only
   after review, and record the git SHA of the release.

Validation evidence for past releases: [release-readiness.md](release-readiness.md).
