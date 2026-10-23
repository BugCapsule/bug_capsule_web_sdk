/**
 * Sentry companion: run BugCapsule next to Sentry. Sentry stays the error
 * tool; BugCapsule captures the replayable capsule for the same failure, and
 * both sides record the other's id:
 *
 * - the Sentry event gets the tag `bugcapsule.capsule_id` (when a capsule was
 *   scheduled), the tag `bugcapsule.capture` (why or why not) and
 *   `contexts.bugcapsule = { capsule_id, capture }`;
 * - the capsule gets `manifest.links.sentry = { eventId, projectId, orgId,
 *   release, environment }`.
 *
 * Only structural types are used here: the package has no dependency on
 * `@sentry/*`.
 */
import { activeRuntime } from '../bugcapsule.js';
import type { SentryLink } from '../core/model.js';
import type { CaptureDecision } from '../runtime.js';

/** The parts of a Sentry event the companion reads and annotates. */
export interface SentryEventLike {
  event_id?: string;
  type?: string;
  level?: string;
  release?: string;
  environment?: string;
  exception?: { values?: unknown[] };
  tags?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
}

/** The parts of a Sentry event hint the companion reads. */
export interface SentryEventHintLike {
  event_id?: string;
  originalException?: unknown;
}

/** The parts of a Sentry client the companion reads. */
export interface SentryClientLike {
  getDsn?(): { projectId?: string; host?: string } | undefined;
  getOptions?(): { dsn?: string };
}

/** Structurally a Sentry integration (`Sentry.init({ integrations: [...] })`, `Sentry.addIntegration`). */
export interface SentryCompanionIntegration {
  readonly name: 'BugCapsule';
  setupOnce(): void;
  setup(client: SentryClientLike): void;
  processEvent<E extends SentryEventLike>(event: E, hint: SentryEventHintLike | undefined, client?: SentryClientLike): E;
}

export interface SentryCompanionOptions {
  /** Log internal companion errors with `console.debug` (default false; the event is always sent unchanged). */
  debug?: boolean;
}

export type { CaptureDecision };

export const SENTRY_TAG_CAPSULE_ID = 'bugcapsule.capsule_id';
export const SENTRY_TAG_CAPTURE = 'bugcapsule.capture';

const EVENT_ID = /^[0-9a-f]{32}$/;
const DIGITS = /^\d+$/;
const ORG_HOST = /^o(\d+)\.ingest\./i;

function cut(s: string, max: number): string {
  return s.length <= max ? s : s.substring(0, max);
}

/** Sentry error events: no `type` (transactions, feedback, replays … have one) and an exception or error level. */
function isErrorEvent(event: SentryEventLike): boolean {
  if (event.type !== undefined && event.type !== null && event.type !== '') return false;
  return hasException(event) || event.level === 'error' || event.level === 'fatal';
}

function hasException(event: SentryEventLike): boolean {
  return Array.isArray(event.exception?.values) && event.exception.values.length > 0;
}

function lastException(event: SentryEventLike): { type?: string; value?: string } | null {
  const values = event.exception?.values;
  const last = Array.isArray(values) ? values[values.length - 1] : undefined;
  if (typeof last !== 'object' || last === null) return null;
  const { type, value } = last as { type?: unknown; value?: unknown };
  return { ...(typeof type === 'string' ? { type } : {}), ...(typeof value === 'string' ? { value } : {}) };
}

function dsnIds(client: SentryClientLike | undefined): { projectId?: string; orgId?: string } {
  let host: string | undefined;
  let projectId: string | undefined;
  const dsn = client?.getDsn?.();
  if (dsn) {
    host = dsn.host;
    projectId = dsn.projectId;
  } else {
    const raw = client?.getOptions?.().dsn;
    if (typeof raw === 'string') {
      try {
        const url = new URL(raw);
        host = url.hostname;
        projectId = url.pathname.split('/').filter(Boolean).pop();
      } catch {
        // not a URL: no ids
      }
    }
  }
  const org = typeof host === 'string' ? ORG_HOST.exec(host)?.[1] : undefined;
  return {
    ...(typeof projectId === 'string' && DIGITS.test(projectId) ? { projectId: cut(projectId, 200) } : {}),
    ...(org ? { orgId: cut(org, 200) } : {}),
  };
}

function linkFor(event: SentryEventLike, hint: SentryEventHintLike | undefined, client: SentryClientLike | undefined): SentryLink | null {
  const eventId = event.event_id ?? hint?.event_id;
  if (typeof eventId !== 'string' || !EVENT_ID.test(eventId)) return null;
  return {
    eventId,
    ...dsnIds(client),
    release: typeof event.release === 'string' ? cut(event.release, 200) : null,
    environment: typeof event.environment === 'string' ? cut(event.environment, 200) : null,
  };
}

/** Adds the tags and context in place (the event is never replaced). */
function annotate<E extends SentryEventLike>(event: E, capsuleId: string | null, capture: CaptureDecision): E {
  const tags: Record<string, unknown> = { ...(event.tags ?? {}), [SENTRY_TAG_CAPTURE]: capture };
  if (capsuleId) tags[SENTRY_TAG_CAPSULE_ID] = capsuleId;
  else delete tags[SENTRY_TAG_CAPSULE_ID];
  const contexts: Record<string, unknown> = { ...(event.contexts ?? {}), bugcapsule: { capsule_id: capsuleId, capture } };
  event.tags = tags;
  event.contexts = contexts;
  return event;
}

/**
 * A Sentry integration that links each Sentry error event with the
 * BugCapsule capsule captured for the same failure.
 *
 * ```ts
 * import * as Sentry from '@sentry/browser';
 * import { BugCapsule, sentryCompanion } from '@bugcapsule/web';
 *
 * Sentry.init({ dsn: '…', integrations: [sentryCompanion()] });
 * await BugCapsule.init({ appVersion: '1.4.0', appBuild: '52', backend: { … }, monitoring: false });
 * ```
 *
 * Initialization order does not matter. The companion never throws, never
 * waits for uploads, and never copies recorded data into Sentry (only the
 * capsule id and the capture reason).
 */
export function sentryCompanion(options: SentryCompanionOptions = {}): SentryCompanionIntegration {
  let setupClient: SentryClientLike | undefined;
  return {
    name: 'BugCapsule',
    setupOnce() {},
    setup(client) {
      setupClient = client;
    },
    processEvent(event, hint, client) {
      try {
        if (!event || typeof event !== 'object' || !isErrorEvent(event)) return event;
        const runtime = activeRuntime();
        if (!runtime) return annotate(event, null, 'disabled');
        const outcome = runtime.sentryEvent({
          error: hint?.originalException,
          hasError: typeof hint === 'object' && hint !== null && 'originalException' in hint,
          hasException: hasException(event),
          fallback: lastException(event),
          link: linkFor(event, hint, client ?? setupClient),
        });
        return annotate(event, outcome.capsuleId, outcome.capture);
      } catch (e) {
        if (options.debug) console.debug(`[bugcapsule] sentry companion error ignored: ${String(e)}`);
        return event;
      }
    },
  };
}
