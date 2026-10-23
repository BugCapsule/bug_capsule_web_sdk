import { expect, test, type Page } from '@playwright/test';
import { validateCapsuleDocument } from '../../packages/web/src/core/validator.js';
import { API, BACKEND, ORIGIN, decodeUpload, envelopeItems, newBackend, sentryBundle, setUpRoutes, type BackendState } from './harness.js';

/**
 * The Sentry companion with the real `@sentry/browser` (see package.json for
 * the pinned version). Sentry uses an in-memory transport: nothing goes to
 * sentry.io.
 */

declare global {
  interface Window {
    Sentry: typeof import('@sentry/browser');
    __sentryEnvelopes: unknown[];
    __order: string[];
    __beforeSendSaw: unknown[];
    __afterError?: boolean;
  }
}

const INGEST = 'bci_test_key_0123456789abcdefghij';
const DSN = 'https://publickey@o123.ingest.sentry.io/4567';

let backend: BackendState;
test.beforeEach(async ({ page }) => {
  backend = newBackend();
  await setUpRoutes(page, backend);
  await page.route(`${ORIGIN}/sdk.js`, (route) => route.fulfill({ contentType: 'text/javascript', body: sentryBundle() }));
  await page.goto(`${ORIGIN}/shop`);
});

interface SentryOptions {
  /** `tag`: beforeSend adds a tag and drops events whose message contains "drop me". */
  beforeSend?: 'tag';
  /** Adds a user integration and a global event processor. */
  userProcessors?: boolean;
}

async function initSentry(page: Page, options: SentryOptions = {}) {
  await page.evaluate(
    ({ DSN, options }) => {
      const { Sentry, BC } = window;
      window.__sentryEnvelopes = [];
      window.__beforeSendSaw = [];
      const integrations: unknown[] = [BC.sentryCompanion()];
      if (options.userProcessors) {
        integrations.push({
          name: 'UserIntegration',
          processEvent(event: { tags?: Record<string, unknown> }) {
            event.tags = { ...event.tags, user_integration: 'ran' };
            return event;
          },
        });
      }
      Sentry.init({
        dsn: DSN,
        release: 'shop-web@1.4.0+52',
        environment: 'staging',
        transport: () => ({
          send: async (envelope: unknown) => {
            window.__sentryEnvelopes.push(JSON.parse(JSON.stringify(envelope)));
            return { statusCode: 200 };
          },
          flush: async () => true,
        }),
        integrations: integrations as never,
        ...(options.beforeSend === 'tag'
          ? {
              beforeSend: (event: any) => {
                window.__beforeSendSaw.push(event.tags?.['bugcapsule.capture']);
                if (JSON.stringify(event.exception).includes('drop me')) return null;
                event.tags = { ...event.tags, before_send: 'ran' };
                return event;
              },
            }
          : {}),
      });
      if (options.userProcessors) {
        Sentry.addEventProcessor((event) => {
          event.tags = { ...event.tags, user_processor: 'ran' };
          return event;
        });
      }
    },
    { DSN, options },
  );
}

async function initBugCapsule(page: Page, extra: Record<string, unknown> = {}) {
  await page.evaluate(
    async ({ BACKEND, INGEST, extra }) => {
      const { BugCapsule, networkIntegration, historyIntegration } = window.BC;
      await BugCapsule.init({
        appVersion: '1.4.0',
        appBuild: '52',
        mode: 'qa',
        gitSha: 'abc123',
        backend: { url: BACKEND, ingestKey: INGEST },
        integrations: [networkIntegration(), historyIntegration()],
        monitoring: false,
        ...extra,
      });
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
      // Which handler reached the failure first (BugCapsule records lastFailure in its own handler).
      window.__order = [];
      const session = BugCapsule.session as unknown as { sentryEvent: (input: unknown) => unknown; lastFailure: unknown };
      if (session) {
        const original = session.sentryEvent.bind(session);
        session.sentryEvent = (input) => {
          window.__order.push(session.lastFailure ? 'bugcapsule-first' : 'sentry-first');
          return original(input);
        };
      }
    },
    { BACKEND, INGEST, extra },
  );
}

/** Sentry error events the in-memory transport received. */
async function sentryEvents(page: Page): Promise<any[]> {
  await page.evaluate(() => window.Sentry.flush(2000));
  return page.evaluate(() =>
    (window.__sentryEnvelopes as [unknown, [{ type: string }, unknown][]][]).flatMap(([, items]) => items.filter(([h]) => h.type === 'event').map(([, p]) => p)),
  );
}

