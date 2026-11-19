import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, test } from 'node:test';
import { createHttpServer, isTrustedClient } from '../src/http.ts';
import { silentLogger } from '../src/logger.ts';

test('only ingress and localhost are trusted unless opened explicitly', () => {
  assert.equal(isTrustedClient('172.30.32.2', false), true);
  assert.equal(isTrustedClient('::ffff:172.30.32.2', false), true);
  assert.equal(isTrustedClient('127.0.0.1', false), true);
  assert.equal(isTrustedClient('192.168.1.50', false), false);
  assert.equal(isTrustedClient(undefined, false), false);
  assert.equal(isTrustedClient('192.168.1.50', true), true);
});

const calls: string[] = [];
let healthy = true;
const server = createHttpServer({
  port: 0,
  uiOpen: false,
  uiDir: path.resolve('ui'),
  logger: silentLogger,
  getHealth: () => ({ ok: healthy, version: 'test', uptimeSeconds: 1, receivers: 2 }),
  getStatus: () => ({ devices: [] }),
  actions: {
    setDeviceEnabled: async (id, enabled) => {
      if (id === 'boom') throw new Error('secret internals');
      calls.push(`${id}:${enabled}`);
    },
    rescan: async () => { calls.push('rescan'); },
    updateYtDlp: async () => ({ ok: true }),
    selfTest: async () => ({ ok: true }),
  },
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

const post = (url: string, body: unknown, type = 'application/json') =>
  fetch(base + url, { method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('health check reflects health and exposes nothing sensitive', async () => {
  const ok = await fetch(`${base}/healthz`);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, version: 'test', uptimeSeconds: 1, receivers: 2 });
  healthy = false;
  assert.equal((await fetch(`${base}/healthz`)).status, 503);
  healthy = true;
});

test('serves the UI with a strict content security policy', async () => {
  for (const file of ['/', '/app.js', '/app.css']) {
    const response = await fetch(base + file);
    assert.equal(response.status, 200, file);
    assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }
  assert.match(await (await fetch(`${base}//`)).text(), /YT Cast Audio Bridge/);
  assert.equal((await fetch(`${base}/../package.json`)).status, 404);
  assert.equal((await fetch(`${base}/api/unknown`)).status, 404);
});

test('status and actions work, bad input is rejected', async () => {
  assert.deepEqual(await (await fetch(`${base}/api/status`)).json(), { devices: [] });
  assert.equal((await post('/api/devices/abc123/enabled', { enabled: false })).status, 200);
  assert.equal((await post('/api/rescan', {})).status, 200);
  assert.deepEqual(calls, ['abc123:false', 'rescan']);

  assert.equal((await post('/api/devices/abc123/enabled', { enabled: 'no' })).status, 400);
  assert.equal((await post('/api/devices/abc123/enabled', '{"enabled":true}', 'text/plain')).status, 415);
  assert.equal((await post('/api/rescan', '{broken')).status, 400);
  assert.equal((await post('/api/rescan', { pad: 'x'.repeat(20_000) })).status, 413);
  assert.equal((await fetch(`${base}/api/status`, { method: 'DELETE' })).status, 405);
});

test('internal errors do not leak details', async () => {
  const response = await post('/api/devices/boom/enabled', { enabled: true });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { ok: false, error: 'Internal error' });
});
