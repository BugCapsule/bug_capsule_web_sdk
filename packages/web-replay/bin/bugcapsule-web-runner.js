#!/usr/bin/env node
import { main } from '../dist/index.js';

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`[bugcapsule-web-runner] ${e?.stack ?? e}\n`);
    process.exit(1);
  },
);