/** Throws from a classic script: reaches window `error` handlers in registration order. */
async function throwUncaught(page: Page, code: string) {
  await page.evaluate((code) => {
    const s = document.createElement('script');
    s.textContent = code;
    document.body.appendChild(s);
  }, code);
}

const settle = (page: Page) => page.waitForTimeout(800);

function expectLinked(event: any, capsule: Record<string, any>) {
  expect(validateCapsuleDocument(capsule)).toBeNull();
  const capsuleId = capsule.manifest.capsuleId;
  expect(event.tags['bugcapsule.capsule_id']).toBe(capsuleId);
  expect(event.tags['bugcapsule.capture']).toBe('scheduled');
  expect(event.contexts.bugcapsule).toEqual({ capsule_id: capsuleId, capture: 'scheduled' });
  expect(capsule.manifest.links.sentry).toEqual({ eventId: event.event_id, projectId: '4567', orgId: '123', release: 'shop-web@1.4.0+52', environment: 'staging' });
}

test('the user beforeSend, integrations and event processors still run; beforeSend can drop the event', async ({ page }) => {
  await initBugCapsule(page);
  await initSentry(page, { beforeSend: 'tag', userProcessors: true });
  await page.evaluate(() => {
    window.Sentry.captureException(new Error('keep me'));
    window.Sentry.captureException(new Error('drop me'));
  });
  await expect.poll(() => backend.uploads.length, { timeout: 10_000 }).toBe(2);
  const events = await sentryEvents(page);
  expect(events).toHaveLength(1);
  const [event] = events;
  expect(event.tags).toMatchObject({ user_integration: 'ran', user_processor: 'ran', before_send: 'ran', 'bugcapsule.capture': 'scheduled' });
  expect(await page.evaluate(() => window.__beforeSendSaw)).toEqual(['scheduled', 'scheduled']);
  const capsules = backend.uploads.map(decodeUpload);
  const kept = capsules.find((c) => c.manifest.failure.message === 'keep me')!;
  expectLinked(event, kept);
  // Known limitation: the dropped event's capsule still names the event id Sentry never stored.
  const dropped = capsules.find((c) => c.manifest.failure.message === 'drop me')!;
  expect(dropped.manifest.links.sentry.eventId).toMatch(/^[0-9a-f]{32}$/);
  expect(dropped.manifest.links.sentry.eventId).not.toBe(event.event_id);
});

for (const order of ['bugcapsule-first', 'sentry-first'] as const) {
  test(`uncaught error, ${order === 'bugcapsule-first' ? 'BugCapsule' : 'Sentry'} initialized first: one Sentry event, one capsule, linked both ways`, async ({ page }) => {
    if (order === 'bugcapsule-first') {
      await initBugCapsule(page);
      await initSentry(page);
    } else {
      await initSentry(page);
      await initBugCapsule(page);
    }
    await throwUncaught(page, `throw new TypeError('price is null')`);
    await expect.poll(() => backend.uploads.length, { timeout: 10_000 }).toBe(1);
    await settle(page);
    const events = await sentryEvents(page);
    expect(events).toHaveLength(1);
    expect(backend.uploads).toHaveLength(1);
    const capsule = decodeUpload(backend.uploads[0]!);
    expectLinked(events[0], capsule);
    expect(capsule.events.filter((e: { type: string }) => e.type === 'failure')).toHaveLength(1);
    expect(events[0].exception.values.at(-1).mechanism).toMatchObject({ handled: false });
    expect(await page.evaluate(() => window.__order)).toEqual([order]);
  });

  test(`unhandled rejection, ${order === 'bugcapsule-first' ? 'BugCapsule' : 'Sentry'} initialized first: one event, one linked capsule`, async ({ page }) => {
    if (order === 'bugcapsule-first') {
      await initBugCapsule(page);
      await initSentry(page);
    } else {
      await initSentry(page);
      await initBugCapsule(page);
    }
    await page.evaluate(() => void Promise.reject(new RangeError('quantity out of range')));
    await expect.poll(() => backend.uploads.length, { timeout: 10_000 }).toBe(1);
    await settle(page);
    const events = await sentryEvents(page);
    expect(events).toHaveLength(1);
    expectLinked(events[0], decodeUpload(backend.uploads[0]!));
  });
}

