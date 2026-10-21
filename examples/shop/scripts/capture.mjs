// QA automation for the demo: drives the shop in Chromium until a planted
// bug fires, then waits for BugCapsule to upload the capsule and prints its
// backend id. This is how a tester would hit the bug; it is not replay.
//
//   node scripts/capture.mjs --bug race|discontinued|legacy|coupon [--offline-then-reload]
//        [--url http://127.0.0.1:4317/] [--backend http://127.0.0.1:8787]
import { chromium } from 'playwright-core';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
    return acc;
  }, []),
);
const bug = args.bug;
const appUrl = new URL(args.url ?? 'http://127.0.0.1:4317/');
const backend = args.backend ?? 'http://127.0.0.1:8787';
const offline = args['offline-then-reload'] === 'true';
if (!['race', 'discontinued', 'legacy', 'coupon'].includes(bug)) {
  console.error('usage: capture.mjs --bug race|discontinued|legacy|coupon [--offline-then-reload]');
  process.exit(64);
}

const browser = await chromium.launch({ headless: args.headed !== 'true' });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
page.on('console', (m) => m.text().startsWith('[bugcapsule]') && console.log(`  page: ${m.text()}`));
const uploads = [];
page.on('response', async (r) => {
  if (r.url() === `${backend}/v1/capsules` && r.request().method() === 'POST') {
    uploads.push({ status: r.status(), body: await r.json().catch(() => null) });
  }
});
if (offline) await context.route(`${backend}/v1/capsules`, (r) => r.abort('internetdisconnected'));

const pending = () =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('bugcapsule');
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('outbox')) return resolve(0);
          const count = db.transaction('outbox').objectStore('outbox').count();
          count.onsuccess = () => resolve(count.result);
          count.onerror = () => resolve(-1);
        };
        req.onerror = () => resolve(-1);
      }),
  );
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const fired = () => errors.length > 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitCaptured() {
  // The SDK writes the capsule ~300 ms after the failure, then queues/uploads it.
  for (let i = 0; i < 60; i++) {
    if (offline ? (await pending()) > 0 : uploads.some((u) => u.status === 201 || u.status === 200)) return true;
    await sleep(250);
  }
  return false;
}

let tries = 0;
const max = Number(args.tries ?? 40);
async function attempt() {
  tries++;
  switch (bug) {
    case 'race':
      if (tries === 1) await page.goto(appUrl.href);
      await page.getByRole('button', { name: 'Refresh picks' }).click();
      await sleep(600);
      return fired();
    case 'discontinued':
      await page.goto(new URL('/cart', appUrl).href);
      await page.getByText('Coupon').waitFor();
      if ((await page.getByText('unavailable').count()) === 0) return false;
      await page.getByRole('button', { name: 'Checkout' }).click();
      await sleep(500);
      return fired();
    case 'coupon': {
      await page.goto(new URL('/cart', appUrl).href);
      await page.getByText('Coupon').waitFor();
      if ((await page.getByText('unavailable').count()) > 0) return false;
      await page.getByTestId('coupon').fill('SAVE100');
      await page.getByRole('button', { name: 'Apply' }).click();
      await sleep(400);
      const text = await page.getByTestId('result').innerText();
      return text.includes('-');
    }
    case 'legacy':
      await page.goto(appUrl.href);
      await page.getByTestId('upgrade').click();
      await page.reload();
      await sleep(800);
      return fired();
  }
}

let hit = false;
while (!hit && tries < max) hit = await attempt();
if (!hit) {
  console.error(`bug "${bug}" did not fire in ${tries} tries`);
  await browser.close();
  process.exit(2);
}
console.log(`bug "${bug}" fired after ${tries} tr${tries === 1 ? 'y' : 'ies'}${errors.length ? `: ${errors[0]}` : ''}`);
if (!(await waitCaptured())) {
  console.error('no capsule was captured');
  await browser.close();
  process.exit(3);
}
if (offline) {
  console.log(`offline: ${await pending()} capsule(s) queued in IndexedDB, uploads so far: ${uploads.length}`);
  await context.unroute(`${backend}/v1/capsules`);
  errors.length = 0;
  // Restart the app (reload); the queued capsule uploads after the config fetch.
  await page.goto(appUrl.href.replace(/\/$/, '') + '/orders');
  for (let i = 0; i < 60 && !uploads.some((u) => u.status === 201); i++) await sleep(250);
  console.log(`after reload: uploads ${JSON.stringify(uploads.map((u) => u.status))}, queued ${await pending()}`);
}
const ok = uploads.find((u) => u.status === 201 || u.status === 200);
if (!ok) {
  console.error('the capsule was not uploaded');
  await browser.close();
  process.exit(4);
}
console.log(`uploaded capsule ${ok.body.id} (capsuleId ${ok.body.capsuleId}, ${ok.body.eligibility}, ${ok.body.runtime})`);
console.log(`BUGCAPSULE_SERVER_ID=${ok.body.id}`);
await browser.close();
