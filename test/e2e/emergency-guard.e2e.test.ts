/**
 * Opt-in end-to-end check of @bugcapsule/emergency-guard against a real
 * BugCapsule backend. Runs only when every variable below is set:
 *
 *   BUGCAPSULE_EMERGENCY_E2E_URL            API base URL, e.g. https://api.bugcapsule.com
 *   BUGCAPSULE_EMERGENCY_E2E_KEY            SDK token (bcsdk.v1…) or ingest key (bct_…)
 *   BUGCAPSULE_EMERGENCY_E2E_ANCHOR         trust anchor (bcek.v1…)
 *   BUGCAPSULE_EMERGENCY_E2E_ENV            environment, e.g. staging
 *   BUGCAPSULE_EMERGENCY_E2E_FEATURE        feature key to evaluate
 *   BUGCAPSULE_EMERGENCY_E2E_EXPECT_ACTION  expected action for that key (ALLOW, BLOCK, READ_ONLY, …)
 *
 *   npm run test:e2e:emergency-guard
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ACTIONS, createEmergencyGuard, EmergencyBlockedError, permits, type Action } from '../../packages/emergency-guard/src/index.js';

const PREFIX = 'BUGCAPSULE_EMERGENCY_E2E_';
const names = ['URL', 'KEY', 'ANCHOR', 'ENV', 'FEATURE', 'EXPECT_ACTION'] as const;
const env = Object.fromEntries(names.map((n) => [n, process.env[PREFIX + n]?.trim() ?? ''])) as Record<(typeof names)[number], string>;
const missing = names.filter((n) => !env[n]).map((n) => PREFIX + n);
const skip = missing.length > 0 ? `set ${missing.join(', ')} to run` : false;

describe('emergency guard against a real backend', { skip }, () => {
  it('fetches, verifies and enforces the live document', async () => {
    const expected = env.EXPECT_ACTION.toUpperCase() as Action;
    assert.ok((ACTIONS as readonly string[]).includes(expected), `${PREFIX}EXPECT_ACTION must be one of ${ACTIONS.join(', ')}`);
    const guard = createEmergencyGuard({
      apiUrl: env.URL,
      credential: env.KEY,
      trustAnchor: env.ANCHOR,
      environment: env.ENV,
      refreshIntervalMs: 60_000,
      strongTimeoutMs: 5000,
    });
    try {
      await guard.start();
      const s = guard.status();
      assert.equal(s.anchorValid, true);
      assert.equal(s.credentialRejected, false, 'the credential was refused');
      assert.equal(s.state, 'usable', `no usable document: ${JSON.stringify(s.lastError)}`);
      assert.equal(s.lastError, null);

      const decision = guard.evaluate(env.FEATURE, { subject: null });
      assert.equal(decision.source, 'policy');
      assert.equal(decision.action, expected);
      assert.equal(decision.documentRevision, s.revision);

      // A second, conditional fetch must come back as 304 (or the same document).
      const outcome = await guard.refresh();
      assert.ok(['not_modified', 'unchanged', 'updated'].includes(outcome.kind), JSON.stringify(outcome));

      try {
        const d = await guard.enforce({ featureKey: env.FEATURE, operation: 'write', subject: null, consistency: 'strong' });
        assert.ok(permits(d, 'write'));
        assert.equal(expected, 'ALLOW');
      } catch (e) {
        if (!(e instanceof EmergencyBlockedError)) throw e;
        assert.equal(e.action, expected);
        assert.equal(e.toProblem().status, 503);
      }
    } finally {
      guard.stop();
    }
  });
});
