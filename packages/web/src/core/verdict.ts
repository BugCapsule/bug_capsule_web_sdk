import type { Divergence, ReplayReport } from './protocol.js';

/**
 * Attempt classification and batch verdicts (port of `verdict.dart`,
 * checked by spec-fixtures/conformance/verdicts.json). The CLI applies the
 * same rules; tools in this repository use them to read replay reports.
 */

/** `replay` expects the original failure; `verify` expects it gone. */
export type RunKind = 'replay' | 'verify';

export type Verdict = 'reproduced' | 'notReproduced' | 'fixed' | 'stillFailing' | 'flaky' | 'incompatible' | 'inconclusive';

/** Outcome sent to the backend `runs` endpoint for each verdict. */
export const VERDICT_WIRE: Readonly<Record<Verdict, string>> = Object.freeze({
  reproduced: 'reproduced',
  notReproduced: 'not_reproduced',
  fixed: 'not_reproduced',
  stillFailing: 'reproduced',
  flaky: 'flaky',
  incompatible: 'incompatible',
  inconclusive: 'inconclusive',
});

/** How one attempt counts toward the verdict. */
export type AttemptStatus = 'reproduced' | 'clean' | 'invalid';

/**
 * Divergences that are expected between a recording and a replay. Everything
 * else, including types this version does not know, is material: an unknown
 * difference must not be able to produce a "fixed" verdict.
 */
export const EXPECTED_DIVERGENCES: ReadonlySet<string> = new Set([
  // verify builds a different commit on purpose; replay warns about it.
  'build.gitSha',
  // pointer replay scales coordinates to the replay screen.
  'screen.size',
  // the recording continues after the failure; a fix may also skip calls.
  'network.unused',
  // capsule-v2 §5: interactions recorded after the failure.
  'ws.unusedAfterFailure',
  'platform.unusedAfterFailure',
  'native.unusedAfterFailure',
]);

export function isMaterialDivergence(d: Pick<Divergence, 'type'>): boolean {
  return !EXPECTED_DIVERGENCES.has(d.type);
}

/** The capsule-v2 §8 reason code of a material interaction divergence, or null for other types. */
export function interactionReasonCode(type: string): string | null {
  if (type === 'dependency.live' || type === 'dependency.late') return 'interaction.live';
  const family = type.split('.')[0]!;
  if (family !== 'ws' && family !== 'platform' && family !== 'native') return null;
  switch (type.substring(family.length + 1)) {
    case 'unused':
    case 'undelivered':
      return 'interaction.missing';
    case 'unrecorded':
      return 'interaction.unexpected';
    case 'mismatch':
      return 'interaction.mismatch';
    case 'noPayload':
      return 'interaction.incomplete';
    case 'unrestored':
      return 'interaction.unrestored';
    default:
      return null;
  }
}

export interface AttemptAssessment {
  report: ReplayReport;
  status: AttemptStatus;
  /** Why an attempt is invalid (empty otherwise). */
  reasons: string[];
  /** Machine-readable codes for reasons that concern interaction dependencies (capsule-v2 §8), sorted. */
  reasonCodes: string[];
}

/**
 * Classifies one attempt. A reproduction counts whatever else happened. A
 * run without the failure is clean only when it is complete and faithful:
 * an assertion to check, every recorded input dispatched, no other failure,
 * and no material divergence.
 */
