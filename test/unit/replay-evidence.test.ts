import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { BugCapsule } from '../../packages/web/src/bugcapsule.js';
import { evidenceLevel, replayEvidenceFromJson, type ReplayReport } from '../../packages/web/src/core/index.js';
import { parseRemoteConfig, type BugCapsuleTransport } from '../../packages/web/src/remote-config.js';
import { MemoryStorage } from '../../packages/web/src/storage/idb.js';
import type { BugCapsuleConfig, UploadResult } from '../../packages/web/src/types.js';

/**
 * Verdict v2 evidence (spec verdict-v2; mirrors the Flutter
 * replay_evidence_test): a clean replay says whether the capsule's assertion
 * ran and held, what the postconditions returned, and whether replay got
 * past the recorded failure point.
 */
class Transport implements BugCapsuleTransport {
  capsules: any[] = [];
  async fetchConfig() {
    return { ok: true as const, config: parseRemoteConfig({ enabled: true, sampleRate: 1 }, Date.now()) };
  }
  async upload(bytes: Uint8Array): Promise<UploadResult> {
    this.capsules.push(JSON.parse(gunzipSync(bytes).toString('utf8')));
    return { status: 'uploaded', serverId: 's' };
  }
}

const until = async (cond: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const base: BugCapsuleConfig = { appVersion: '1.0.0', appBuild: '1', mode: 'qa', gitSha: 'abc', monitoring: false, consoleBreadcrumbs: false };
let capsule: any;

before(async () => {
  const t = new Transport();
  BugCapsule.setTestOverrides({ storage: new MemoryStorage(), transport: t, random: () => 0.01, bridge: null });
  let evaluated = 0;
  BugCapsule.expect('outside.replay', () => {
    evaluated++;
    return true;
  });
  await BugCapsule.init(base);
  await new Promise((r) => setTimeout(r, 20));
  // The capsule's failure is the assertion `cart.total`.
  BugCapsule.check('cart.total', false, 'total was negative');
  await until(() => t.capsules.length === 1);
  capsule = t.capsules[0];
  assert.equal(evaluated, 0, 'expect is a no-op outside replay');
  await BugCapsule.resetForTest();
  BugCapsule.setTestOverrides(undefined);
});

afterEach(async () => {
  await BugCapsule.resetForTest();
  BugCapsule.setTestOverrides(undefined);
});

/** Replays the capsule; `app` is the replayed app's code, run right after init. */
async function replay(app: () => void): Promise<ReplayReport> {
  const reports: ReplayReport[] = [];
  BugCapsule.setTestOverrides({
    storage: new MemoryStorage(),
    random: () => 0.01,
    bridge: {
      load: async () => ({ capsule, settings: { strategy: 'semantic', settleTimeoutMs: 150, attempt: 1, kind: 'verify', strictNetwork: true, idleCompression: true } }),
      pointer: async () => {},
      report: async (r) => void reports.push(r),
    },
  });
  await BugCapsule.init({ ...base, allowReplay: true });
  app();
  await until(() => reports.length === 1);
  // The report crosses the bridge as JSON.
  return JSON.parse(JSON.stringify(reports[0]));
}

describe('replay evidence', () => {
  it('the capsule fails on the cart.total assertion', () => {
    assert.equal(capsule.manifest.failure.kind, 'assertion');
    assert.equal(capsule.manifest.failure.assertionId, 'cart.total');
  });

  it('a fixed app: assertion held and postconditions reported ⇒ strong', async () => {
    const r = await replay(() => {
      BugCapsule.expect('cart.total_positive', () => true);
      BugCapsule.check('cart.total', true);
    });
    assert.equal(r.outcome, 'not_reproduced');
    assert.deepEqual(r.evidence, { assertionPassed: true, postconditions: { 'cart.total_positive': true }, failurePointPassed: true });
    assert.equal(evidenceLevel(r.evidence), 'strong');
    assert.equal(evidenceLevel(replayEvidenceFromJson(r.evidence)), 'strong');
  });

  it('an app that never evaluates the assertion: at most weak evidence', async () => {
    const r = await replay(() => {});
    assert.equal(r.outcome, 'not_reproduced');
    assert.equal(r.evidence!.assertionPassed, undefined);
    assert.equal(r.evidence!.failurePointPassed, true);
    assert.equal(evidenceLevel(r.evidence), 'weak');
  });

  it('a check of another assertion is not evidence for this one', async () => {
    const r = await replay(() => BugCapsule.check('profile.loaded', true));
    assert.equal(r.evidence!.assertionPassed, undefined);
    assert.equal(evidenceLevel(r.evidence), 'weak');
  });

  it('a postcondition that did not hold, or threw, leaves no evidence', async () => {
    const r = await replay(() => {
      BugCapsule.expect('cart.total_positive', () => false);
      BugCapsule.expect('cart.loaded', () => {
        throw new Error('app bug');
      });
      BugCapsule.check('cart.total', true);
    });
    assert.deepEqual(r.evidence!.postconditions, { 'cart.total_positive': false, 'cart.loaded': false });
    assert.equal(evidenceLevel(r.evidence), 'none');
  });

  it('a reproduction carries no fix evidence', async () => {
    let evaluated = 0;
    const r = await replay(() => {
      BugCapsule.expect('cart.total_positive', () => {
        evaluated++;
        return true;
      });
      BugCapsule.check('cart.total', true);
      BugCapsule.check('cart.total', false, 'total was negative');
    });
    assert.equal(r.outcome, 'reproduced');
    assert.deepEqual(r.evidence, { failurePointPassed: false });
    assert.equal(evidenceLevel(r.evidence), 'none');
    assert.equal(evaluated, 0, 'postconditions are evaluated only after a clean replay');
  });
});
