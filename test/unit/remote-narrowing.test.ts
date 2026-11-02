import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { explicitBackendRefusal } from '../../packages/web/src/connection-token.js';
import { compileTargets, shouldPropagate } from '../../packages/web/src/monitoring/tracing.js';
import { MAX_REMOTE_CAPSULE_BYTES, parseRemoteConfig } from '../../packages/web/src/remote-config.js';

/**
 * Server settings can only narrow what the app configured (BC-ENT-018), and
 * the ingest key never travels over plain http to a remote host.
 */
describe('remote maxCapsuleBytes', () => {
  it('is clamped to the backend maximum', () => {
    assert.equal(MAX_REMOTE_CAPSULE_BYTES, 50 * 1024 * 1024);
    assert.equal(parseRemoteConfig({ maxCapsuleBytes: 2 ** 62 }).maxCapsuleBytes, MAX_REMOTE_CAPSULE_BYTES);
    assert.equal(parseRemoteConfig({ maxCapsuleBytes: Number.MAX_VALUE }).maxCapsuleBytes, MAX_REMOTE_CAPSULE_BYTES);
    assert.equal(parseRemoteConfig({ maxCapsuleBytes: Infinity }).maxCapsuleBytes, MAX_REMOTE_CAPSULE_BYTES);
    assert.equal(parseRemoteConfig({ maxCapsuleBytes: NaN }).maxCapsuleBytes, 1);
    assert.equal(parseRemoteConfig({ maxCapsuleBytes: -5 }).maxCapsuleBytes, 1);
    assert.equal(parseRemoteConfig({ maxCapsuleBytes: 2048.7 }).maxCapsuleBytes, 2048);
    assert.equal(parseRemoteConfig({}).maxCapsuleBytes, 5 * 1024 * 1024);
  });
});

describe('trace propagation targets', () => {
  const app = compileTargets(['api.shop.test']);

  it('a server list can remove destinations but not add them', () => {
    const server = ['api.shop.test/cart', 'evil.test'];
    assert.equal(shouldPropagate('https://api.shop.test/cart/1', app, null, server), true);
    assert.equal(shouldPropagate('https://api.shop.test/profile', app, null, server), false, 'narrowed away');
    assert.equal(shouldPropagate('https://evil.test/x', app, null, server), false, 'the app never listed it');
  });

  it('server entries are plain text, never patterns', () => {
    assert.equal(shouldPropagate('https://api.shop.test/cart', app, null, ['/.*/']), false);
    assert.equal(shouldPropagate('https://api.shop.test/a/.*/b', app, null, ['/.*/']), true, 'matched literally');
  });

  it('narrows the same-origin default too, and never adds a foreign host to it', () => {
    const origin = 'https://shop.test';
    assert.equal(shouldPropagate('/api/cart', null, origin, null), true);
    assert.equal(shouldPropagate('/api/cart', null, origin, ['/api/']), true);
    assert.equal(shouldPropagate('/static/a.js', null, origin, ['/api/']), false);
    assert.equal(shouldPropagate('https://evil.test/api/x', null, origin, ['evil.test']), false);
  });

  it('without a server list the app list applies as before', () => {
    const patterns = compileTargets(['/^https:\\/\\/api\\./']);
    assert.equal(shouldPropagate('https://api.shop.test/cart', patterns, null), true);
    assert.equal(shouldPropagate('https://cdn.shop.test/a.png', patterns, null), false);
    assert.equal(shouldPropagate('https://api.shop.test/cart', patterns, null, ['shop.test']), true);
  });
});

describe('explicit backend config', () => {
  const refusal = (url: string, ingestKey = 'bct_abcdefghijklmnopqrstuvwx') => explicitBackendRefusal({ url, ingestKey });

  it('accepts https and local development hosts', () => {
    assert.equal(refusal('https://bugs.example.com'), null);
    assert.equal(refusal('http://127.0.0.1:8787'), null);
    assert.equal(refusal('http://localhost:8787'), null);
    assert.equal(refusal('http://[::1]:8787'), null);
    assert.equal(refusal('http://10.0.2.2:8787'), null);
  });

  it('refuses plain http to a remote or LAN host', () => {
    assert.match(refusal('http://api.example.com')!, /https/);
    assert.match(refusal('http://192.168.1.20:8787')!, /https/);
    assert.match(refusal('http://127.0.0.1.evil.test')!, /https/);
    assert.match(refusal('not a url')!, /https/);
    assert.match(refusal('ftp://bugs.example.com')!, /https/);
  });

  it('refuses a secret key', () => {
    assert.match(refusal('https://bugs.example.com', 'bcs_abcdefghijklmnopqrstuvwx')!, /secret/);
  });
});
