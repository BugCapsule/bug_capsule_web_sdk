import type { FailureRecord } from './model.js';

/** Replay protocol v1.1 (spec runtimes-v1 §10). */
export const ReplayProtocol = Object.freeze({
  envUrl: 'BUGCAPSULE_REPLAY_URL',
  capsulePath: '/capsule',
  settingsPath: '/settings',
  resultPath: '/result',
  stdoutPrefix: 'BUGCAPSULE_RESULT::',
});

export type ReplayStrategy = 'auto' | 'pointer' | 'semantic';
export type ReplayOutcome = 'reproduced' | 'not_reproduced' | 'incompatible' | 'no_assertion' | 'error';

export interface ReplaySettings {
  strategy: ReplayStrategy;
  settleTimeoutMs: number;
  attempt: number;
  kind: 'replay' | 'verify' | string;
  strictNetwork: boolean;
  idleCompression: boolean;
  attemptId?: string;
  runtime?: string;
}

/** How strongly a clean attempt shows the failing path ran and now behaves (spec verdict-v2). */
export type EvidenceLevel = 'none' | 'weak' | 'strong';

/** What a v2 SDK observed beyond "the failure did not fire" (report field `evidence`). */
export interface ReplayEvidence {
  /**
   * The capsule's failure assertion was evaluated during replay and held
   * (`BugCapsule.check`); absent when it was never evaluated or the failure
   * is not an assertion.
   */
  assertionPassed?: boolean;
  /** `BugCapsule.expect` postconditions, evaluated after replay settled. */
  postconditions?: Record<string, boolean>;
  /** Every recorded input was dispatched and replay settled past the recorded failure point. */
  failurePointPassed: boolean;
}

/** Reads `evidence` from a report's JSON like the Dart reader: unknown shapes become false/absent. Null when not an object. */
export function replayEvidenceFromJson(j: unknown): ReplayEvidence | null {
  if (typeof j !== 'object' || j === null || Array.isArray(j)) return null;
  const o = j as Record<string, unknown>;
  const out: ReplayEvidence = { failurePointPassed: o.failurePointPassed === true };
  if (typeof o.assertionPassed === 'boolean') out.assertionPassed = o.assertionPassed;
  if (typeof o.postconditions === 'object' && o.postconditions !== null && !Array.isArray(o.postconditions)) {
    const entries = Object.entries(o.postconditions as Record<string, unknown>);
    if (entries.length > 0) out.postconditions = Object.fromEntries(entries.map(([k, v]) => [k, v === true]));
  }
  return out;
}

/** Postconditions that did not hold. */
export function failedPostconditions(e: ReplayEvidence | null | undefined): string[] {
  return Object.entries(e?.postconditions ?? {})
    .filter(([, v]) => !v)
    .map(([k]) => k);
}

/** Strong: the assertion or postconditions held; weak: only the failure point was passed; none otherwise or when a postcondition failed. */
export function evidenceLevel(e: ReplayEvidence | null | undefined): EvidenceLevel {
  if (!e) return 'none';
  if (failedPostconditions(e).length > 0) return 'none';
  if (e.assertionPassed === true || Object.keys(e.postconditions ?? {}).length > 0) return 'strong';
  return e.failurePointPassed ? 'weak' : 'none';
}

export function replaySettingsFromJson(j: Record<string, unknown>): ReplaySettings {
  const strategy = j.strategy === 'pointer' || j.strategy === 'semantic' ? j.strategy : 'auto';
  return {
    strategy,
    settleTimeoutMs: typeof j.settleTimeoutMs === 'number' ? j.settleTimeoutMs : 8000,
    attempt: typeof j.attempt === 'number' ? j.attempt : 1,
    kind: typeof j.kind === 'string' ? j.kind : 'replay',
    strictNetwork: typeof j.strictNetwork === 'boolean' ? j.strictNetwork : true,
    idleCompression: typeof j.idleCompression === 'boolean' ? j.idleCompression : true,
    ...(typeof j.attemptId === 'string' ? { attemptId: j.attemptId } : {}),
    ...(typeof j.runtime === 'string' ? { runtime: j.runtime } : {}),
  };
}

export interface Divergence {
  type: string;
  detail: string;
  t?: number;
}

export interface ReplayReport {
  outcome: ReplayOutcome;
  attempt: number;
  durationMs: number;
  strategy: ReplayStrategy;
  expectedSignature: string | null;
  observed: FailureRecord | null;
  otherFailures: FailureRecord[];
  divergences: Divergence[];
  eventsDispatched: number;
  eventsExpected: number | null;
  fixturesServed: number;
  compressedMs: number;
  gapsCompressed: number;
  buildGitSha: string | null;
  message: string | null;
  attemptId?: string;
  runtime?: string;
  /** Positive evidence (verdict v2); absent from SDKs that predate it. */
  evidence?: ReplayEvidence;
}
