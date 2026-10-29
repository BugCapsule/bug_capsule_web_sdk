/**
 * HTTP glue: a framework-neutral check that yields either the decision or a
 * ready 503 problem response, and an Express/Connect-style middleware.
 */
import type { Decision } from './contract.js';
import { EmergencyBlockedError, type EmergencyProblem, type Operation } from './errors.js';
import type { Consistency, EmergencyGuard } from './guard.js';

export interface ProblemResponse {
  status: 503;
  headers: Record<string, string>;
  body: string;
  problem: EmergencyProblem;
}

export interface ProblemResponseOptions {
  /** Adds `Retry-After` (seconds). */
  retryAfterSeconds?: number;
  /** Problem `type` URI. */
  type?: string;
  /** Problem `instance`, e.g. the request path or id. */
  instance?: string;
}

/** The 503 `application/problem+json` response for a refused operation. */
export function problemResponse(error: EmergencyBlockedError, options: ProblemResponseOptions = {}): ProblemResponse {
  const problemOptions: { type?: string; instance?: string } = {};
  if (options.type !== undefined) problemOptions.type = options.type;
  if (options.instance !== undefined) problemOptions.instance = options.instance;
  const problem = error.toProblem(problemOptions);
  const headers: Record<string, string> = { 'content-type': 'application/problem+json', 'cache-control': 'no-store' };
  if (options.retryAfterSeconds !== undefined) headers['retry-after'] = String(Math.max(0, Math.round(options.retryAfterSeconds)));
  return { status: 503, headers, body: JSON.stringify(problem), problem };
}

export interface CheckRequestOptions extends ProblemResponseOptions {
  featureKey: string;
  operation?: Operation;
  subject?: string | null;
  consistency?: Consistency;
  timeoutMs?: number;
}

export type CheckResult = { ok: true; decision: Decision } | { ok: false; error: EmergencyBlockedError; response: ProblemResponse };

/**
 * Framework-neutral: runs `guard.enforce` and turns a refusal into a
 * response you can send with any framework. Other errors are rethrown.
 */
export async function checkRequest(guard: EmergencyGuard, options: CheckRequestOptions): Promise<CheckResult> {
  try {
    const decision = await guard.enforce({
      featureKey: options.featureKey,
      ...(options.operation !== undefined ? { operation: options.operation } : {}),
      ...(options.subject !== undefined ? { subject: options.subject } : {}),
      ...(options.consistency !== undefined ? { consistency: options.consistency } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    return { ok: true, decision };
  } catch (e) {
    if (e instanceof EmergencyBlockedError) return { ok: false, error: e, response: problemResponse(e, options) };
    throw e;
  }
}

/** The response surface the middleware needs; Node's ServerResponse and Express's Response both have it. */
export interface MinimalResponse {
  statusCode: number;
  headersSent?: boolean;
  setHeader(name: string, value: string): unknown;
  end(body?: string): unknown;
  locals?: Record<string, unknown>;
}

export interface EmergencyMiddlewareOptions<Req> extends ProblemResponseOptions {
  featureKey: string | ((req: Req) => string);
  operation?: Operation | ((req: Req) => Operation);
  /** The actor or operation id for partial rollouts (pseudonymous, never an email). */
  subject?: (req: Req) => string | null | undefined;
  consistency?: Consistency;
  timeoutMs?: number;
  /** Called with every refusal, e.g. for logging or metrics. */
  onBlocked?: (error: EmergencyBlockedError, req: Req) => void;
}

/**
 * Express/Connect-style middleware: `(req, res, next)`. Allowed requests
 * continue with the decision at `res.locals.emergencyDecision` (when
 * `res.locals` exists); refused ones get 503 `application/problem+json`.
 * Mount it on the route that commits, and still call `guard.enforce()`
 * right before the irreversible step if the handler does slow work first.
 */
export function emergencyMiddleware<Req = unknown, Res extends MinimalResponse = MinimalResponse>(
  guard: EmergencyGuard,
  options: EmergencyMiddlewareOptions<Req>,
): (req: Req, res: Res, next: (err?: unknown) => void) => void {
  return (req, res, next) => {
    let check: CheckRequestOptions;
    try {
      const subject = options.subject ? options.subject(req) : undefined;
      check = {
        featureKey: typeof options.featureKey === 'function' ? options.featureKey(req) : options.featureKey,
        ...(options.operation !== undefined ? { operation: typeof options.operation === 'function' ? options.operation(req) : options.operation } : {}),
        ...(subject !== undefined ? { subject } : {}),
        ...(options.consistency !== undefined ? { consistency: options.consistency } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.retryAfterSeconds !== undefined ? { retryAfterSeconds: options.retryAfterSeconds } : {}),
        ...(options.type !== undefined ? { type: options.type } : {}),
        ...(options.instance !== undefined ? { instance: options.instance } : {}),
      };
    } catch (e) {
      next(e);
      return;
    }
    checkRequest(guard, check).then(
      (result) => {
        if (result.ok) {
          if (res.locals) res.locals.emergencyDecision = result.decision;
          next();
          return;
        }
        try {
          options.onBlocked?.(result.error, req);
        } catch {
          // A failing hook must not turn a refusal into a pass.
        }
        if (res.headersSent) {
          next(result.error);
          return;
        }
        sendProblem(res, result.response);
      },
      (e: unknown) => next(e),
    );
  };
}

/** Writes a ProblemResponse to a Node/Express response. */
export function sendProblem(res: MinimalResponse, response: ProblemResponse): void {
  res.statusCode = response.status;
  for (const [name, value] of Object.entries(response.headers)) res.setHeader(name, value);
  res.end(response.body);
}
