import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assessAttempt, evaluateRun, isMaterialDivergence, UNSAFE_LIVE_DIVERGENCE, type ReplayReport } from '../../packages/web/src/core/index.js';

/** BC-ENT-015: runner-reported egress and `--allow-live` never count as evidence. */
function report(outcome: ReplayReport['outcome'], divergences: ReplayReport['divergences']): ReplayReport {
  return {
    outcome,
    attempt: 1,
    durationMs: 10,
    strategy: 'auto',
    expectedSignature: 'exception:TypeError:x',
    observed: outcome === 'reproduced' ? { signature: 'exception:TypeError:x' } : null,
    otherFailures: [],
    divergences,
    eventsDispatched: 0,
    eventsExpected: 0,
    fixturesServed: 0,
    compressedMs: 0,
    gapsCompressed: 0,
    buildGitSha: null,
    message: null,
    runtime: 'web',
  } as ReplayReport;
}

describe('replay verdicts for runner divergences', () => {
  it('unknown divergence types (network.escaped, restore.disallowed) are material', () => {
    for (const type of ['network.escaped', 'restore.disallowed', 'something.new']) {
      assert.equal(isMaterialDivergence({ type }), true, type);
      assert.equal(assessAttempt(report('not_reproduced', [{ type, detail: 'x' }])).status, 'invalid', type);
    }
    assert.equal(evaluateRun('verify', 1, [report('not_reproduced', [{ type: 'network.escaped', detail: 'POST fetch /api' }])]).verdict, 'inconclusive');
  });

  it('replay.unsafe_live makes any attempt invalid, a reproduction included', () => {
    const live = [{ type: UNSAFE_LIVE_DIVERGENCE, detail: 'POST fetch http://127.0.0.1/api/live' }];
    for (const outcome of ['reproduced', 'not_reproduced'] as const) {
      const a = assessAttempt(report(outcome, live));
      assert.equal(a.status, 'invalid', outcome);
      assert.deepEqual(a.reasonCodes, ['replay.unsafe_live']);
      assert.match(a.reasons[0]!, /replay\.unsafe_live/);
    }
    assert.equal(evaluateRun('replay', 1, [report('reproduced', live)]).verdict, 'inconclusive');
    assert.equal(evaluateRun('verify', 1, [report('not_reproduced', live)]).verdict, 'inconclusive');
    assert.equal(evaluateRun('replay', 1, [report('reproduced', [])]).verdict, 'reproduced', 'unchanged without it');
  });
});
