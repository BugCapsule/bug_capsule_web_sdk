import { expect, test } from '@playwright/test';
import { BACKEND, ORIGIN, decodeUpload, newBackend, setUpRoutes } from './harness.js';

test('records an approved masked canvas inside a capsule and renders its PNG bytes', async ({ page }) => {
  const backend = newBackend();
  await setUpRoutes(page, backend);
  await page.goto(ORIGIN);
  const result = await page.evaluate(async (backendUrl) => {
    const { BugCapsule, ScreenshotIntegration, screenshotPngFromCanvas } = (window as unknown as {BC: typeof import('../../packages/web/src/index.js')}).BC;
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = '#000000'; ctx.fillText('synthetic-secret', 20, 50);
    // App policy masks the entire sensitive region before encoding.
    ctx.fillRect(0, 0, 320, 90);
    // Slow CI canvas encoding can exceed the default one-second interval.
    // Keep this integration check within an explicit window; unit tests cover the clock boundary.
    const screenshots = new ScreenshotIntegration({enabled: true, minIntervalMs: 60000, captureRedactedPng: () => screenshotPngFromCanvas(canvas)});
    await BugCapsule.init({mode: 'qa', monitoring: false, backend: {url: backendUrl, ingestKey: 'bci_test_key_0123456789abcdefghij'}, integrations: [screenshots]});
    await new Promise<void>(r => requestAnimationFrame(() => r()));
    const recorded = await screenshots.capture();
    const throttled = await screenshots.capture();
    await BugCapsule.capture();
    return {recorded, throttled};
  }, BACKEND);
  expect(result).toEqual({recorded: true, throttled: false});
  await expect.poll(() => backend.uploads.length).toBe(1);
  const doc = decodeUpload(backend.uploads[0]!);
  const frame = doc.events.find((e: {type: string}) => e.type === 'screenshot');
  expect(frame.data).toMatchObject({schema: 1, mimeType: 'image/png', width: 320, height: 180, privacy: 'reviewed'});
  const pixels = await page.evaluate(async (base64) => {
    const image = new Image(); image.src = 'data:image/png;base64,' + base64; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0);
    return {masked: [...ctx.getImageData(20, 50, 1, 1).data], clear: [...ctx.getImageData(20, 150, 1, 1).data]};
  }, frame.data.base64);
  expect(pixels).toEqual({masked: [0, 0, 0, 255], clear: [255, 255, 255, 255]});
});
