/**
 * BugCapsule web SDK: capture failures in the browser as portable
 * `.bugcapsule` capsules and replay them against the real app with the
 * `bugcapsule` CLI (Playwright runner: `@bugcapsule/web-replay`).
 */
export { BugCapsule, type TrackOptions } from './bugcapsule.js';
export type { CapsuleLinks, SentryLink } from './core/model.js';
export type {
  BugCapsuleBackendConfig,
  BugCapsuleConfig,
  BugCapsuleIntegration,
  BugCapsuleSession,
  CaptureResult,
  OutboxLimits,
  ReplayContext,
  UploadResult,
  UploadStatus,
} from './types.js';
export { networkIntegration, fetchIntegration, xhrIntegration, NetworkIntegration, type NetworkOptions } from './integrations/network.js';
export {
  localStorageIntegration,
  sessionStorageIntegration,
  indexedDbIntegration,
  WebStorageIntegration,
  IndexedDbIntegration,
  type WebStorageOptions,
  type IndexedDbAdapter,
} from './integrations/storage.js';
export { historyIntegration, HistoryIntegration, type HistoryOptions } from './integrations/history.js';
export { StateIntegration, type StateSerializer } from './integrations/state.js';
export {
  sentryCompanion,
  SENTRY_TAG_CAPSULE_ID,
  SENTRY_TAG_CAPTURE,
  type SentryCompanionIntegration,
  type SentryCompanionOptions,
  type SentryEventLike,
  type SentryEventHintLike,
  type SentryClientLike,
} from './integrations/sentry.js';
export { EndpointRule, Redactor, type EndpointRuleInit } from './core/index.js';
export { SDK_NAME, SDK_VERSION, type CaptureDecision, type FailureOutcome, type RuntimeOverrides } from './runtime.js';
export type { BugCapsuleTransport, ConfigFetchResult, RemoteCaptureConfig } from './remote-config.js';
export { MemoryStorage, type SdkStorage } from './storage/idb.js';
export { Scope } from './monitoring/scope.js';
export { Span, Transaction, parameterizePath, type SpanOptions, type TransactionOptions, type TracesSampler, type PropagationTarget } from './monitoring/tracing.js';
export { FeedbackWidget, type FeedbackWidgetOptions, type FeedbackTheme } from './monitoring/feedback-widget.js';
export { parseStack } from './monitoring/stack.js';
export type { InAppMatcher } from './monitoring/stack.js';
export type {
  Breadcrumb,
  BreadcrumbType,
  CaptureContext,
  DebugImage,
  Envelope,
  EnvelopeItem,
  EventHint,
  EventPayload,
  ExceptionValue,
  FeedbackInput,
  FeedbackPayload,
  Measurement,
  Mechanism,
  MechanismType,
  MonitoringLink,
  SessionPayload,
  SessionStatus,
  SeverityLevel,
  SpanPayload,
  SpanStatus,
  StackFrame,
  TracesSamplingContext,
  TransactionPayload,
  User,
} from './monitoring/types.js';
