import type { InteractionScript } from './core/interactions.js';
import type { Capsule, CapsuleDependency, CapsuleEvent, CaptureMode, CheckpointKind, EligibilityBuilder, FailureRecord } from './core/model.js';
import type { FixtureStore } from './core/network.js';
import type { ReplaySettings } from './core/protocol.js';
import type { RecordedWindow } from './core/recorder.js';
import type { Redactor } from './core/redaction.js';
import type { InAppMatcher } from './monitoring/stack.js';
import type { PropagationTarget, TracesSampler } from './monitoring/tracing.js';
import type { Breadcrumb, EventHint, EventPayload, MonitorHooks, TransactionPayload } from './monitoring/types.js';

export interface BugCapsuleBackendConfig {
  /** e.g. `http://127.0.0.1:8787` locally, `https://bugcapsule.example.com` hosted. */
  url: string;
  /** Project ingest key (`bci_…`). Upload-only and safe to ship. Never put a `bcs_` secret key in a web app. */
  ingestKey: string;
}

export interface OutboxLimits {
  /** Default 10. */
  maxCount?: number;
  /** Default 10 MiB. */
  maxBytes?: number;
  /** Default 7 days. */
  maxAgeMs?: number;
}

export interface BugCapsuleConfig {
  /**
   * SDK connection token from the dashboard (`bcsdk.v1.…`): carries the API
   * URL and an ingest-only credential, so nothing else is needed to connect.
   * Client-visible by design. Ignored when `backend` is set.
   */
  token?: string;
  /** Default: the version part of `release` (`shop@1.4.0+52` → `1.4.0+52`), else `unknown`. */
  appVersion?: string;
  /** Default `0`. */
  appBuild?: string;
  appId?: string;
  appName?: string;
  flavor?: string;
  /** `debug` and `qa` always record; `production` samples. Default `production`. */
  mode?: CaptureMode;
  /** Local master switch. The backend kill switch can also disable capture. */
  enabled?: boolean;
  /** Explicit backend URL + ingest key (the pre-token setup, still supported). Wins over `token`. */
  backend?: BugCapsuleBackendConfig;
  /** Commit the build was made from (inject at build time, e.g. `import.meta.env.VITE_BUGCAPSULE_GIT_SHA`). */
  gitSha?: string;
  gitDirty?: boolean;
  /** Bump when serialized state changes incompatibly. */
  stateSchemaVersion?: number;
  integrations?: BugCapsuleIntegration[];
  checkpointIntervalMs?: number;
  windowMs?: number;
  maxEvents?: number;
  /** Maximum fraction of production sessions that record (default 0.1). The backend can lower it. */
  productionSampleRate?: number;
  autoCaptureOnFailure?: boolean;
  maxCapsulesPerSession?: number;
  captureNetworkBodies?: boolean;
  /** Default 256 KiB. */
  maxBodyBytes?: number;
  redactKeys?: string[];
  redactHeaders?: string[];
  /** Extra free-text patterns replaced with `[REDACTED]` wherever text is recorded. */
  redactPatterns?: RegExp[];
  /** Last look at every recorded event after built-in redaction; return null to drop it. */
  beforeRecord?: (type: string, data: Record<string, unknown>) => Record<string, unknown> | null;
  /** Last look at each integration's checkpoint snapshot; return null to leave it out. */
  beforeCheckpoint?: (integration: string, data: unknown) => unknown;
  outboxLimits?: OutboxLimits;
  /** How old the last remote config may be for uploads (default 7 days). */
  maxStaleConfigMs?: number;
  /** Return true for errors that should not count as failures. */
  ignoreError?: (error: unknown) => boolean;
  labels?: Record<string, string>;
  /** Record pointer (mouse/touch/pen) input. Default true. */
  capturePointers?: boolean;
  /** Elements matching this selector (and password inputs) never contribute text. */
  sensitiveSelector?: string;
  /**
   * Let the BugCapsule replay runner drive this build. Wire it to a dev/test
   * build flag (`import.meta.env.DEV`, a staging build): production builds
   * must leave it false. Replay is never activated from URLs, storage or messages.
   */
  allowReplay?: boolean;
  /** IndexedDB database name (default `bugcapsule`). */
  storageName?: string;
  /** Capture setup gets this long before the app continues without capture (default 5 s). */
  setupTimeoutMs?: number;

  // ------------------------------------------------- monitoring (monitoring-v1)

