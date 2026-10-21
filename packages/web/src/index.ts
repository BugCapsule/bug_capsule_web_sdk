/**
 * BugCapsule web SDK: capture failures in the browser as portable
 * `.bugcapsule` capsules and replay them against the real app with the
 * `bugcapsule` CLI (Playwright runner: `@bugcapsule/web-replay`).
 */
export { BugCapsule, type TrackOptions } from './bugcapsule.js';
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
export { EndpointRule, Redactor, type EndpointRuleInit } from './core/index.js';
export { SDK_NAME, SDK_VERSION, type RuntimeOverrides } from './runtime.js';
export type { BugCapsuleTransport, ConfigFetchResult, RemoteCaptureConfig } from './remote-config.js';
export { MemoryStorage, type SdkStorage } from './storage/idb.js';
