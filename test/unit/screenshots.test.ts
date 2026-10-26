import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { ScreenshotIntegration } from '../../packages/web/src/integrations/screenshots.js';
import { BugCapsule } from '../../packages/web/src/bugcapsule.js';
import { MemoryStorage } from '../../packages/web/src/storage/idb.js';
import type { BugCapsuleSession } from '../../packages/web/src/types.js';
const png = () => Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAC0lEQVR4nGNgAAMAAAcAAbKGrPQAAAAASUVORK5CYII=', 'base64'));
function session() {
 const events: {type: string; data: Record<string, unknown>}[] = [];
 const s = {isRecording: true, isReplaying: false, now: () => 0, record: (type: string, data: Record<string, unknown>) => events.push({type, data})};
 return {s, events, bind: (i: ScreenshotIntegration) => i.setUp(s as unknown as BugCapsuleSession)};
}
afterEach(async () => { await BugCapsule.resetForTest(); BugCapsule.setTestOverrides(undefined); });
it('disabled/replay/killed capture never invokes provider', async () => {
 let calls = 0; const provider = () => { calls++; return png(); };
 const x = session(); const off = new ScreenshotIntegration({captureRedactedPng: provider}); x.bind(off);
 assert.equal(await off.capture(), false);
 const on = new ScreenshotIntegration({enabled: true, captureRedactedPng: provider}); x.bind(on);
 x.s.isReplaying = true; assert.equal(await on.capture(), false);
 x.s.isReplaying = false; x.s.isRecording = false; assert.equal(await on.capture(), false);
 assert.equal(calls, 0);
});
it('rate, count and total bytes are bounded; errors and null frames fail closed', async () => {
 for (const opts of [{maxFrames: 1}, {maxTotalBytes: png().length}]) {
  const x = session(); let t = 0; x.s.now = () => t;
  const i = new ScreenshotIntegration({enabled: true, captureRedactedPng: png, ...opts}); x.bind(i);
  assert.equal(await i.capture(), true); t = 2000; assert.equal(await i.capture(), false); assert.equal(x.events.length, 1);
 }
 const x = session(); const i = new ScreenshotIntegration({enabled: true, captureRedactedPng: png}); x.bind(i);
 assert.equal(await i.capture(), true); assert.equal(await i.capture(), false);
 for (const captureRedactedPng of [() => null, () => {throw Error('private');}, () => png().slice(0, 24)]) {
  const i = new ScreenshotIntegration({enabled: true, captureRedactedPng}); x.bind(i); assert.equal(await i.capture(), false);
 }
});
it('async capture is single-flight and discarded after kill or dispose', async () => {
 const x = session(); let resolve!: (p: Uint8Array) => void;
 const i = new ScreenshotIntegration({enabled: true, captureRedactedPng: () => new Promise(r => {resolve = r;})}); x.bind(i);
 const pending = i.capture(); assert.equal(await i.capture(), false); x.s.isRecording = false; resolve(png());
 assert.equal(await pending, false); assert.equal(x.events.length, 0);
});
it('real runtime writes portable bytes without text redaction corrupting PNG', async () => {
 const i = new ScreenshotIntegration({enabled: true, captureRedactedPng: png});
 BugCapsule.setTestOverrides({storage: new MemoryStorage(), bridge: null});
 await BugCapsule.init({mode: 'qa', monitoring: false, integrations: [i], redactPatterns: [/iVBOR/g]});
 assert.equal(await i.capture(), true);
 const capsule = await BugCapsule.capture(); assert.ok(capsule);
 const doc = JSON.parse(gunzipSync(capsule.bytes).toString());
 assert.equal(doc.events.find((e: {type: string}) => e.type === 'screenshot').data.base64, 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAC0lEQVR4nGNgAAMAAAcAAbKGrPQAAAAASUVORK5CYII=');
 assert.equal(doc.specVersion, 1);
});
it('beforeRecord can remove a screenshot before persistence', async () => {
 const i = new ScreenshotIntegration({enabled: true, captureRedactedPng: png});
 BugCapsule.setTestOverrides({storage: new MemoryStorage(), bridge: null});
 await BugCapsule.init({mode: 'qa', monitoring: false, integrations: [i], beforeRecord: (type, data) => type === 'screenshot' ? null : data});
 await i.capture(); const capsule = await BugCapsule.capture(); assert.ok(capsule);
 assert.ok(!JSON.parse(gunzipSync(capsule.bytes).toString()).events.some((e: {type: string}) => e.type === 'screenshot'));
});
