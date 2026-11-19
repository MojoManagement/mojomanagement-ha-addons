import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CastDevice } from '../src/cast/device.ts';
import { CastDeviceRegistry } from '../src/cast/registry.ts';

const device = (id: string, extra: Partial<CastDevice> = {}): CastDevice => ({
  id, name: `Speaker ${id}`, model: 'Nest Mini', host: `10.0.0.${id}`, port: 8009, capabilities: 4, isGroup: false, ...extra,
});

function setup() {
  let now = 1_000_000;
  const registry = new CastDeviceRegistry({ onlineWindowMs: 60_000, forgetAfterMs: 600_000, now: () => now });
  let changes = 0;
  registry.on('change', () => (changes += 1));
  return { registry, advance: (ms: number) => (now += ms), changes: () => changes };
}

test('emits change only when something relevant changed', () => {
  const { registry, changes } = setup();
  registry.upsert(device('1'));
  registry.upsert(device('1'));
  assert.equal(changes(), 1);
  registry.upsert(device('1', { host: '10.0.0.99' }));
  assert.equal(changes(), 2);
  assert.equal(registry.get('1')?.device.host, '10.0.0.99');
});

test('devices go offline when not seen and come back when seen again', () => {
  const { registry, advance, changes } = setup();
  registry.upsert(device('1'));
  advance(61_000);
  assert.equal(registry.isOnline('1'), false);
  registry.upsert(device('1'));
  assert.equal(registry.isOnline('1'), true);
  assert.equal(changes(), 2);
});

test('a goodbye takes the device offline immediately', () => {
  const { registry, changes } = setup();
  registry.upsert(device('1'));
  registry.markGone('1');
  registry.markGone('1');
  assert.equal(registry.isOnline('1'), false);
  assert.equal(changes(), 2);
});

test('long-gone devices are forgotten, order is stable', () => {
  const { registry, advance } = setup();
  registry.upsert(device('2'));
  advance(1000);
  registry.upsert(device('1'));
  assert.deepEqual(registry.list().map((r) => r.device.id), ['2', '1']);
  advance(599_500);
  registry.upsert(device('1'));
  advance(1000);
  registry.prune();
  assert.deepEqual(registry.list().map((r) => r.device.id), ['1']);
});
