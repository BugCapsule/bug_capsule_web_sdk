import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';
import { storageKeyAllowed, storageSeed } from '../../packages/web/src/core/model.js';
import { validateCapsuleDocument } from '../../packages/web/src/core/validator.js';
import { localStorageIntegration } from '../../packages/web/src/integrations/storage.js';
import type { BugCapsuleSession } from '../../packages/web/src/types.js';

/** BC-ENT-013: restore applies the same key policy as capture, in the SDK and in the runner. */
const policy = { allowPrefixes: ['shop.'], denyPrefixes: ['shop.secret'] };

describe('storage key policy', () => {
  it('allows allowlisted keys, denies win, no policy allows nothing', () => {
    assert.equal(storageKeyAllowed(policy, 'shop.cart'), true);
    assert.equal(storageKeyAllowed(policy, 'shop.secret.token'), false);
    assert.equal(storageKeyAllowed(policy, 'auth.token'), false);
    assert.equal(storageKeyAllowed(undefined, 'shop.cart'), false);
  });

  it('the runner seeds only keys the manifest policy allows and reports the rest', () => {
    const data = { 'shop.cart': '[1]', 'shop.secret.x': 's', 'auth.token': 't', 'shop.n': 5 };
    assert.deepEqual(storageSeed({ storagePolicy: { local_storage: policy } }, 'local_storage', data), {
      seed: { 'shop.cart': '[1]' },
      skipped: ['shop.secret.x', 'auth.token', 'shop.n'],
    });
    // A capsule without a policy (older SDK, or an area it did not record) seeds nothing.
    assert.deepEqual(storageSeed({}, 'local_storage', { 'shop.cart': '[1]' }), { seed: {}, skipped: ['shop.cart'] });
    assert.deepEqual(storageSeed({ storagePolicy: { local_storage: policy } }, 'session_storage', { 'shop.cart': '[1]' }), { seed: {}, skipped: ['shop.cart'] });
    assert.deepEqual(storageSeed({ storagePolicy: { local_storage: policy } }, 'local_storage', null), { seed: {}, skipped: [] });
  });

  it('manifest.storagePolicy is validated', () => {
    const doc = JSON.parse(readFileSync(new URL('../../spec-fixtures/capsule-v1/valid/full.json', import.meta.url), 'utf8'));
    const capsule = doc.document ?? doc;
    capsule.manifest.storagePolicy = { local_storage: { allowPrefixes: ['shop.'], denyPrefixes: [] } };
    assert.equal(validateCapsuleDocument(capsule), null);
    capsule.manifest.storagePolicy = { local_storage: { allowPrefixes: [1] } };
    assert.match(validateCapsuleDocument(capsule)!, /storagePolicy/);
    capsule.manifest.storagePolicy = { local_storage: {} };
    assert.match(validateCapsuleDocument(capsule)!, /storagePolicy/);
  });
});

class MemoryStorageArea {
  private readonly m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}

describe('SDK storage restore', () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  afterEach(() => {
    if (had) Object.defineProperty(globalThis, 'localStorage', had);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('writes only allowed keys; a disallowed key raises restore.disallowed and is not written', () => {
    const store = new MemoryStorageArea();
    store.setItem('shop.old', 'x');
    store.setItem('auth.token', 'keep');
    Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true, writable: true });
    const divergences: [string, string][] = [];
    const session = { replay: { diverge: (t: string, d: string) => divergences.push([t, d]) } } as unknown as BugCapsuleSession;
    const integration = localStorageIntegration(policy);
    assert.deepEqual(integration.policy, { allowPrefixes: ['shop.'], denyPrefixes: ['shop.secret'] });
    integration.restore({ 'shop.cart': '[1]', 'auth.token': 'from-capsule', 'shop.secret.k': 'v' }, session);
    assert.equal(store.getItem('shop.cart'), '[1]');
    assert.equal(store.getItem('shop.old'), null, 'allowed keys are cleared first');
    assert.equal(store.getItem('auth.token'), 'keep', 'never written, never cleared');
    assert.equal(store.getItem('shop.secret.k'), null);
    assert.deepEqual(divergences, [
      ['restore.disallowed', 'local_storage.auth.token'],
      ['restore.disallowed', 'local_storage.shop.secret.k'],
    ]);
  });
});
