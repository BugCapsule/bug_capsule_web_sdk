import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import vm from 'node:vm';
import { gunzipSync } from 'node:zlib';
import { main } from '../../packages/cli/src/index.js';
import { debugIdFromContent, injectFile, readDebugId } from '../../packages/cli/src/sourcemaps.js';
import { debugIdsByScript } from '../../packages/web/src/monitoring/debug-ids.js';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function build(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'bc-cli-'));
  dirs.push(dir);
  mkdirSync(path.join(dir, 'assets'));
  mkdirSync(path.join(dir, 'node_modules'));
  writeFileSync(path.join(dir, 'assets', 'index-3f2a.js'), 'console.log("app");\n//# sourceMappingURL=index-3f2a.js.map\n');
  writeFileSync(path.join(dir, 'assets', 'index-3f2a.js.map'), JSON.stringify({ version: 3, sources: ['src/main.ts'], names: [], mappings: 'AAAA' }));
  writeFileSync(path.join(dir, 'assets', 'chunk.mjs'), 'export const x = 1;');
  writeFileSync(path.join(dir, 'assets', 'chunk.mjs.map'), JSON.stringify({ version: 3, sources: [], names: [], mappings: '' }));
  writeFileSync(path.join(dir, 'assets', 'nomap.js'), 'var y = 2;');
  writeFileSync(path.join(dir, 'node_modules', 'dep.js'), 'skip me');
  return dir;
}

const quiet = { out: () => {}, err: () => {} };

describe('sourcemaps inject', () => {
  it('writes the debug id into bundle and map; idempotent; mappings untouched', async () => {
    const dir = build();
    const js = path.join(dir, 'assets', 'index-3f2a.js');
    const original = readFileSync(js, 'utf8');
    const lines: string[] = [];
    assert.equal(await main(['sourcemaps', 'inject', dir], { out: (s) => lines.push(s), err: () => {} }), 0);
    const injected = readFileSync(js, 'utf8');
    const id = readDebugId(injected)!;
    assert.equal(id, debugIdFromContent(original));
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.ok(injected.startsWith(original.split('//# sourceMappingURL')[0]!), 'the original code keeps its lines, so the map stays valid');
    assert.ok(injected.trimEnd().endsWith('//# sourceMappingURL=index-3f2a.js.map'), 'sourceMappingURL stays the last comment');
    const map = JSON.parse(readFileSync(`${js}.map`, 'utf8'));
    assert.equal(map.debugId, id);
    assert.equal(map.mappings, 'AAAA');
    assert.ok(readDebugId(readFileSync(path.join(dir, 'assets', 'chunk.mjs'), 'utf8')));
    assert.ok(readDebugId(readFileSync(path.join(dir, 'assets', 'nomap.js'), 'utf8')), 'bundles without maps still get an id');
    assert.equal(readFileSync(path.join(dir, 'node_modules', 'dep.js'), 'utf8'), 'skip me');
    assert.ok(lines.join('').includes('3 bundles, 3 changed'));
    const again = await injectFile(js);
    assert.equal(again.changed, false);
    assert.equal(readFileSync(js, 'utf8'), injected);
  });

  it('the snippet registers the id under a stack the SDK resolves to the script URL', async () => {
    const dir = build();
    const js = path.join(dir, 'assets', 'index-3f2a.js');
    await injectFile(js);
    const code = readFileSync(js, 'utf8');
    const sandbox: Record<string, unknown> = { console: { log() {} } };
    sandbox.globalThis = sandbox;
    sandbox.Error = Error;
    vm.runInNewContext(code, sandbox, { filename: 'https://shop.example.com/assets/index-3f2a.js' });
    const ids = debugIdsByScript(sandbox);
    assert.equal(ids.get('https://shop.example.com/assets/index-3f2a.js'), readDebugId(code));
  });
});