test('Sentry.captureException on a caught error: a linked capsule, no duplicate when BugCapsule hears of it too', async ({ page }) => {
  await initSentry(page);
  await initBugCapsule(page);
  await page.evaluate(() => {
    try {
      JSON.parse('{oops');
    } catch (e) {
      window.Sentry.captureException(e);
      window.BC.BugCapsule.reportError(e);
    }
  });
  await expect.poll(() => backend.uploads.length, { timeout: 10_000 }).toBe(1);
  await settle(page);
  const events = await sentryEvents(page);
  expect(events).toHaveLength(1);
  expect(backend.uploads).toHaveLength(1);
  const capsule = decodeUpload(backend.uploads[0]!);
  expectLinked(events[0], capsule);
  expect(capsule.manifest.failure.type).toBe('SyntaxError');
  expect(capsule.events.filter((e: { type: string }) => e.type === 'failure')).toHaveLength(1);
});

test('the same error thrown twice, and an error reported through both paths: no duplicate capsule', async ({ page }) => {
  await initBugCapsule(page);
  await initSentry(page);
  await page.evaluate(() => ((window as any).__err = new Error('thrown twice')));
  await throwUncaught(page, 'throw window.__err');
  await throwUncaught(page, 'throw window.__err');
  await page.evaluate(() => {
    const e = new Error('both paths');
    window.BC.BugCapsule.reportError(e);
    window.Sentry.captureException(e);
    window.Sentry.captureException(e); // Sentry skips an exception it already captured
    window.BC.BugCapsule.reportError(e);
  });
  await expect.poll(() => backend.uploads.length, { timeout: 10_000 }).toBe(2);
  await settle(page);
  const events = await sentryEvents(page);
  expect(events).toHaveLength(2);
  expect(backend.uploads).toHaveLength(2);
  const capsules = backend.uploads.map(decodeUpload);
  for (const event of events) {
    const capsule = capsules.find((c) => c.manifest.capsuleId === event.tags['bugcapsule.capsule_id'])!;
    expectLinked(event, capsule);
    const signature = capsule.manifest.failure.signature;
    expect(capsule.events.filter((e: { type: string; data: { signature?: string } }) => e.type === 'failure' && e.data.signature === signature)).toHaveLength(1);
  }
  expect(capsules.map((c) => c.manifest.failure.message).sort()).toEqual(['both paths', 'thrown twice']);
});

test('BugCapsule backend unreachable: the app keeps running, the Sentry event is delivered, the capsule waits locally', async ({ page }) => {
  await page.route(`${BACKEND}/**`, (route) => route.abort('internetdisconnected'));
  await initSentry(page);
  await initBugCapsule(page);
  await page.evaluate(() => document.getElementById('go')!.addEventListener('click', () => (window.__afterError = true)));
  await throwUncaught(page, `throw new TypeError('offline failure')`);
  await settle(page);
  await page.click('#go');
  expect(await page.evaluate(() => window.__afterError)).toBe(true);
  const events = await sentryEvents(page);
  expect(events).toHaveLength(1);
  expect(events[0].tags['bugcapsule.capture']).toBe('scheduled');
  expect(backend.uploads).toHaveLength(0);
  const saved = await page.evaluate(async () => {
    const [capture] = await window.BC.BugCapsule.savedCaptures();
    return capture ? (await window.BCCore.decodeCapsule(capture.bytes)).manifest : null;
  });
  expect(saved?.capsuleId).toBe(events[0].tags['bugcapsule.capsule_id']);
  expect((saved?.links as any)?.sentry.eventId).toBe(events[0].event_id);
});

test('an internal companion error: the Sentry event is still delivered, unmodified', async ({ page }) => {
  await initSentry(page);
  await initBugCapsule(page);
  await page.evaluate(() => {
    (window.BC.BugCapsule.session as unknown as { sentryEvent: () => never }).sentryEvent = () => {
      throw new Error('companion bug');
    };
    window.Sentry.setTag('app_tag', 'kept');
    window.Sentry.captureException(new Error('still delivered'));
  });
  const events = await sentryEvents(page);
  expect(events).toHaveLength(1);
  expect(events[0].exception.values.at(-1).value).toBe('still delivered');
  expect(events[0].tags).toEqual({ app_tag: 'kept' });
  expect(events[0].contexts.bugcapsule).toBeUndefined();
});