  /** `false` turns off errors, sessions, tracing and feedback (capsules unaffected). Default true. */
  monitoring?: boolean;
  /** e.g. `shop-web@1.4.0+52`. Omitted when not set. */
  release?: string;
  /** Default from `mode`: `production`, `qa`, `development` (debug). */
  environment?: string;
  dist?: string;
  /** Share of error events sent (default 1; the backend can lower it). Fatal and capsule-linked events are always sent. */
  errorSampleRate?: number;
  /** Share of traces sent (default 0). The backend's `tracesSampleRate` overrides it unless `tracesSampler` is set. */
  tracesSampleRate?: number;
  /** Decides per trace root; return a rate or a boolean. */
  tracesSampler?: TracesSampler;
  /**
   * URLs that get `traceparent` + `baggage` (substring strings, `"/regex/"`
   * strings or RegExps). Default: same origin as the page. The backend's
   * list, when set, replaces it.
   */
  tracePropagationTargets?: PropagationTarget[];
  /** One release-health session per page load (default true). */
  enableAutoSessionTracking?: boolean;
  /** An unhandled error marks the session `crashed` (default true). */
  crashOnUnhandled?: boolean;
  /** Default 100 (the maximum). */
  maxBreadcrumbs?: number;
  /** Last look at every error event after redaction rules ran on it; return null to drop it. */
  beforeSend?: (event: EventPayload, hint: EventHint) => EventPayload | null;
  beforeSendTransaction?: (transaction: TransactionPayload) => TransactionPayload | null;
  /** Return null to drop the breadcrumb. */
  beforeBreadcrumb?: (breadcrumb: Breadcrumb, hint?: Record<string, unknown>) => Breadcrumb | null;
  /** Frames whose script URL matches are in-app (substring or RegExp); wins over `inAppExcludes`. */
  inAppIncludes?: InAppMatcher[];
  inAppExcludes?: InAppMatcher[];
  /** Attach a stack trace to `captureMessage` events (default false). */
  attachStacktrace?: boolean;
  /** Default false: no IP address. True sends `user.ipAddress: "{{auto}}"`. */
  sendDefaultPii?: boolean;
  /** LCP, INP, CLS, FCP, TTFB on pageload transactions (default true). */
  enableWebVitals?: boolean;
  /** A `ui.action.click` transaction for clicks while no pageload/navigation is running (default false). */
  enableUserInteractionTracing?: boolean;
  /** `console.error` calls become error events (default false). */
  captureConsoleErrors?: boolean;
  /** Console calls become breadcrumbs (default true). */
  consoleBreadcrumbs?: boolean;
  /** `captureFeedback` also writes a capsule (default true in `qa` mode). */
  captureCapsuleWithFeedback?: boolean;
  /** Envelope outbox bounds (default 30 envelopes / 5 MiB / 7 days). */
  envelopeOutboxLimits?: OutboxLimits;
}

/**
 * Where the SDK stands with the backend (`BugCapsule.status()`):
 * - `not_configured`: no token or backend; the app runs without BugCapsule;
 * - `invalid_token` / `unsupported_token_version`: the token can't be used (see `message`);
 * - `connecting`: no config fetched yet in this page session;
 * - `connected`: the config was fetched (basic connectivity);
 * - `offline`: the backend can't be reached; data waits in the outbox and is retried;
 * - `rejected`: the backend refused the credential (`reason`: token_revoked, token_expired, token_unknown, …);
 * - `disabled`: `enabled: false`, or capture switched off by the backend.
 */
export type ConnectionState = 'not_configured' | 'invalid_token' | 'unsupported_token_version' | 'connecting' | 'connected' | 'offline' | 'rejected' | 'disabled';

export interface BugCapsuleStatus {
  connection: {
    state: ConnectionState;
    source: 'token' | 'backend' | null;
    apiUrl: string | null;
    reason: string | null;
    message: string | null;
    /** Epoch ms of the last config fetched (confirmation 1: configuration fetched). */
    configFetchedAt: number | null;
    /** Epoch ms the backend first accepted an event / a Capsule in this page session (confirmation 2). */
    firstEventAcceptedAt: number | null;
    firstCapsuleAcceptedAt: number | null;
  };
  /**
   * Basic connectivity is not complete replay instrumentation. These are the
   * progressive setup steps: network fixtures, navigation, app state.
   */
  instrumentation: {
    recording: boolean;
    network: boolean;
    navigation: boolean;
    appState: boolean;
    frameworks: string[];
    missing: string[];
  };
}

