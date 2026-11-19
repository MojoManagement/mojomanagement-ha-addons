import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { PairingWindow } from '../src/bridge/pairing.ts';
import { silentLogger } from '../src/logger.ts';

class FakeService extends EventEmitter {
  starts = 0;
  stops = 0;
  start(): void { this.starts += 1; }
  stop(): void { this.stops += 1; }
}
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

test('starts the service on request and resolves with the first code', async () => {
  const service = new FakeService();
  const pairing = new PairingWindow(service, silentLogger);
  assert.equal(pairing.current as unknown, null);
  const pending = pairing.request();
  assert.equal(service.starts, 1);
  service.emit('response', '123456789012');
  const result = await pending;
  assert.equal(result.code, '123456789012');
  assert.ok(result.validUntil > Date.now());
  assert.equal(pairing.current?.code, '123456789012');
  pairing.stop();
});

test('a second request reuses the running service, refreshed codes replace the old one', async () => {
  const service = new FakeService();
  const pairing = new PairingWindow(service, silentLogger);
  const first = pairing.request();
  service.emit('response', '111111111111');
  await first;
  assert.equal((await pairing.request()).code, '111111111111');
  assert.equal(service.starts, 1);
  service.emit('response', '222222222222');
  assert.equal(pairing.current?.code, '222222222222');
  pairing.stop();
});

test('the window closes by itself and stops asking YouTube', async () => {
  const service = new FakeService();
  const pairing = new PairingWindow(service, silentLogger, { windowMs: 20 });
  const pending = pairing.request();
  service.emit('response', '123456789012');
  await pending;
  await tick(40);
  assert.equal(pairing.current, null);
  assert.equal(service.stops, 1);
  const again = pairing.request();
  assert.equal(service.starts, 2);
  service.emit('response', '333333333333');
  assert.equal((await again).code, '333333333333');
  pairing.stop();
});

test('errors and silence are reported instead of hanging', async () => {
  const failing = new FakeService();
  const first = new PairingWindow(failing, silentLogger);
  const pending = first.request();
  failing.emit('error', new Error('HTTP 403'));
  await assert.rejects(pending, /did not provide a TV code: HTTP 403/);
  assert.equal(first.current, null);

  const silent = new PairingWindow(new FakeService(), silentLogger, { firstCodeTimeoutMs: 15 });
  await assert.rejects(silent.request(), /did not answer in time/);
  silent.stop();
});

test('stopping rejects a pending request', async () => {
  const service = new FakeService();
  const pairing = new PairingWindow(service, silentLogger);
  const pending = pairing.request();
  pairing.stop();
  await assert.rejects(pending, /receiver was stopped/);
});
