import type { Capsule, CaptureMode, CheckpointKind, EligibilityBuilder, FailureRecord } from './core/model.js';
import type { FixtureStore } from './core/network.js';
import type { ReplaySettings } from './core/protocol.js';
import type { RecordedWindow } from './core/recorder.js';
import type { Redactor } from './core/redaction.js';

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
  appVersion: string;
  appBuild: string;
  appId?: string;
  appName?: string;
  flavor?: string;
  /** `debug` and `qa` always record; `production` samples. Default `production`. */
  mode?: CaptureMode;
  /** Local master switch. The backend kill switch can also disable capture. */
  enabled?: boolean;
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
