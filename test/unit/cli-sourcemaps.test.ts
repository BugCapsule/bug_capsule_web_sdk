import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import vm from 'node:vm';
import { gunzipSync } from 'node:zlib';
import { main } from '../../packages/cli/src/index.js';
import { debugIdFromContent, injectFile, readDebugId, resolveMap } from '../../packages/cli/src/sourcemaps.js';
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

describe('sourcemaps: the map must be a .map file inside the input directory (BC-ENT-033)', () => {
  /** `<tmp>/secret.env` + `<tmp>/outside.map` beside the build dir `<tmp>/dist`. */
  function hostile(mappingUrl: string): { dir: string; dist: string; js: string } {
    const dir = mkdtempSync(path.join(tmpdir(), 'bc-cli-evil-'));
    dirs.push(dir);
    const dist = path.join(dir, 'dist');
    mkdirSync(path.join(dist, 'assets'), { recursive: true });
    writeFileSync(path.join(dir, 'secret.env'), 'BUGCAPSULE_SECRET_KEY=bcs_do_not_leak\n');
    writeFileSync(path.join(dir, 'outside.map'), JSON.stringify({ version: 3, sources: [], names: [], mappings: '' }));
    const js = path.join(dist, 'assets', 'app.js');
    writeFileSync(js, `console.log(1);\n//# sourceMappingURL=${mappingUrl}\n`);
    return { dir, dist, js };
  }

  async function uploadNames(dist: string): Promise<{ names: string[]; bodies: string[]; log: string }> {
    const names: string[] = [];
    const bodies: string[] = [];
    const lines: string[] = [];
    const fetchSpy = (async (url: string, init: RequestInit) => {
      names.push(new URL(url).searchParams.get('name')!);
      bodies.push(gunzipSync(init.body as Uint8Array).toString());
      return new Response('{}', { status: 201 });
    }) as unknown as typeof fetch;
    const code = await main(['sourcemaps', 'upload', dist, '--url', 'http://x', '--release', 'r'], { out: (s) => lines.push(s), err: (s) => lines.push(s), env: { BUGCAPSULE_SECRET_KEY: 'bcs_x' }, fetch: fetchSpy });
    assert.equal(code, 0);
    return { names, bodies, log: lines.join('') };
  }

  it('rejects ../ traversal out of the root, and a non-.map target', async () => {
    const { dist, js } = hostile('../../secret.env');
    const r = resolveMap(js, readFileSync(js, 'utf8'), dist);
    assert.equal(r.map, null);
    assert.match(r.rejected!, /not a \.map file/);
    const up = await uploadNames(dist);
    assert.deepEqual(up.names, []);
    assert.ok(!up.bodies.some((b) => b.includes('bcs_do_not_leak')));
    assert.match(up.log, /skip assets\/app\.js: sourceMappingURL "\.\.\/\.\.\/secret\.env" is not a \.map file/);
  });

  it('rejects a .map that is outside the root, by ../ or by absolute path', async () => {
    const rel = hostile('../../outside.map');
    assert.match(resolveMap(rel.js, readFileSync(rel.js, 'utf8'), rel.dist).rejected!, /outside the input directory/);
    assert.deepEqual((await uploadNames(rel.dist)).names, []);
    const abs = hostile('PLACEHOLDER');
    writeFileSync(abs.js, `console.log(1);\n//# sourceMappingURL=${path.join(abs.dir, 'outside.map')}\n`);
    assert.match(resolveMap(abs.js, readFileSync(abs.js, 'utf8'), abs.dist).rejected!, /outside the input directory/);
    const up = await uploadNames(abs.dist);
    assert.deepEqual(up.names, []);
    assert.match(up.log, /outside the input directory/);
  });

  it('rejects a symlink inside the root that points out of it', async () => {
    const { dir, dist, js } = hostile('app.js.map');
    symlinkSync(path.join(dir, 'outside.map'), path.join(dist, 'assets', 'app.js.map'));
    assert.match(resolveMap(js, readFileSync(js, 'utf8'), dist).rejected!, /outside the input directory/);
    const env = hostile('leak.map');
    symlinkSync(path.join(env.dir, 'secret.env'), path.join(env.dist, 'assets', 'leak.map'));
    assert.match(resolveMap(env.js, readFileSync(env.js, 'utf8'), env.dist).rejected!, /not a \.map file/);
    assert.deepEqual((await uploadNames(env.dist)).names, []);
  });

  it('inject does not rewrite a map outside the root', async () => {
    const { dir, dist } = hostile('../../outside.map');
    const before = readFileSync(path.join(dir, 'outside.map'), 'utf8');
    const lines: string[] = [];
    assert.equal(await main(['sourcemaps', 'inject', dist], { out: (s) => lines.push(s), err: () => {} }), 0);
    assert.equal(readFileSync(path.join(dir, 'outside.map'), 'utf8'), before);
    assert.match(lines.join(''), /source map skipped: sourceMappingURL .* outside the input directory/);
  });

  it('accepts maps in subdirectories of the root and leaves data: URLs alone', async () => {
    const { dist, js } = hostile('maps/app.js.map');
    mkdirSync(path.join(dist, 'assets', 'maps'));
    writeFileSync(path.join(dist, 'assets', 'maps', 'app.js.map'), JSON.stringify({ version: 3, sources: [], names: [], mappings: '' }));
    assert.deepEqual(resolveMap(js, readFileSync(js, 'utf8'), dist), { map: path.join(dist, 'assets', 'maps', 'app.js.map'), rejected: null });
    const inline = hostile('data:application/json;base64,eyJ2ZXJzaW9uIjozfQ==');
    assert.deepEqual(resolveMap(inline.js, readFileSync(inline.js, 'utf8'), inline.dist), { map: null, rejected: null });
    writeFileSync(`${inline.js}.map`, '{"version":3,"sources":[],"names":[],"mappings":""}');
    assert.deepEqual(resolveMap(inline.js, readFileSync(inline.js, 'utf8'), inline.dist), { map: `${inline.js}.map`, rejected: null });
  });

  it('--key still works but warns to use the environment variable', async () => {
    const dir = build();
    const errors: string[] = [];
    assert.equal(await main(['sourcemaps', 'upload', dir, '--url', 'http://x', '--key', 'bcs_x', '--dry-run'], { out: () => {}, err: (s) => errors.push(s), env: {} }), 0);
    assert.match(errors.join(''), /warning: --key .* BUGCAPSULE_SECRET_KEY/);
    const quietErrors: string[] = [];
    assert.equal(await main(['sourcemaps', 'upload', dir, '--url', 'http://x', '--dry-run'], { out: () => {}, err: (s) => quietErrors.push(s), env: { BUGCAPSULE_SECRET_KEY: 'bcs_x' } }), 0);
    assert.deepEqual(quietErrors, []);
  });
});
