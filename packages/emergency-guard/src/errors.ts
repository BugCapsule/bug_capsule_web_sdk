import type { Action, Decision, DecisionSource } from './contract.js';

export type Operation = 'read' | 'write';

/** RFC 9457 problem details body returned for a refused operation. */
export interface EmergencyProblem {
  type: string;
  title: string;
  status: 503;
  detail: string;
  instance?: string;
  code: 'emergency_blocked';
  featureKey: string;
  operation: Operation;
  action: Action;
  reasonCode: string | null;
  policyId: string | null;
  policyRevision: number | null;
  documentRevision: number | null;
  requiredVersion: string | null;
  fallback: string | null;
  source: DecisionSource;
  retryable: true;
}

export const PROBLEM_TYPE = 'urn:bugcapsule:problem:emergency-blocked';
export const DEFAULT_PUBLIC_MESSAGE = 'This action is temporarily unavailable. Please try again later.';

/**
 * Thrown by `guard.enforce()` when an emergency policy (or the feature's
 * failure mode) refuses the operation. Nothing irreversible may happen after
 * it is thrown. Machine-readable: `code`, `featureKey`, `action`,
 * `reasonCode`, `policyRevision`; `toProblem()` gives a 503 problem body.
 */
export class EmergencyBlockedError extends Error {
  override readonly name = 'EmergencyBlockedError';
  readonly code = 'emergency_blocked' as const;
  readonly status = 503 as const;
  /** The block is temporary: the same request can succeed after the policy is lifted. */
  readonly retryable = true as const;
  readonly featureKey: string;
  readonly operation: Operation;
  readonly action: Action;
  readonly reasonCode: string | null;
  /** Safe to show to end users; null when the policy has none. */
  readonly publicUserMessage: string | null;
  readonly policyId: string | null;
  readonly policyRevision: number | null;
  readonly documentRevision: number | null;
  readonly decision: Decision;

  constructor(decision: Decision, operation: Operation) {
    super(`${decision.featureKey} (${operation}) refused by emergency policy: ${decision.action}${decision.reasonCode ? ` (${decision.reasonCode})` : ''}`);
    this.decision = decision;
    this.operation = operation;
    this.featureKey = decision.featureKey;
    this.action = decision.action;
    this.reasonCode = decision.reasonCode;
    this.publicUserMessage = decision.publicUserMessage;
    this.policyId = decision.policyId;
    this.policyRevision = decision.policyRevision;
    this.documentRevision = decision.documentRevision;
  }

  /** RFC 9457 body for `Content-Type: application/problem+json` with HTTP status 503. */
  toProblem(options: { type?: string; instance?: string } = {}): EmergencyProblem {
    const d = this.decision;
    return {
      type: options.type ?? PROBLEM_TYPE,
      title: 'Temporarily unavailable',
      status: 503,
      detail: d.publicUserMessage ?? DEFAULT_PUBLIC_MESSAGE,
      ...(options.instance !== undefined ? { instance: options.instance } : {}),
      code: 'emergency_blocked',
      featureKey: d.featureKey,
      operation: this.operation,
      action: d.action,
      reasonCode: d.reasonCode,
      policyId: d.policyId,
      policyRevision: d.policyRevision,
      documentRevision: d.documentRevision,
      requiredVersion: d.requiredVersion,
      fallback: d.fallback,
      source: d.source,
      retryable: true,
    };
  }
}

export function isEmergencyBlockedError(e: unknown): e is EmergencyBlockedError {
  return e instanceof EmergencyBlockedError || (typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'emergency_blocked' && typeof (e as { toProblem?: unknown }).toProblem === 'function');
}
