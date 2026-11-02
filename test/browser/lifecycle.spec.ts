import { expect, test, type Page } from '@playwright/test';
import { BACKEND, ORIGIN, newBackend, setUpRoutes, type BackendState } from './harness.js';

// BC-ENT-038: clearLocalData, the persisted consent switch, saved-capture TTL (real IndexedDB).

declare global {
  interface Window {
    BC: typeof import('../../packages/web/src/index.js');
    BCInternal: { UploadOutbox: typeof import('../../packages/web/src/storage/outbox.js').UploadOutbox; openStorage: typeof import('../../packages/web/src/storage/idb.js').openStorage };
  }
}

const INGEST = 'bci_test_key_0123456789abcdefghij';

async function init(page: Page, extra: Record<string, unknown> = {}) {
  await page.evaluate(
    async ({ BACKEND, INGEST, extra }) => {
      await window.BC.BugCapsule.init({ appVersion: '1.0.0', mode: 'qa', backend: { url: BACKEND, ingestKey: INGEST }, ...extra });
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
    },
    { BACKEND, INGEST, extra },
  );
}

/** Record counts per store and the kv keys, read straight from IndexedDB. */
async function stored(page: Page): Promise<{ outbox: number; captures: number; envelopes: number; kv: string[] }> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('bugcapsule');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['outbox', 'captures', 'envelopes', 'kv'], 'readonly');
          const out: Record<string, unknown> = {};
          for (const s of ['outbox', 'captures', 'envelopes']) tx.objectStore(s).count().onsuccess = (e) => (out[s] = (e.target as IDBRequest<number>).result);
          tx.objectStore('kv').getAllKeys().onsuccess = (e) => (out.kv = (e.target as IDBRequest<IDBValidKey[]>).result.map(String).sort());
          tx.oncomplete = () => {
            db.close();
            resolve(out as never);
          };
        };
      }),
  );
}

let backend: BackendState;
test.beforeEach(async ({ page }) => {
  backend = newBackend();
  await setUpRoutes(page, backend);
});

test('clearLocalData deletes queued capsules, saved captures, cached config and the event buffer', async ({ page }) => {
  backend.offline = true;
  await page.goto(`${ORIGIN}/`);
  await init(page);
  await page.evaluate(() => {
    window.BC.BugCapsule.log('before clear: private note');
    window.BC.BugCapsule.fail('queued_bug');
  });
  await expect.poll(() => page.evaluate(() => window.BC.BugCapsule.pendingUploads())).toBe(1);
  const before = await stored(page);
  expect(before.captures).toBe(1);
  expect(before.kv.length).toBeGreaterThan(0);

  await page.evaluate(() => window.BC.BugCapsule.clearLocalData());
  const after = await stored(page);
  expect(after).toMatchObject({ outbox: 0, captures: 0, envelopes: 0 });
  expect(after.kv.filter((k) => !k.startsWith('lease:'))).toEqual([]);
  expect(await page.evaluate(() => window.BC.BugCapsule.isRecording)).toBe(true);

  // Recording goes on, without anything from before the clear.
  backend.offline = false;
  const capture = await page.evaluate(async () => {
    window.BC.BugCapsule.log('after clear');
    const r = await window.BC.BugCapsule.capture({ note: 'post-clear' });
    return r && { bytes: Array.from(r.bytes) };
  });
  expect(capture).not.toBeNull();
  const { gunzipSync } = await import('node:zlib');
  const doc = JSON.parse(gunzipSync(Buffer.from(capture!.bytes)).toString());
  const logs = doc.events.filter((e: { type: string }) => e.type === 'log').map((e: { data: { message: string } }) => e.data.message);
  expect(logs).toEqual(['after clear']);
  expect(JSON.stringify(doc)).not.toContain('private note');
});

test('clearLocalData before init empties the database', async ({ page }) => {
  backend.offline = true;
  await page.goto(`${ORIGIN}/`);
  await init(page);
  await page.evaluate(() => window.BC.BugCapsule.fail('queued_bug'));
  await expect.poll(() => page.evaluate(() => window.BC.BugCapsule.pendingUploads())).toBe(1);
  await page.reload();
  await page.evaluate(() => window.BC.BugCapsule.clearLocalData());
  expect(await stored(page)).toMatchObject({ outbox: 0, captures: 0, envelopes: 0, kv: [] });
});

