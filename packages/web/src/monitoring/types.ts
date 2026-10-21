/** Payload shapes of monitoring-v1 envelope items (`event`, `session`, `transaction`, `feedback`). */

export type SeverityLevel = 'fatal' | 'error' | 'warning' | 'info' | 'debug';

export type MechanismType = 'onerror' | 'unhandledrejection' | 'uncaught' | 'manual' | 'logging' | 'assertion';

export interface Mechanism {
  type: MechanismType;
  handled: boolean;
  data?: Record<string, unknown>;
}

export interface StackFrame {
  function?: string;
  module?: string;
  filename?: string;
  absPath?: string;
  lineno?: number;
  colno?: number;
  inApp?: boolean;
}

export interface ExceptionValue {
  type: string;
  value?: string;
  module?: string;
  mechanism?: Mechanism;
  stacktrace?: { frames: StackFrame[] };
}

export interface User {
  id?: string | null;
  email?: string | null;
  username?: string | null;
  ipAddress?: string | null;
  segment?: string | null;
  data?: Record<string, unknown>;
}

export type BreadcrumbType = 'default' | 'http' | 'navigation' | 'user' | 'ui' | 'error' | 'debug' | 'info' | 'query' | 'state';

export interface Breadcrumb {
  timestamp?: string;
  type?: BreadcrumbType;
  category?: string;
  message?: string | null;
  level?: SeverityLevel;
  data?: Record<string, unknown>;
}

export interface DebugImage {
  type: 'sourcemap';
  debugId: string;
  codeFile: string;
}

export interface TraceContext {
  traceId: string;
  spanId?: string;
}

export interface EventPayload {
  eventId: string;
  timestamp: string;
  level: SeverityLevel;
  runtime: 'web';
  release?: string;
  environment: string;
  dist?: string;
  exception?: { values: ExceptionValue[] } | null;
  message?: { formatted: string; template?: string; params?: unknown[] } | null;
  fingerprint?: string[] | null;
  tags?: Record<string, string>;
  user?: User;
  contexts?: Record<string, Record<string, unknown>>;
  breadcrumbs?: Breadcrumb[];
  debugImages?: DebugImage[];
  request?: { url: string; method: string; headers?: Record<string, string>; query?: string } | null;
  extra?: Record<string, unknown>;
  capsuleId?: string | null;
}

export type SessionStatus = 'ok' | 'exited' | 'crashed' | 'abnormal';

export interface SessionPayload {
  sid: string;
  did: string;
  seq: number;
  init: boolean;
  started: string;
  timestamp: string;
  status: SessionStatus;
  errors: number;
  duration: number;
  release?: string;
  environment: string;
  runtime: 'web';
}

export type SpanStatus =
  | 'ok'
  | 'cancelled'
  | 'unknown'
  | 'invalid_argument'
  | 'deadline_exceeded'
  | 'not_found'
  | 'already_exists'
  | 'permission_denied'
  | 'resource_exhausted'
  | 'failed_precondition'
  | 'aborted'
  | 'out_of_range'
  | 'unimplemented'
  | 'internal_error'
  | 'unavailable'
  | 'data_loss'
  | 'unauthenticated';

export interface SpanPayload {
  spanId: string;
  parentSpanId: string | null;
  op: string;
  description?: string;
  startTimestamp: string;
  timestamp: string;
  status: SpanStatus;
  data?: Record<string, unknown>;
  tags?: Record<string, string>;
}

export interface Measurement {
  value: number;
  unit: string;
}

export interface TransactionPayload {
  eventId: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  op: string;
  startTimestamp: string;
  timestamp: string;
  status: SpanStatus;
  release?: string;
  environment: string;
  runtime: 'web';
  dist?: string;
  tags: Record<string, string>;
  user?: User;
  contexts: Record<string, Record<string, unknown>>;
  measurements: Record<string, Measurement>;
  spans: SpanPayload[];
}

export interface FeedbackPayload {
  feedbackId: string;
  timestamp: string;
  eventId?: string | null;
  name?: string | null;
  email?: string | null;
  message: string;
  url?: string | null;
  release?: string;
  environment: string;
  runtime: 'web';
  user?: User;
  contexts?: Record<string, Record<string, unknown>>;
  tags?: Record<string, string>;
  capsuleId?: string | null;
}

export type EnvelopeItem =
  | { type: 'event'; payload: EventPayload }
  | { type: 'session'; payload: SessionPayload }
  | { type: 'transaction'; payload: TransactionPayload }
  | { type: 'feedback'; payload: FeedbackPayload };

export interface Envelope {
  sentAt: string;
  sdk: { name: string; version: string };
  items: EnvelopeItem[];
}

/** Second argument of `captureException` / `captureMessage` (monitoring-v1 §11). */
export interface CaptureContext {
  level?: SeverityLevel;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  fingerprint?: string[];
  contexts?: Record<string, Record<string, unknown>>;
  user?: User;
  /** How the error reached the SDK (default `manual`, handled). */
  mechanism?: Mechanism;
}

/** What `beforeSend` gets besides the event. */
export interface EventHint {
  originalException?: unknown;
  syntheticException?: Error;
  mechanism?: Mechanism;
}

export interface FeedbackInput {
  message: string;
  name?: string;
  email?: string;
  /** The event the feedback is about (default: none; the widget uses `lastEventId()`). */
  eventId?: string;
  url?: string;
  tags?: Record<string, string>;
  /**
   * Also write a capsule and link it (`capsuleId`). Default:
   * `captureCapsuleWithFeedback` (true in `qa` mode). Needs a recording session.
   */
  captureCapsule?: boolean;
}

export interface TracesSamplingContext {
  name: string;
  op: string;
  /** Sampling decision of an incoming trace (`continueTrace`, `<meta name="traceparent">`). */
  parentSampled?: boolean;
  location?: string;
}

/** `manifest.monitoring` of a capsule written for a failure (monitoring-v1 §4.3). */
export interface MonitoringLink {
  eventId: string;
  traceId?: string;
  release?: string;
  environment: string;
}

/** An observed fetch/XHR exchange. */
export interface HttpObservation {
  /** `traceparent` + `baggage` to add, or null (not a propagation target). */
  readonly headers: Record<string, string> | null;
  finish(result: { status?: number; error?: unknown }): void;
}

/**
 * @internal How integrations feed monitoring without hooking anything twice:
 * the network and history integrations call these (also when no capsule is
 * being recorded). Absent during replay.
 */
export interface MonitorHooks {
  httpStart(request: { kind: 'fetch' | 'xhr'; method: string; url: string }): HttpObservation | null;
  navigation(location: string, source: string, action?: string, routeName?: string): void;
}
