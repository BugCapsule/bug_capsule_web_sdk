#!/usr/bin/env node
import { runNative } from './native-cli.js';
try {
  const args = process.argv.slice(2);
  // Keep sourcemap tooling available under both command names.
  if (args[0] === 'sourcemaps') {
    const { main } = await import('../dist/index.js');
    process.exitCode = await main(args);
  } else {
    process.exitCode = await runNative(args);
  }
} catch (error) {
  console.error(`bugcapsule: ${error.message}`);
  process.exitCode = 1;
}
