import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { MdnsInstance, MdnsPacket } from 'multicast-dns';
import { isAudioOnly, type CastDevice } from '../src/cast/device.ts';
import { CAST_SERVICE, CastDiscovery, CastRecordCache } from '../src/cast/discovery.ts';
import { silentLogger } from '../src/logger.ts';

const INSTANCE = `Nest-Mini-abc123.${CAST_SERVICE}`;
const txt = (entries: Record<string, string>) => Object.entries(entries).map(([k, v]) => Buffer.from(`${k}=${v}`));

const fullPacket: MdnsPacket = {
  answers: [{ name: CAST_SERVICE, type: 'PTR', ttl: 120, data: INSTANCE }],
  additionals: [
    { name: INSTANCE, type: 'SRV', data: { target: 'abc123.local', port: 8009 } },
    { name: INSTANCE, type: 'TXT', data: txt({ id: 'ABC1-23', fn: 'Kitchen', md: 'Nest Mini', ca: '199172' }) },
    { name: 'abc123.local', type: 'A', data: '192.168.1.50' },
  ],
};

test('assembles a device from one complete packet', () => {
  const { devices, missing } = new CastRecordCache().ingest(fullPacket);
  assert.deepEqual(devices, [
    { id: 'abc123', name: 'Kitchen', model: 'Nest Mini', host: '192.168.1.50', port: 8009, capabilities: 199172, isGroup: false },
  ]);
  assert.deepEqual(missing, []);
});

test('assembles a device from records spread over several packets', () => {
  const cache = new CastRecordCache();
  const first = cache.ingest({ answers: fullPacket.answers });
  assert.deepEqual(first.devices, []);
  assert.deepEqual(first.missing, [{ name: INSTANCE.toLowerCase(), type: 'SRV' }]);

  const second = cache.ingest({ answers: fullPacket.additionals?.slice(0, 2) });
  assert.deepEqual(second.missing, [{ name: 'abc123.local', type: 'A' }]);

  const third = cache.ingest({ answers: fullPacket.additionals?.slice(2) });
  assert.equal(third.devices[0]?.host, '192.168.1.50');
});

test('reports a goodbye for a known device', () => {
  const cache = new CastRecordCache();
  cache.ingest(fullPacket);
  const { goodbyes } = cache.ingest({ answers: [{ name: CAST_SERVICE, type: 'PTR', ttl: 0, data: INSTANCE }] });
  assert.deepEqual(goodbyes, ['abc123']);
});

test('ignores records of other services', () => {
  const { devices } = new CastRecordCache().ingest({
    answers: [{ name: '_airplay._tcp.local', type: 'PTR', ttl: 120, data: 'TV._airplay._tcp.local' }],
  });
  assert.deepEqual(devices, []);
});

test('audio detection uses capability bits, with groups always counting as audio', () => {
  const base: CastDevice = { id: 'x', name: 'Living Room TV', model: 'Chromecast', host: 'h', port: 8009, capabilities: 4101, isGroup: false };
  assert.equal(isAudioOnly(base), false, 'video out bit set');
  assert.equal(isAudioOnly({ ...base, capabilities: 199172 }), true, 'audio out only');
  assert.equal(isAudioOnly({ ...base, capabilities: null }), false, 'name hints at a TV');
  assert.equal(isAudioOnly({ ...base, name: 'Bose Speaker', model: '', capabilities: null }), true);
  assert.equal(isAudioOnly({ ...base, isGroup: true }), true);
});

test('discovery emits devices and asks for missing records', () => {
  class FakeMdns extends EventEmitter {
    queries: { name: string; type: string }[][] = [];
    query(questions: { name: string; type: string }[]): void {
      this.queries.push(questions);
    }
    destroy(): void {}
  }
  const fake = new FakeMdns();
  const discovery = new CastDiscovery({ addresses: ['192.168.1.2'], logger: silentLogger, mdnsFactory: () => fake as unknown as MdnsInstance });
  const seen: CastDevice[] = [];
  discovery.on('device', (device: CastDevice) => seen.push(device));
  discovery.start();
  assert.deepEqual(fake.queries[0], [{ name: CAST_SERVICE, type: 'PTR' }]);

  fake.emit('response', { answers: fullPacket.answers });
  assert.deepEqual(fake.queries.at(-1), [{ name: INSTANCE.toLowerCase(), type: 'SRV' }]);
  fake.emit('response', fullPacket);
  assert.equal(seen[0]?.name, 'Kitchen');
  fake.emit('response', { answers: [{ name: 'broken', type: 'SRV', data: null }] });
  discovery.stop();
});
