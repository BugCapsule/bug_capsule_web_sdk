#!/usr/bin/env node
// Bundle-size budget for @bugcapsule/web (BC-ENT-036). Bundles the BUILT
// entry (packages/web/dist/index.js) the way an app's bundler would
// (ESM, browser, minified, everything reachable included), gzips it, and
// fails when it exceeds the committed budget in bundle-size-budget.json.
//
//   node scripts/check-bundle-size.mjs           check (run by npm test)
//   node scripts/check-bundle-size.mjs --update  set the budget to the current size + 10 %
//
// Raise the budget only on purpose, in the same change that grows the SDK.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { buildSync } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'packages/web/dist/index.js');
const budgetFile = path.join(root, 'scripts/bundle-size-budget.json');

if (!existsSync(entry)) {
  console.error(`bundle size: ${path.relative(root, entry)} is missing; run "npm run build" first`);
  process.exit(1);
}

const out = buildSync({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', minify: true, logLevel: 'silent' });
const code = out.outputFiles[0].contents;
const gzip = gzipSync(code, { level: 9 }).length;
const kib = (n) => `${(n / 1024).toFixed(1)} KiB`;

if (process.argv.includes('--update')) {
  const budget = Math.ceil(gzip * 1.1);
  writeFileSync(budgetFile, `${JSON.stringify({ '@bugcapsule/web': { entry: 'packages/web/dist/index.js', gzipBytes: budget, measuredGzipBytes: gzip } }, null, 2)}\n`);
  console.log(`bundle size: budget set to ${kib(budget)} gzip (measured ${kib(gzip)} + 10 %)`);
  process.exit(0);
}

const budget = JSON.parse(readFileSync(budgetFile, 'utf8'))['@bugcapsule/web'].gzipBytes;
const line = `@bugcapsule/web: ${kib(gzip)} gzip (${kib(code.length)} minified), budget ${kib(budget)}`;
if (gzip > budget) {
  console.error(`bundle size: over budget by ${kib(gzip - budget)}. ${line}`);
  process.exit(1);
}
console.log(`bundle size ok. ${line}`);
