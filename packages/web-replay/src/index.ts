import { createGunzip, gzipSync } from 'node:zlib';
import {
  CapsuleFormatError,
  ReplayProtocol,
  capsuleToJson,
  decodeCapsule,
  replaySettingsFromJson,
  type Capsule,
  type Divergence,
  type GzipCodec,
  type ReplayReport,
  type ReplaySettings,
} from '@bugcapsule/web/core';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

export interface ReplayAttemptOptions {
  /** Armed attempt URL from the bugcapsule CLI (`http://127.0.0.1:<port>/a/<token>`). */
  replayUrl: string;
  /** The running app (`http://127.0.0.1:4317/`). The capsule's recorded location is opened relative to it. */
  appUrl: string;
  /** Origins (besides the app's) the page may load from, e.g. a static CDN. Everything else is blocked and reported. */
  allowOrigins?: string[];
  headed?: boolean;
  /** Overall budget for the attempt (default 120 s). */
  timeoutMs?: number;
  /** Chromium executable (default: the browser Playwright installed). */
  executablePath?: string;
  log?: (line: string) => void;
}

/** Bounded streaming gunzip for Node (rejects as soon as the output exceeds the limit). */
export const nodeGzip: GzipCodec = {
  async gzip(bytes) {
    return new Uint8Array(gzipSync(bytes));
  },
  gunzip(bytes, maxBytes) {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      const z = createGunzip();
      z.on('data', (c: Buffer) => {
        total += c.length;
        if (total > maxBytes) {
          z.destroy();
          reject(new CapsuleFormatError(`decompressed capsule exceeds ${maxBytes} bytes`));
          return;
        }
        chunks.push(c);
      });
      z.on('error', () => reject(new CapsuleFormatError('not a valid gzip file')));
      z.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks, total))));
      z.end(Buffer.from(bytes));
    });
  },
};

function errorReport(settings: ReplaySettings | null, message: string, outcome: ReplayReport['outcome'] = 'error'): ReplayReport {
  return {
    outcome,
    attempt: settings?.attempt ?? 1,
    durationMs: 0,
    strategy: settings?.strategy ?? 'auto',
    expectedSignature: null,
    observed: null,
    otherFailures: [],
    divergences: [],
    eventsDispatched: 0,
    eventsExpected: null,
    fixturesServed: 0,
    compressedMs: 0,
    gapsCompressed: 0,
    buildGitSha: null,
    message,
    ...(settings?.attemptId ? { attemptId: settings.attemptId } : {}),
    runtime: 'web',
  };
}

async function get(url: string): Promise<Response> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (res.status !== 200) throw new Error(`GET ${url.replace(/\/a\/[^/]+/, '/a/…')} → HTTP ${res.status}`);
  return res;
}

