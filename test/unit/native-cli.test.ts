import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-ignore Native executable launcher is intentionally plain Node.js.
import { assetName, ensureBinary } from '../../packages/cli/bin/native-cli.js';

test('standalone CLI platform mapping rejects unsupported targets', () => {
  assert.equal(assetName('win32', 'x64'), 'bugcapsule-win32-x64.exe');
  assert.equal(assetName('darwin', 'arm64'), 'bugcapsule-darwin-arm64');
  assert.throws(() => assetName('linux', 'ia32'), /Unsupported platform/);
});
test('verified binary is reused offline and a corrupted cache is repaired', async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'bugcapsule-cli-test-'));
  const data = Buffer.from('test executable');
  const checksum = createHash('sha256').update(data).digest('hex');
  let requests = 0;
  const fetcher = async (url: string) => { requests++; return new Response(url.endsWith('.sha256') ? `${checksum}  binary\n` : data); };
  try {
    const file = await ensureBinary({ cacheRoot, fetcher });
    assert.deepEqual(await readFile(file), data);
    assert.equal(requests, 2);
    await ensureBinary({ cacheRoot, fetcher: () => { throw Error('offline'); } });
    await writeFile(file, 'corrupt');
    await ensureBinary({ cacheRoot, fetcher });
    assert.equal(requests, 4);
    assert.deepEqual(await readFile(file), data);
  } finally { await rm(cacheRoot, { recursive: true, force: true }); }
});
test('bad checksum and missing assets fail without executing or caching content', async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'bugcapsule-cli-test-'));
  try {
    await assert.rejects(ensureBinary({ cacheRoot, fetcher: async () => new Response('no', { status: 404 }) }), /HTTP 404/);
    await assert.rejects(ensureBinary({ cacheRoot, fetcher: async (url: string) => new Response(url.endsWith('.sha256') ? '0'.repeat(64) : 'bad') }), /checksum mismatch/);
  } finally { await rm(cacheRoot, { recursive: true, force: true }); }
});