describe('sourcemaps upload', () => {
  it('uploads maps by debug id and bundles by release to /v1/debug-files with the secret key', async () => {
    const received: { url: string; auth: string | undefined; encoding: string | undefined; body: Buffer }[] = [];
    let failOnce = true;
    const server = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        if (failOnce) {
          failOnce = false;
          res.writeHead(503, { 'retry-after': '0' }).end('{}');
          return;
        }
        received.push({ url: req.url!, auth: req.headers.authorization, encoding: req.headers['content-encoding'], body: gunzipSync(Buffer.concat(chunks)) });
        res.writeHead(201, { 'content-type': 'application/json' }).end('{"id":"df_1"}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const dir = build();
      await main(['sourcemaps', 'inject', dir], quiet);
      const code = await main(['sourcemaps', 'upload', dir, '--url', url, '--release', 'shop-web@1.4.0+52', '--url-prefix', '~/static'], { ...quiet, env: { BUGCAPSULE_SECRET_KEY: 'bcs_secret' } });
      assert.equal(code, 0);
      const parsed = received.map((r) => ({ ...Object.fromEntries(new URL(r.url, url).searchParams), path: new URL(r.url, url).pathname, auth: r.auth, encoding: r.encoding }));
      assert.ok(parsed.every((p) => p.path === '/v1/debug-files' && p.auth === 'Bearer bcs_secret' && p.encoding === 'gzip'));
      const id = readDebugId(readFileSync(path.join(dir, 'assets', 'index-3f2a.js'), 'utf8'));
      assert.deepEqual(
        parsed.map(({ kind, name, debugId, release }) => ({ kind, name, debugId, release })),
        [
          { kind: 'sourcemap', name: '~/static/assets/chunk.mjs.map', debugId: readDebugId(readFileSync(path.join(dir, 'assets', 'chunk.mjs'), 'utf8')), release: 'shop-web@1.4.0+52' },
          { kind: 'minified_source', name: '~/static/assets/chunk.mjs', debugId: readDebugId(readFileSync(path.join(dir, 'assets', 'chunk.mjs'), 'utf8')), release: 'shop-web@1.4.0+52' },
          { kind: 'sourcemap', name: '~/static/assets/index-3f2a.js.map', debugId: id, release: 'shop-web@1.4.0+52' },
          { kind: 'minified_source', name: '~/static/assets/index-3f2a.js', debugId: id, release: 'shop-web@1.4.0+52' },
        ],
      );
      assert.equal(JSON.parse(received[2]!.body.toString()).debugId, id);
    } finally {
      server.close();
    }
  });

  it('refuses the ingest key and requires a key and URL', async () => {
    const dir = build();
    const errors: string[] = [];
    assert.equal(await main(['sourcemaps', 'upload', dir, '--url', 'http://x', '--key', 'bci_ingest'], { out: () => {}, err: (s) => errors.push(s) }), 1);
    assert.match(errors.join(''), /secret key/);
    assert.equal(await main(['sourcemaps', 'upload', dir, '--url', 'http://x'], { ...quiet, env: {} }), 2);
    assert.equal(await main(['sourcemaps', 'upload', dir], { ...quiet, env: { BUGCAPSULE_SECRET_KEY: 'bcs_x' } }), 2);
    assert.equal(await main(['nope'], quiet), 2);
    assert.equal(await main(['--help'], quiet), 0);
  });

  it('--dry-run changes nothing and sends nothing', async () => {
    const dir = build();
    const js = path.join(dir, 'assets', 'index-3f2a.js');
    const before = readFileSync(js, 'utf8');
    assert.equal(await main(['sourcemaps', 'inject', dir, '--dry-run'], quiet), 0);
    assert.equal(readFileSync(js, 'utf8'), before);
    let called = false;
    const fetchSpy = (async () => {
      called = true;
      return new Response('{}');
    }) as unknown as typeof fetch;
    assert.equal(await main(['sourcemaps', 'upload', dir, '--url', 'http://x', '--release', 'r', '--dry-run'], { ...quiet, env: {}, fetch: fetchSpy }), 0);
    assert.equal(called, false);
  });
});
