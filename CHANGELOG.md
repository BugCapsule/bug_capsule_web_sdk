# Changelog

## Unreleased

- Read capsule format v2 (interaction dependencies) as well as v1. Capsules
  are written as v2 only when they recorded an interaction dependency.
- Add opt-in WebSocket capture and offline replay: `webSocketIntegration()`,
  adapter `bugcapsule-web.websocket`, schema 1. Replay never opens a real
  socket.
- Your project's capture settings can switch off a single adapter
  (`disabledAdapters`) without affecting HTTP capture.
- `@bugcapsule/web/core` adds typed values, the interaction scheduler and
  the verdict rules, checked against the shared conformance fixtures.
- Events recorded in one task share a timestamp.

## 0.4.0-beta.2 — 2026-10-25

- Add single SDK token setup and connection status diagnostics.
- Report missing replay instrumentation and stop uploads when credentials are rejected.
- Update developer setup and integration documentation.