/** Posts the report to the CLI (and prints the stdout fallback line). Returns the HTTP status. */
async function deliver(replayUrl: string, report: ReplayReport, log: (l: string) => void): Promise<number> {
  const json = JSON.stringify(report);
  process.stdout.write(`${ReplayProtocol.stdoutPrefix}${json}\n`);
  try {
    const res = await fetch(`${replayUrl.replace(/\/+$/, '')}${ReplayProtocol.resultPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: json,
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 409 || res.status === 410) log(`report rejected as stale (HTTP ${res.status})`);
    return res.status;
  } catch (e) {
    log(`could not post the report: ${String(e)}`);
    return 0;
  }
}

/**
 * Runs one replay attempt: loads the capsule and settings from the CLI,
 * opens the app in a fresh Chromium context sized like the recording,
 * restores allowlisted storage before any page script runs, blocks requests
 * to origins other than the app's (reported as `network.escaped`), lets the
 * in-page engine (the app's own `@bugcapsule/web` with `allowReplay: true`)
 * replay inputs and serve recorded responses, and posts its report.
 */
export async function runReplayAttempt(options: ReplayAttemptOptions): Promise<ReplayReport> {
  const log = options.log ?? ((l: string) => process.stderr.write(`[bugcapsule-web-runner] ${l}\n`));
  const base = options.replayUrl.replace(/\/+$/, '');
  let settings: ReplaySettings | null = null;
  let capsule: Capsule;
  try {
    settings = replaySettingsFromJson((await (await get(`${base}${ReplayProtocol.settingsPath}`)).json()) as Record<string, unknown>);
    const bytes = new Uint8Array(await (await get(`${base}${ReplayProtocol.capsulePath}`)).arrayBuffer());
    try {
      capsule = await decodeCapsule(bytes, { codec: nodeGzip, maxDecompressedBytes: 64 * 1024 * 1024 });
    } catch (e) {
      const report = errorReport(settings, `could not load capsule: ${String(e)}`, e instanceof CapsuleFormatError ? 'incompatible' : 'error');
      await deliver(base, report, log);
      return report;
    }
  } catch (e) {
    const report = errorReport(settings, `could not reach the bugcapsule CLI: ${String(e)}`);
    await deliver(base, report, log);
    return report;
  }

  const appUrl = new URL(options.appUrl);
  const allowed = new Set([appUrl.origin, ...(options.allowOrigins ?? []).map((o) => new URL(o).origin)]);
  const escaped: Divergence[] = [];
  const screen = capsule.manifest.platform.screen ?? {};
  const history = capsule.checkpoint.data.history as { location?: string } | undefined;
  const startUrl = new URL(history?.location && history.location.startsWith('/') ? history.location : appUrl.pathname + appUrl.search, appUrl);

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const started = Date.now();
  try {
    browser = await chromium.launch({ headless: !options.headed, ...(options.executablePath ? { executablePath: options.executablePath } : {}) });
    context = await browser.newContext({
      viewport: { width: Math.max(200, Math.round(screen.width ?? 1280)), height: Math.max(200, Math.round(screen.height ?? 720)) },
      deviceScaleFactor: screen.pixelRatio && screen.pixelRatio > 0 ? screen.pixelRatio : 1,
      ...(capsule.manifest.platform.locale ? { locale: capsule.manifest.platform.locale } : {}),
      serviceWorkers: 'block',
    });

    await context.route('**/*', async (route) => {
      const url = route.request().url();
      let origin: string | null = null;
      try {
        origin = new URL(url).origin;
      } catch {
        origin = null;
      }
      if (url.startsWith('data:') || url.startsWith('blob:') || (origin !== null && allowed.has(origin))) {
        await route.continue();
        return;
      }
      if (escaped.length < 100) escaped.push({ type: 'network.escaped', detail: `${route.request().method()} ${url.split('?')[0]}` });
      await route.abort('blockedbyclient');
    });

    const storage = {
      local: (capsule.checkpoint.data.local_storage ?? null) as Record<string, string> | null,
      session: (capsule.checkpoint.data.session_storage ?? null) as Record<string, string> | null,
    };
    await context.addInitScript(
      ({ origin, storage }) => {
        if (location.origin !== origin) return;
        (window as unknown as { __BUGCAPSULE_REPLAY__: unknown }).__BUGCAPSULE_REPLAY__ = { version: 1 };
        // Restore before any app script runs; the SDK restores again (idempotent) and reports.
        try {
          for (const [k, v] of Object.entries(storage.local ?? {})) localStorage.setItem(k, v);
          for (const [k, v] of Object.entries(storage.session ?? {})) sessionStorage.setItem(k, v);
        } catch {
          /* storage blocked: the SDK reports restore.* */
        }
      },
      { origin: appUrl.origin, storage },
    );

    let resolveReport!: (r: ReplayReport) => void;
    const reportPromise = new Promise<ReplayReport>((r) => (resolveReport = r));
    let page: Page | null = null;
    const pressed = new Set<number>();
    await context.exposeBinding('__bugcapsuleReplayCall', async ({ page: p }, op: string, payload: unknown) => {
      switch (op) {
        case 'load':
          return { capsule: capsuleToJson(capsule), settings };
        case 'pointer': {
          const ptr = payload as { phase: string; x: number; y: number; buttons: number; pointer: number };
          await p.mouse.move(ptr.x, ptr.y);
          const button = ptr.buttons === 2 ? 'right' : ptr.buttons === 4 ? 'middle' : 'left';
          if (ptr.phase === 'down') {
            pressed.add(ptr.pointer);
            await p.mouse.down({ button });
          } else if (ptr.phase === 'up' || ptr.phase === 'cancel') {
            if (pressed.delete(ptr.pointer)) await p.mouse.up({ button });
          }
          return null;
        }
        case 'report':
          resolveReport(payload as ReplayReport);
          return null;
        default:
          throw new Error(`unknown replay op ${op}`);
      }
    });

    page = await context.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error' || m.text().startsWith('[bugcapsule]')) log(`console.${m.type()}: ${m.text()}`);
    });
    const crashed = new Promise<ReplayReport>((resolve) => page!.on('crash', () => resolve(errorReport(settings, 'the page crashed'))));
    await page.goto(startUrl.href, { waitUntil: 'commit', timeout: Math.min(60_000, timeoutMs) });

    const remaining = Math.max(1000, timeoutMs - (Date.now() - started));
    const timedOut = new Promise<ReplayReport>((resolve) =>
      setTimeout(
        () => resolve(errorReport(settings, `no report from the page within ${Math.round(remaining / 1000)}s (is allowReplay enabled in this build?)`)),
        remaining,
      ),
    );
    let report = await Promise.race([reportPromise, crashed, timedOut]);
    if (escaped.length > 0) report = { ...report, divergences: [...report.divergences, ...escaped] };
    if (!report.attemptId && settings.attemptId) report = { ...report, attemptId: settings.attemptId };
    await deliver(base, report, log);
    return report;
  } catch (e) {
    const report = errorReport(settings, `replay runner failed: ${String(e)}`);
    await deliver(base, report, log);
    return report;
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

/** CLI entry: `bugcapsule-web-runner --replay-url <url> --app-url <url> [--allow-origin <o>]… [--headed] [--timeout <s>]`. */
export async function main(argv: string[]): Promise<number> {
  const args: Record<string, string[]> = {};
  let flag: string | null = null;
  for (const a of argv) {
    if (a.startsWith('--')) {
      flag = a.substring(2);
      args[flag] ??= [];
      if (flag === 'headed' || flag === 'help') flag = null;
    } else if (flag) {
      args[flag]!.push(a);
      flag = null;
    }
  }
  const replayUrl = args['replay-url']?.[0] ?? process.env[ReplayProtocol.envUrl];
  const appUrl = args['app-url']?.[0];
  if (args.help || !replayUrl || !appUrl) {
    process.stderr.write('usage: bugcapsule-web-runner --replay-url <armed url> --app-url <app url> [--allow-origin <origin>]... [--headed] [--timeout <seconds>]\n');
    return args.help ? 0 : 64;
  }
  const report = await runReplayAttempt({
    replayUrl,
    appUrl,
    allowOrigins: args['allow-origin'] ?? [],
    headed: 'headed' in args,
    ...(args.timeout?.[0] ? { timeoutMs: Number(args.timeout[0]) * 1000 } : {}),
    ...(process.env.BUGCAPSULE_CHROMIUM ? { executablePath: process.env.BUGCAPSULE_CHROMIUM } : {}),
  });
  return report.outcome === 'error' ? 1 : 0;
}