/** What the runtime exposes to integrations. */
export interface BugCapsuleSession {
  readonly config: Readonly<BugCapsuleConfig>;
  readonly mode: CaptureMode;
  /** Events are being recorded (enabled, sampled, not killed). */
  readonly isRecording: boolean;
  readonly isReplaying: boolean;
  readonly redactor: Redactor;
  readonly captureNetworkBodies: boolean;
  readonly maxBodyBytes: number;
  /** Milliseconds on the session clock (same clock as event `t`). */
  now(): number;
  /** Records an event (no-op when not recording). */
  record(type: string, data?: Record<string, unknown>): void;
  /** Non-null in replay mode. */
  readonly replay: ReplayContext | null;
  /** Reports an error as a failure. */
  reportError(error: unknown): void;
  /** `fetch` as it was before any integration wrapped it (for SDK traffic). */
  readonly nativeFetch: typeof fetch;
  /** @internal Monitoring hooks (null when monitoring is off and during replay). */
  readonly monitor?: MonitorHooks | null;
  /**
   * Whether the backend switched off this interaction adapter
   * (`disabledAdapters` in the remote config, capsule-v2 §7). Other capture
   * (HTTP, input) is unaffected.
   */
  adapterDisabled?(adapterId: string): boolean;
  /**
   * The backend's lower per-payload interaction limit
   * (`maxInteractionPayloadBytes` in the remote config, capsule-v2 §7);
   * undefined when it set none.
   */
  maxInteractionPayloadBytes?(): number | undefined;
}

export interface ReplayContext {
  readonly capsule: Capsule;
  readonly settings: ReplaySettings;
  readonly fixtures: FixtureStore;
  diverge(type: string, detail: string): void;
  fixtureServed(): void;
  /** Marks work idle compression must not skip over; call the result when done. */
  beginWork(): () => void;
  activity(): void;
  /** True once the first recorded input was dispatched (late restoration detection). */
  readonly inputsStarted: boolean;
  /**
   * Recorded interactions of the capsule's required dependencies
   * (capsule-v2 §5) on the replay clock. Adapters match outbound operations
   * and bind handlers for inbound deliveries here.
   */
  readonly interactions: InteractionScript;
  /** Call after `take`/`takeNext`/`bind`: reschedules the next delivery. */
  interactionsChanged(): void;
}

/** An interaction adapter an integration provides for replay (capsule-v2 §2 preflight). */
export interface ReplayAdapter {
  /** `manifest.dependencies[].adapter`, e.g. `bugcapsule-web.websocket`. */
  adapter: string;
  /** Event payload schemas this adapter can replay. */
  schemas: readonly number[];
}

/**
 * Extension point for the libraries an app uses. Capture: setUp → snapshot
 * (launch, then periodic) → describeEligibility when a capsule is written.
 * Replay: setUp (session.replay set) → restore with this integration's
 * checkpoint data, before the app renders.
 */
export interface BugCapsuleIntegration {
  /** Key of this integration's data in checkpoints, e.g. `local_storage`. */
  readonly name: string;
  /** Capability entries this integration adds to the manifest. */
  readonly capabilities?: Record<string, string>;
  setUp?(session: BugCapsuleSession): void | Promise<void>;
  snapshot?(kind: CheckpointKind): unknown | Promise<unknown>;
  restore?(data: unknown, session: BugCapsuleSession): void | Promise<void>;
  describeEligibility?(eligibility: EligibilityBuilder, window: RecordedWindow): void;
  /** Called when capture or replay stops for good (tests, kill switch). */
  dispose?(): void;

  // ------------------------------------------- interaction adapters (capsule-v2)

  /** Interaction adapters this integration replays; preflight blocks capsules needing others. */
  readonly replayAdapters?: readonly ReplayAdapter[];
  /** `manifest.dependencies` entries for what this integration recorded in the window (none: v1 capsule). */
  describeDependencies?(window: RecordedWindow): CapsuleDependency[];
  /** Connections or subscriptions open now, listed in periodic checkpoints (`checkpoint.data.interactions.open`). */
  openInteractions?(): { dep: string; type: string; id: string; restorable: boolean }[];
  /** Whether a buffered event belongs to this integration's adapter (dropped when the adapter is disabled remotely). */
  ownsEvent?(event: CapsuleEvent): boolean;
}

export interface CaptureResult {
  capsuleId: string;
  eligibility: import('./core/model.js').Eligibility;
  failureSignature: string | null;
  /** Null when no backend is configured. */
  upload: UploadResult | null;
  /** The encoded capsule (gzip). */
  bytes: Uint8Array;
}

export type UploadStatus = 'uploaded' | 'rejected' | 'retryLater';

export interface UploadResult {
  status: UploadStatus;
  serverId?: string;
  message?: string;
  retryAfterMs?: number;
}

export type { FailureRecord };
