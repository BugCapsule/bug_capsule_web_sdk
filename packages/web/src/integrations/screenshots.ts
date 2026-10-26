import type { BugCapsuleIntegration, BugCapsuleSession } from '../types.js';

export interface ScreenshotOptions {
  /** Explicit opt-in. No background timer or implicit full-page capture. */
  enabled?: boolean;
  minIntervalMs?: number;
  maxFrames?: number;
  maxFrameBytes?: number;
  maxTotalBytes?: number;
  /** Must render only approved content and mask secrets BEFORE returning PNG bytes. Null skips a sensitive screen. */
  captureRedactedPng: () => Uint8Array | null | Promise<Uint8Array | null>;
}
const limit = (n: number | undefined, fallback: number, max: number) => Number.isFinite(n) ? Math.max(1, Math.min(max, Math.floor(n!))) : fallback;

/** Explicit application checkpoints: await capture() after a safe screen renders, before captureCapsule(). */
export class ScreenshotIntegration implements BugCapsuleIntegration {
  readonly name = 'screenshots';
  private session: BugCapsuleSession | null = null;
  private busy = false;
  private last = -Infinity;
  private count = 0;
  private bytes = 0;
  constructor(private readonly options: ScreenshotOptions) {}
  setUp(session: BugCapsuleSession): void { this.session = session; this.last = -Infinity; this.count = this.bytes = 0; }
  dispose(): void { this.session = null; }
  async capture(): Promise<boolean> {
    const s = this.session, o = this.options;
    if (!o.enabled || !s?.isRecording || s.isReplaying || this.busy ||
        (typeof document !== 'undefined' && document.visibilityState === 'hidden') ||
        this.count >= limit(o.maxFrames, 20, 20) || this.bytes >= limit(o.maxTotalBytes, 2097152, 2097152)) return false;
    const t = s.now();
    if (t - this.last < Math.max(1000, limit(o.minIntervalMs, 1000, 3600000))) return false;
    this.last = t; this.busy = true;
    try {
      const png = await o.captureRedactedPng();
      if (!png || !s.isRecording || s.isReplaying || this.session !== s || png.length < 24 ||
          png.length > limit(o.maxFrameBytes, 262144, 262144) || this.bytes + png.length > limit(o.maxTotalBytes, 2097152, 2097152)) return false;
      if ([137,80,78,71,13,10,26,10].some((b, i) => png[i] !== b)) return false;
      const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
      const width = v.getUint32(16), height = v.getUint32(20);
      if (!width || !height || width > 2048 || height > 2048) return false;
      if (v.getUint32(8) !== 13 || String.fromCharCode(...png.subarray(12, 16)) !== 'IHDR') return false;
      let pos = 8, hasData = false, ended = false;
      while (pos + 12 <= png.length) {
        const size = v.getUint32(pos), kind = String.fromCharCode(...png.subarray(pos + 4, pos + 8));
        if (pos + size + 12 > png.length || !['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'cHRM', 'pHYs', 'sBIT'].includes(kind)) return false;
        if (kind === 'IDAT') hasData = true;
        pos += size + 12;
        if (kind === 'IEND') { if (size !== 0) return false; ended = true; break; }
      }
      if (!hasData || !ended || pos !== png.length) return false;
      let binary = ''; for (const b of png) binary += String.fromCharCode(b);
      s.record('screenshot', { schema: 1, mimeType: 'image/png', privacy: 'reviewed', capturedAtT: t, width, height, base64: btoa(binary) });
      this.count++; this.bytes += png.length;
      return true;
    } catch { return false; } finally { this.busy = false; }
  }
}

/** Encode an application-owned, already masked canvas. Never reads DOM, iframes or the desktop. */
export async function screenshotPngFromCanvas(canvas: HTMLCanvasElement): Promise<Uint8Array | null> {
  if (!canvas.width || !canvas.height || canvas.width > 2048 || canvas.height > 2048) return null;
  try {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob || blob.size > 262144) return null;
    const png = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(png.buffer);
    const chunks: Uint8Array[] = [png.subarray(0, 8)];
    // Browsers may attach color profiles/text metadata. Keep only the raster and
    // fixed-size color/geometry chunks so the provider helper is portable.
    const allowed = ['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'cHRM', 'pHYs', 'sBIT'];
    for (let pos = 8; pos + 12 <= png.length;) {
      const size = view.getUint32(pos), end = pos + size + 12;
      if (end > png.length) return null;
      const kind = String.fromCharCode(...png.subarray(pos + 4, pos + 8));
      if (allowed.includes(kind)) chunks.push(png.subarray(pos, end));
      pos = end;
    }
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0; for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
    return out;
  } catch { return null; } // Includes cross-origin/tainted canvases.
}
