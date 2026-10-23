/** Capsule format v1 (spec capsule-v1 + runtimes-v1). */

export const CAPSULE_FORMAT = 'bugcapsule.capsule';
export const SPEC_VERSION = 1;

export type CaptureMode = 'debug' | 'qa' | 'production';
export type CheckpointKind = 'launch' | 'periodic';
export type EligibilityStatus = 'eligible' | 'partial' | 'ineligible';
export type FailureKind = 'exception' | 'assertion' | 'manual';

export interface CapsuleEvent {
  seq: number;
  /** ms since the session anchor (in the recorder: since recording started). */
  t: number;
  type: string;
  data: Record<string, unknown>;
}

export interface Checkpoint {
  kind: CheckpointKind;
  t: number;
  wallClockMs: number;
  afterSeq: number;
  data: Record<string, unknown>;
}

export interface FailureRecord {
  kind: FailureKind;
  signature: string;
  type: string;
  message: string;
  stack?: string | null;
  assertionId?: string | null;
  t: number;
}

export interface MissingDependency {
  dependency: string;
  reason: string;
  blocking?: boolean;
}

export interface Eligibility {
  status: EligibilityStatus;
  missing: MissingDependency[];
}

export interface RuntimeInfo {
  name: string;
  version?: string;
  language?: string;
  frameworks?: string[];
}

/**
 * `manifest.links.sentry`: the Sentry error event this capsule was captured
 * for (written by the `sentryCompanion()` integration).
 */
export interface SentryLink {
  /** Sentry `event_id`: 32 lowercase hex characters. */
  eventId: string;
  /** Project id from the DSN path (digits). */
  projectId?: string;
  /** Organization id from a DSN host `o<digits>.ingest…`, when present. */
  orgId?: string;
  release?: string | null;
  environment?: string | null;
}

/** `manifest.links`: ids of records about this capsule in other tools. */
export interface CapsuleLinks {
  sentry?: SentryLink;
  [k: string]: unknown;
}

export interface Manifest {
  capsuleId: string;
  createdAt: string;
  mode: CaptureMode;
  app: { id?: string | null; name?: string | null; version: string; build: string; flavor?: string | null };
  source?: { gitSha?: string | null; dirty?: boolean | null };
  sdk?: { name?: string | null; version?: string | null };
  stateSchemaVersion?: number;
  platform: {
    os: string;
    osVersion?: string;
    locale?: string;
    screen?: { width?: number; height?: number; pixelRatio?: number };
    userAgent?: string;
    [k: string]: unknown;
  };
  session: { id: string; startedAt: string; wallClockAtAnchorMs: number; seed: number; durationMs: number };
  failure?: FailureRecord | null;
  eligibility: Eligibility;
  integrations?: string[];
  stats?: { eventCount?: number; droppedEvents?: number; checkpointKind?: CheckpointKind };
  labels?: Record<string, string>;
  redaction?: { extraKeys?: string[]; extraHeaders?: string[] };
  runtime?: RuntimeInfo;
  capabilities?: Record<string, string>;
  links?: CapsuleLinks;
  [k: string]: unknown;
}

export interface Capsule {
  format: typeof CAPSULE_FORMAT;
  specVersion: number;
  manifest: Manifest;
  checkpoint: Checkpoint;
  events: CapsuleEvent[];
}

/** The runtime of a capsule without `manifest.runtime` (spec runtimes-v1 §1). */
export function runtimeOf(manifest: Manifest): string {
  if (manifest.runtime?.name) return manifest.runtime.name;
  switch (manifest.sdk?.name) {
    case 'bugcapsule-android':
      return 'android';
    case 'bugcapsule-ios':
      return 'ios';
    case '@bugcapsule/web':
      return 'web';
    default:
      return 'flutter';
  }
}

/** Collects gaps from the core and from every integration. */
export class EligibilityBuilder {
  private readonly items: MissingDependency[] = [];

  missing(dependency: string, reason: string, blocking = false): void {
    const d = dependency.length > 200 ? dependency.substring(0, 200) : dependency;
    const r = reason.length > 2000 ? reason.substring(0, 2000) : reason;
    if (this.items.length >= 200) return;
    if (this.items.some((m) => m.dependency === d && m.reason === r)) return;
    this.items.push(blocking ? { dependency: d, reason: r, blocking: true } : { dependency: d, reason: r });
  }

  build(): Eligibility {
    const status: EligibilityStatus = this.items.some((m) => m.blocking)
      ? 'ineligible'
      : this.items.length === 0
        ? 'eligible'
        : 'partial';
    return { status, missing: [...this.items] };
  }
}

/** Event types defined by the spec; replay dispatches the `replayable` ones. */
export const EventTypes = {
  lifecycle: 'lifecycle',
  pointer: 'pointer',
  action: 'action',
  text: 'text',
  route: 'route',
  state: 'state',
  http: 'http',
  log: 'log',
  failure: 'failure',
} as const;