test('BugCapsule not recording: the tag says why and there is no capsule', async ({ page }) => {
  await initSentry(page);
  await initBugCapsule(page, { enabled: false });
  await page.evaluate(() => window.Sentry.captureException(new Error('while disabled')));
  await throwUncaught(page, `throw new Error('uncaught while disabled')`);
  await settle(page);
  const events = await sentryEvents(page);
  expect(events.map((e) => [e.tags['bugcapsule.capture'], e.tags['bugcapsule.capsule_id'], e.contexts.bugcapsule])).toEqual([
    ['disabled', undefined, { capsule_id: null, capture: 'disabled' }],
    ['disabled', undefined, { capsule_id: null, capture: 'disabled' }],
  ]);
  expect(backend.uploads).toHaveLength(0);
  expect(await page.evaluate(() => window.BC.BugCapsule.savedCaptures().then((c) => c.length))).toBe(0);
});

test('BugCapsule sampled out in production: tag sampled_out, no capsule', async ({ page }) => {
  await initSentry(page);
  await initBugCapsule(page, { mode: 'production', productionSampleRate: 0 });
  await throwUncaught(page, `throw new Error('not sampled')`);
  await settle(page);
  const events = await sentryEvents(page);
  expect(events).toHaveLength(1);
  expect(events[0].tags['bugcapsule.capture']).toBe('sampled_out');
  expect(events[0].tags['bugcapsule.capsule_id']).toBeUndefined();
  expect(backend.uploads).toHaveLength(0);
});

test('Sentry without BugCapsule initialized: tag disabled', async ({ page }) => {
  await initSentry(page);
  await page.evaluate(() => window.Sentry.captureException(new Error('no bugcapsule')));
  const events = await sentryEvents(page);
  expect(events).toHaveLength(1);
  expect(events[0].tags['bugcapsule.capture']).toBe('disabled');
});

test('companion config monitoring: false sends no BugCapsule events or trace headers; capsules still upload', async ({ page }) => {
  const apiHeaders: Record<string, string>[] = [];
  await page.route(`${API}/**`, async (route) => {
    const h = { 'access-control-allow-origin': ORIGIN, 'access-control-allow-headers': 'content-type, traceparent, baggage', 'content-type': 'application/json' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    apiHeaders.push(await route.request().allHeaders());
    return route.fulfill({ headers: h, body: '{}' });
  });
  const envelopeRequests: string[] = [];
  page.on('request', (r) => r.url().startsWith(`${BACKEND}/v1/envelope`) && envelopeRequests.push(r.url()));
  await initSentry(page);
  await initBugCapsule(page, { monitoring: false, tracePropagationTargets: [API] });
  await page.evaluate((API) => fetch(`${API}/cart`).then((r) => r.json()), API);
  await throwUncaught(page, `throw new TypeError('monitored by sentry only')`);
  await expect.poll(() => backend.uploads.length, { timeout: 10_000 }).toBe(1);
  await page.evaluate(() => window.BC.BugCapsule.flush(2000));
  await settle(page);
  expect(envelopeRequests).toEqual([]);
  expect(backend.envelopes).toHaveLength(0);
  expect(apiHeaders[0]!.traceparent).toBeUndefined();
  const events = await sentryEvents(page);
  expect(events).toHaveLength(1);
  expectLinked(events[0], decodeUpload(backend.uploads[0]!));
});

test('control: with BugCapsule monitoring on, the same failure also sends one BugCapsule event (not two)', async ({ page }) => {
  await initSentry(page);
  await initBugCapsule(page, { monitoring: true });
  await throwUncaught(page, `throw new TypeError('monitored by both')`);
  await expect.poll(() => backend.uploads.length, { timeout: 10_000 }).toBe(1);
  await page.evaluate(() => window.BC.BugCapsule.flush(5000));
  await expect.poll(() => envelopeItems(backend, 'event').length).toBe(1);
  await settle(page);
  expect(envelopeItems(backend, 'event')).toHaveLength(1);
  const capsule = decodeUpload(backend.uploads[0]!);
  expect(envelopeItems(backend, 'event')[0]!.capsuleId).toBe(capsule.manifest.capsuleId);
  expectLinked((await sentryEvents(page))[0], capsule);
});