test('setCollectionEnabled(false) stops capture, purges queued data, and persists across reloads', async ({ page }) => {
  backend.offline = true;
  await page.goto(`${ORIGIN}/`);
  await init(page);
  await page.evaluate(() => window.BC.BugCapsule.fail('queued_bug'));
  await expect.poll(() => page.evaluate(() => window.BC.BugCapsule.pendingUploads())).toBe(1);

  await page.evaluate(() => window.BC.BugCapsule.setCollectionEnabled(false));
  const envelopesBefore = backend.envelopes.length; // the session start, sent before the switch
  expect(await page.evaluate(() => window.BC.BugCapsule.isRecording)).toBe(false);
  expect(await page.evaluate(() => window.BC.BugCapsule.collectionEnabled())).toBe(false);
  expect(await stored(page)).toMatchObject({ outbox: 0, captures: 0, envelopes: 0 });
  expect(await page.evaluate(() => window.BC.BugCapsule.status()?.connection)).toMatchObject({ state: 'disabled', reason: 'collection_disabled' });
  // No capture while off.
  backend.offline = false;
  expect(await page.evaluate(() => window.BC.BugCapsule.capture())).toBeNull();
  await page.evaluate(() => window.BC.BugCapsule.reportError(new Error('while off')));
  await page.waitForTimeout(500);
  expect((await stored(page)).outbox).toBe(0);
  // Switching back on in the same page session resumes on the next load.
  await page.evaluate(() => window.BC.BugCapsule.setCollectionEnabled(true));
  expect(await page.evaluate(() => window.BC.BugCapsule.isRecording)).toBe(false);

  await page.evaluate(() => window.BC.BugCapsule.setCollectionEnabled(false));
  await page.reload();
  const fetchesBefore = backend.configFetches;
  await init(page, { collectionEnabled: true });
  expect(await page.evaluate(() => window.BC.BugCapsule.isRecording)).toBe(false);
  expect(await page.evaluate(() => window.BC.BugCapsule.collectionEnabled())).toBe(false);
  await page.waitForTimeout(300);
  expect(backend.configFetches).toBe(fetchesBefore); // the backend is not contacted at all
  expect(backend.uploads).toHaveLength(0);
  expect(backend.envelopes).toHaveLength(envelopesBefore);

  await page.reload();
  await page.evaluate(() => window.BC.BugCapsule.setCollectionEnabled(true));
  await init(page);
  expect(await page.evaluate(() => window.BC.BugCapsule.isRecording)).toBe(true);
});

test('collectionEnabled: false in the config collects nothing until the user opts in, then starts at once', async ({ page }) => {
  await page.goto(`${ORIGIN}/`);
  await init(page, { collectionEnabled: false });
  expect(await page.evaluate(() => window.BC.BugCapsule.isRecording)).toBe(false);
  expect(await page.evaluate(() => window.BC.BugCapsule.capture())).toBeNull();
  expect(backend.configFetches).toBe(0);

  await page.evaluate(() => window.BC.BugCapsule.setCollectionEnabled(true));
  expect(await page.evaluate(() => window.BC.BugCapsule.isRecording)).toBe(true);
  await page.evaluate(() => window.BC.BugCapsule.fail('after_opt_in'));
  await expect.poll(() => backend.uploads.length, { timeout: 10_000 }).toBe(1);
  // The choice persists over the config default.
  await page.reload();
  await init(page, { collectionEnabled: false });
  expect(await page.evaluate(() => window.BC.BugCapsule.isRecording)).toBe(true);
});

test('setCollectionEnabled(false) before init purges data left from an earlier session', async ({ page }) => {
  backend.offline = true;
  await page.goto(`${ORIGIN}/`);
  await init(page);
  await page.evaluate(() => window.BC.BugCapsule.fail('queued_bug'));
  await expect.poll(() => page.evaluate(() => window.BC.BugCapsule.pendingUploads())).toBe(1);
  await page.reload();
  await page.evaluate(() => window.BC.BugCapsule.setCollectionEnabled(false));
  expect(await stored(page)).toMatchObject({ outbox: 0, captures: 0 });
  expect(await page.evaluate(() => localStorage.getItem('bugcapsule:bugcapsule:collectionEnabled'))).toBe('0');
});

test('a blocked localStorage keeps the switch for the page only, without throwing', async ({ page }) => {
  await page.goto(`${ORIGIN}/`);
  await page.evaluate(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
  });
  await init(page);
  await page.evaluate(() => window.BC.BugCapsule.setCollectionEnabled(false));
  expect(await page.evaluate(() => window.BC.BugCapsule.isRecording)).toBe(false);
  expect(await page.evaluate(() => window.BC.BugCapsule.collectionEnabled())).toBe(false);
});

test('saved captures older than 7 days are deleted at startup and never returned', async ({ page }) => {
  await page.goto(`${ORIGIN}/`);
  await page.evaluate(async () => {
    const storage = await window.BCInternal.openStorage('bugcapsule');
    const day = 86_400_000;
    const gz = new Uint8Array([0x1f, 0x8b, 1]);
    const rec = (capsuleId: string, at: number) => ({ id: `${String(at).padStart(15, '0')}_${capsuleId}`, capsuleId, enqueuedAt: at, size: 3, bytes: gz });
    await storage.update('captures', () => ({ put: [rec('stale', Date.now() - 8 * day), rec('fresh', Date.now() - day)], result: undefined }));
    storage.close();
  });
  expect((await stored(page)).captures).toBe(2);
  await init(page);
  expect((await stored(page)).captures).toBe(1);
  expect(await page.evaluate(async () => (await window.BC.BugCapsule.savedCaptures()).map((c) => c.capsuleId))).toEqual(['fresh']);
});
