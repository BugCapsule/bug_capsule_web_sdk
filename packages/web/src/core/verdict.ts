import type { EligibilityStatus } from './model.js';
import { evidenceLevel, failedPostconditions, type Divergence, type ReplayReport } from './protocol.js';

/**
 * Attempt classification and batch verdicts (port of `verdict.dart`,
 * checked by spec-fixtures/conformance/verdicts.json). The CLI applies the
 * same rules; tools in this repository use them to read replay reports.
 */

/** `replay` expects the original failure; `verify` expects it gone. */
export type RunKind = 'replay' | 'verify';

export type Verdict =
  | 'reproduced'
  | 'notReproduced'
  | 'fixed'
  | 'stillFailing'
  | 'flaky'
  /** verify (v2): baseline reproduced, every candidate attempt clean, but weak evidence or a partial capsule. */
  | 'fixedQualified'
  /** Replay containment was not kept (live traffic allowed): no conclusion. */
  | 'unsafe'
  | 'incompatible'
  | 'inconclusive';

/** Outcome sent to the backend `runs` endpoint for each verdict. */
export const VERDICT_WIRE: Readonly<Record<Verdict, string>> = Object.freeze({
  reproduced: 'reproduced',
  notReproduced: 'not_reproduced',
  fixed: 'not_reproduced',
  stillFailing: 'reproduced',
  flaky: 'flaky',
  // Never satisfies a gate on the backend.
  fixedQualified: 'inconclusive',
  unsafe: 'inconclusive',
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

/**
 * Divergence a runner adds when it let the replay reach the real network on
 * request (`bugcapsule-web-runner --allow-live`). Any report carrying it
 * makes the run {@link Verdict} `unsafe`, whatever the outcomes: a live
 * server may have produced (or hidden) the failure.
 */
export const UNSAFE_LIVE_DIVERGENCE = 'replay.unsafe_live';

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
      return { report: r, status: 'reproduced', reasons: [], reasonCodes: r.divergences.some(d => d.type === 'failure.different_frame') ? ['failure.different_frame'] : [] };
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
      if (r.otherFailures.some(f => f.kind === 'crash') || (r.otherFailures.length > 0 && r.expectedSignature?.startsWith('crash:'))) codes.add('failure.different');
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
  /** 0 success, 1 the opposite, 2 flaky, 3 inconclusive / incompatible, 4 fixed with qualifications, 5 unsafe. */
  exitCode: number;
}

function exitCodeOf(verdict: Verdict): number {
  switch (verdict) {
    case 'reproduced':
    case 'fixed':
      return 0;
    case 'notReproduced':
    case 'stillFailing':
      return 1;
    case 'flaky':
      return 2;
    case 'fixedQualified':
      return 4;
    case 'unsafe':
      return 5;
    default:
      return 3;
  }
}

const hasUnsafeLive = (r: ReplayReport) => r.divergences.some((d) => d.type === UNSAFE_LIVE_DIVERGENCE);

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
  if (reports.some(hasUnsafeLive)) {
    reasons.add('live traffic was allowed during replay');
    verdict = 'unsafe';
  } else if (reports.some((x) => x.outcome === 'incompatible')) verdict = 'incompatible';
  else if (n <= 0 || reports.length > n) verdict = 'inconclusive';
  else if (kind === 'replay') verdict = r === n ? 'reproduced' : c === n ? 'notReproduced' : r > 0 && c > 0 ? 'flaky' : 'inconclusive';
  else verdict = c === n ? 'fixed' : r > 0 && c > 0 ? 'flaky' : r > 0 ? 'stillFailing' : 'inconclusive';
  const exitCode = exitCodeOf(verdict);
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

// ------------------------------------------------------------- verdict v2

/** Baseline attempts below this never support FIXED. */
export const MIN_BASELINE_ATTEMPTS = 3;
/** Candidate attempts are never fewer than this, nor more than {@link MAX_CANDIDATE_ATTEMPTS}. */
export const MIN_CANDIDATE_ATTEMPTS = 5;
export const MAX_CANDIDATE_ATTEMPTS = 30;

/** The baseline build's result for a capsule (spec verdict-v2). */
export interface BaselineResult {
  revision: string;
  attempts: number;
  reproduced: number;
  cached?: boolean;
}

/** Lower bound of the Wilson 95% interval of `successes / n`. */
export function wilsonLower(successes: number, n: number): number {
  if (n <= 0) return 0;
  const z = 1.959963984540054;
  const p = successes / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.min(1, Math.max(0, (centre - margin) / (1 + z2 / n)));
}

/** Candidate attempts so that a build still failing at the baseline's lower rate would pass every attempt with probability below 1%. */
export function requiredCandidateAttempts(baselineReproduced: number, baselineAttempts: number): number {
  const low = wilsonLower(baselineReproduced, baselineAttempts);
  if (low <= 0) return MAX_CANDIDATE_ATTEMPTS;
  if (low >= 1) return MIN_CANDIDATE_ATTEMPTS;
  const n = Math.ceil(Math.log(0.01) / Math.log(1 - low));
  return Math.min(MAX_CANDIDATE_ATTEMPTS, Math.max(MIN_CANDIDATE_ATTEMPTS, n));
}

/**
 * `verify` under verdict v2 (port of `evaluateVerifyV2` in verdict.dart):
 * `candidate` are the candidate build's reports, `baseline` the baseline
 * build's result (null when none could be built). FIXED needs a baseline
 * that reproduced in every one of at least {@link MIN_BASELINE_ATTEMPTS}
 * attempts, at least {@link requiredCandidateAttempts} candidate attempts
 * all clean, strong positive evidence in each, and an eligible capsule. Weak
 * evidence or a partial capsule gives `fixedQualified`; no evidence at all
 * is inconclusive.
 */
export function evaluateVerifyV2(options: {
  requestedAttempts: number;
  candidate: readonly ReplayReport[];
  baseline: BaselineResult | null;
  eligibility: EligibilityStatus;
}): RunEvaluation {
  const { requestedAttempts, candidate, baseline, eligibility } = options;
  const v1 = evaluateRun('verify', requestedAttempts, candidate);
  const reasons = [...v1.reasons];
  const codes = new Set(v1.reasonCodes);
  const result = (verdict: Verdict, reason?: string, code?: string): RunEvaluation => {
    if (reason !== undefined) reasons.push(reason);
    if (code !== undefined) codes.add(code);
    return { ...v1, verdict, reasons, reasonCodes: [...codes].sort(), exitCode: exitCodeOf(verdict) };
  };

  if (candidate.some(hasUnsafeLive)) return result('unsafe', 'live traffic was allowed during replay', 'replay.unsafe');
  if (v1.verdict === 'incompatible' || v1.verdict === 'stillFailing') return result(v1.verdict);
  if (baseline === null) {
    return result(
      'inconclusive',
      "no baseline: the capsule's build could not be replayed, so nothing shows this harness reproduces the failure",
      'baseline.unavailable',
    );
  }
  if (baseline.reproduced === 0) {
    return result('inconclusive', `the baseline build did not reproduce the failure in ${baseline.attempts} attempts`, 'baseline.not_reproduced');
  }
  if (baseline.reproduced < baseline.attempts) {
    return result('flaky', `the baseline build reproduced in ${baseline.reproduced} of ${baseline.attempts} attempts`, 'baseline.flaky');
  }
  if (baseline.attempts < MIN_BASELINE_ATTEMPTS) {
    return result('inconclusive', `the baseline ran ${baseline.attempts} attempts; at least ${MIN_BASELINE_ATTEMPTS} are needed`, 'baseline.too_few');
  }
  const needed = requiredCandidateAttempts(baseline.reproduced, baseline.attempts);
  if (requestedAttempts < needed) {
    return result(
      'inconclusive',
      `${requestedAttempts} candidate attempts; ${needed} are needed after a ${baseline.reproduced}/${baseline.attempts} baseline`,
      'attempts.too_few',
    );
  }
  if (v1.verdict !== 'fixed') return result(v1.verdict);
  if (eligibility === 'ineligible') return result('inconclusive', 'the capsule is ineligible for replay', 'capsule.ineligible');
  const levels = v1.attempts.map((a) => evidenceLevel(a.report.evidence));
  if (levels.includes('none')) {
    const failed = new Set(v1.attempts.flatMap((a) => failedPostconditions(a.report.evidence)));
    if (failed.size > 0) return result('stillFailing', `postconditions did not hold: ${[...failed].join(', ')}`, 'postcondition.failed');
    return result(
      'inconclusive',
      'no positive evidence: nothing shows the failing path ran (update the SDK, or register a postcondition with BugCapsule.expect)',
      'evidence.none',
    );
  }
  const weak = levels.includes('weak');
  const partial = eligibility === 'partial';
  if (weak || partial) {
    return result(
      'fixedQualified',
      [
        ...(weak ? ['only shows the recorded failure point was passed (no assertion or postcondition held)'] : []),
        ...(partial ? ['the capsule is partial: some inputs were not recorded'] : []),
      ].join('; '),
      weak ? 'evidence.weak' : 'capsule.partial',
    );
  }
  return result('fixed');
}