export function assessAttempt(r: ReplayReport): AttemptAssessment {
  const reasons: string[] = [];
  const codes = new Set<string>();
  switch (r.outcome) {
    case 'reproduced':
      if (r.expectedSignature === null || r.expectedSignature === undefined) {
        return { report: r, status: 'invalid', reasons: ['reported a reproduction without an expected failure'], reasonCodes: [] };
      }
      return { report: r, status: 'reproduced', reasons: [], reasonCodes: [] };
    case 'incompatible':
      reasons.push(`incompatible: ${r.message ?? 'capsule cannot run against this build'}`);
      if (r.message?.startsWith('dependency.')) codes.add('dependency.unsupported');
      break;
    case 'no_assertion':
      reasons.push('capsule has no failure assertion');
      break;
    case 'error':
      reasons.push(`replay error: ${r.message ?? 'unknown'}`);
      break;
    case 'not_reproduced': {
      if (r.expectedSignature === null || r.expectedSignature === undefined) reasons.push('no expected failure to check');
      const expected = r.eventsExpected;
      if (expected !== null && expected !== undefined && r.eventsDispatched < expected) {
        reasons.push(`only ${r.eventsDispatched} of ${expected} recorded inputs were replayed`);
      }
      for (const f of r.otherFailures) reasons.push(`unexpected failure: ${f.signature}`);
      const material = new Set(r.divergences.filter(isMaterialDivergence).map((d) => d.type));
      for (const type of material) {
        const n = r.divergences.filter((d) => d.type === type).length;
        reasons.push(`divergence ${type}${n > 1 ? ` ×${n}` : ''}`);
        const code = interactionReasonCode(type);
        if (code !== null) codes.add(code);
      }
      break;
    }
  }
  return { report: r, status: reasons.length === 0 ? 'clean' : 'invalid', reasons, reasonCodes: [...codes].sort() };
}

export interface RunEvaluation {
  kind: RunKind;
  requestedAttempts: number;
  verdict: Verdict;
  attempts: AttemptAssessment[];
  /** Why the verdict is not a clean success (deduplicated). */
  reasons: string[];
  /** Interaction reason codes over all attempts (capsule-v2 §8), sorted. */
  reasonCodes: string[];
  /** Attempts that count as evidence (reproduced or clean). */
  validAttempts: number;
  /** 0 success, 1 the opposite, 2 flaky, 3 inconclusive / incompatible. */
  exitCode: number;
}

/**
 * The verdict rules shared by `bugcapsule run`, `verify` and `regress run`.
 * With N requested attempts, R reproductions and C clean attempts: any
 * attempt incompatible → incompatible; N == 0 → inconclusive; replay: R == N
 * → reproduced, C == N → notReproduced, R > 0 and C > 0 → flaky, otherwise
 * inconclusive; verify: C == N → fixed, R > 0 and C > 0 → flaky, R > 0 →
 * stillFailing, otherwise inconclusive. Attempts that never ran count
 * against N.
 */
export function evaluateRun(kind: RunKind, requestedAttempts: number, reports: readonly ReplayReport[]): RunEvaluation {
  const attempts = reports.map(assessAttempt);
  const reasons = new Set<string>();
  for (const a of attempts) for (const reason of a.reasons) reasons.add(reason);
  if (reports.length > requestedAttempts) reasons.add(`${reports.length} reports for ${requestedAttempts} requested attempts`);
  const missing = requestedAttempts - attempts.length;
  if (missing > 0) reasons.add(`${missing} of ${requestedAttempts} requested attempts did not run`);
  if (requestedAttempts <= 0) reasons.add('no attempts were requested');

  const n = requestedAttempts;
  const r = attempts.filter((a) => a.status === 'reproduced').length;
  const c = attempts.filter((a) => a.status === 'clean').length;
  let verdict: Verdict;
  if (reports.some((x) => x.outcome === 'incompatible')) verdict = 'incompatible';
  else if (n <= 0 || reports.length > n) verdict = 'inconclusive';
  else if (kind === 'replay') verdict = r === n ? 'reproduced' : c === n ? 'notReproduced' : r > 0 && c > 0 ? 'flaky' : 'inconclusive';
  else verdict = c === n ? 'fixed' : r > 0 && c > 0 ? 'flaky' : r > 0 ? 'stillFailing' : 'inconclusive';
  const exitCode = verdict === 'reproduced' || verdict === 'fixed' ? 0 : verdict === 'notReproduced' || verdict === 'stillFailing' ? 1 : verdict === 'flaky' ? 2 : 3;
  return {
    kind,
    requestedAttempts,
    verdict,
    attempts,
    reasons: [...reasons],
    reasonCodes: [...new Set(attempts.flatMap((a) => a.reasonCodes))].sort(),
    validAttempts: r + c,
    exitCode,
  };
}
