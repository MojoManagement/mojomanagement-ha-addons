import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CastDeviceRegistry } from '../src/registry.mjs';

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.devices = [];
  }

  update() {}
}

test('CastDeviceRegistry returns only active devices inside offline window', () => {
  const now = Date.now();
  const logger = { warn() {} };
  const client = new FakeClient();
  const registry = new CastDeviceRegistry({ intervalMs: 1000, offlineHideAfterMs: 1000, logger, client });

  registry.records.set('fresh.local', { device: { host: 'fresh.local' }, firstSeen: now - 100, lastSeen: now - 200, source: 'test' });
  registry.records.set('stale.local', { device: { host: 'stale.local' }, firstSeen: now - 5000, lastSeen: now - 2000, source: 'test' });

  const active = registry.getActiveDevices(now).map((d) => d.host);
  assert.deepEqual(active, ['fresh.local']);
});

test('CastDeviceRegistry sorts active devices by most recent lastSeen', () => {
  const now = Date.now();
  const logger = { warn() {} };
  const client = new FakeClient();
  const registry = new CastDeviceRegistry({ intervalMs: 1000, offlineHideAfterMs: 3000, logger, client });

  registry.records.set('older.local', { device: { host: 'older.local' }, firstSeen: now - 2000, lastSeen: now - 1500, source: 'test' });
  registry.records.set('newer.local', { device: { host: 'newer.local' }, firstSeen: now - 1000, lastSeen: now - 200, source: 'test' });

  const ordered = registry.getActiveDevices(now).map((d) => d.host);
  assert.deepEqual(ordered, ['newer.local', 'older.local']);
});
