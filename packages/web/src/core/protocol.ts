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
}
