import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ReceiverHandle, ReceiverSnapshot, ReceiverSpec } from '../src/bridge/receiver.ts';
import { BridgeSupervisor, evaluateDevice, pickPort, uniqueNames, type FilterConfig } from '../src/bridge/supervisor.ts';
import type { CastDevice } from '../src/cast/device.ts';
import { CastDeviceRegistry } from '../src/cast/registry.ts';
import { parseConfig } from '../src/config.ts';
import { silentLogger } from '../src/logger.ts';
import { StateStore } from '../src/state.ts';

const speaker = (id: string, extra: Partial<CastDevice> = {}): CastDevice => ({
  id, name: `Speaker ${id}`, model: 'Nest Mini', host: `10.0.0.${id}`, port: 8009, capabilities: 4, isGroup: false, ...extra,
});
const filters: FilterConfig = { onlyAudioLike: true, includeGroups: true, includeRegex: null, excludeRegex: null, pinnedHosts: [] };

test('evaluateDevice explains every reason for hiding a device', () => {
  assert.deepEqual(evaluateDevice(speaker('1'), filters, false), { expose: true, reason: '' });
  assert.match(evaluateDevice(speaker('1'), filters, true).reason, /Switched off/);
  assert.match(evaluateDevice(speaker('1', { capabilities: 5 }), filters, false).reason, /screen/);
  assert.equal(evaluateDevice(speaker('1', { capabilities: 5 }), { ...filters, onlyAudioLike: false }, false).expose, true);
  assert.match(evaluateDevice(speaker('1', { isGroup: true }), { ...filters, includeGroups: false }, false).reason, /groups/);
  assert.match(evaluateDevice(speaker('1'), { ...filters, excludeRegex: /speaker 1/i }, false).reason, /exclude_regex/);
  assert.match(evaluateDevice(speaker('1'), { ...filters, includeRegex: /kitchen/i }, false).reason, /include_regex/);
  assert.match(evaluateDevice(speaker('1'), { ...filters, pinnedHosts: ['10.0.0.9'] }, false).reason, /pinned_hosts/);
  assert.equal(evaluateDevice(speaker('1'), { ...filters, pinnedHosts: ['speaker 1'] }, false).expose, true);
});

test('duplicate names get a suffix, ports skip taken ones', () => {
  const names = uniqueNames([speaker('1', { name: 'Bad' }), speaker('2', { name: 'Bad' }), speaker('3', { name: 'Küche' })]);
  assert.equal(names.get('1'), 'Bad (10.0.0.1)');
  assert.equal(names.get('3'), 'Küche');
  assert.equal(pickPort(3000, new Set([3000, 3001, 3003])), 3002);
});

class FakeReceiver implements ReceiverHandle {
  static failPorts = new Set<number>();
  senders = 0;
  stopped = false;
  terminated: ((reason: string) => void) | null = null;
  readonly spec: ReceiverSpec;
  constructor(spec: ReceiverSpec) { this.spec = spec; }
  async start(): Promise<void> {
    if (FakeReceiver.failPorts.has(this.spec.port)) throw new Error('listen EADDRINUSE');
  }
  async stop(): Promise<void> { this.stopped = true; }
  snapshot(): ReceiverSnapshot {
    return { port: this.spec.port, displayName: this.spec.displayName, senders: this.senders, nowPlaying: null, lastError: '' };
  }
  onTerminated(listener: (reason: string) => void): void { this.terminated = listener; }
}

async function setup(options: Record<string, unknown> = {}) {
  FakeReceiver.failPorts = new Set();
  let now = 1_000_000;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'supervisor-test-'));
  const state = new StateStore(path.join(dir, 'state.json'), silentLogger);
  await state.load();
  const { config } = parseConfig({ offline_hide_after_ms: 100_000, ...options }, { dataDir: dir });
  const registry = new CastDeviceRegistry({ onlineWindowMs: 60_000, forgetAfterMs: 10_000_000, now: () => now });
  const created: FakeReceiver[] = [];
  const supervisor = new BridgeSupervisor({
    registry, state, config, bindAddresses: ['10.0.0.2'], bindInterfaces: [], logger: silentLogger, now: () => now,
    createReceiver: (spec) => {
      const receiver = new FakeReceiver(spec);
      created.push(receiver);
      return receiver;
    },
  });
  const stateOf = (id: string) => supervisor.status().find((d) => d.id === id);
  return { supervisor, registry, state, created, stateOf, advance: (ms: number) => (now += ms), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('starts one receiver per audio device with stable ports and prefixed names', async () => {
  const t = await setup();
  try {
    t.registry.upsert(speaker('1'));
    t.registry.upsert(speaker('2', { capabilities: 5, name: 'TV' }));
    t.registry.upsert(speaker('3'));
    await t.supervisor.reconcile();
    await t.supervisor.reconcile();
    assert.deepEqual(t.created.map((r) => [r.spec.displayName, r.spec.port]), [['Audio -> Speaker 1', 3000], ['Audio -> Speaker 3', 3001]]);
    assert.equal(t.stateOf('2')?.state, 'hidden');
    assert.equal(t.state.get('3').port, 3001);
    assert.deepEqual(t.created[0]?.spec.getEndpoint(), { host: '10.0.0.1', port: 8009 });
  } finally {
    await t.cleanup();
  }
});

test('a saved port is reused and never handed to a new device', async () => {
  const t = await setup();
  try {
    t.state.update('7', { port: 3000 });
    t.registry.upsert(speaker('1'));
    await t.supervisor.reconcile();
    assert.equal(t.created[0]?.spec.port, 3001);
    t.registry.upsert(speaker('7'));
    await t.supervisor.reconcile();
    assert.equal(t.created[1]?.spec.port, 3000);
  } finally {
    await t.cleanup();
  }
});

test('one failing device does not block the others and is retried with backoff on another port', async () => {
  const t = await setup();
  try {
    FakeReceiver.failPorts.add(3000);
    t.registry.upsert(speaker('1'));
    t.registry.upsert(speaker('2'));
    await t.supervisor.reconcile();
    assert.equal(t.stateOf('1')?.state, 'error');
    assert.equal(t.stateOf('2')?.state, 'active');
    assert.equal(t.created.length, 2);

    await t.supervisor.reconcile();
    assert.equal(t.created.length, 2, 'not retried before the backoff elapsed');
    t.advance(6_000);
    await t.supervisor.reconcile();
    assert.equal(t.stateOf('1')?.state, 'active');
    assert.equal(t.created[2]?.spec.port, 3002, 'the blocked port is avoided');
  } finally {
    await t.cleanup();
  }
});

test('offline speakers keep their receiver for the grace period and while a phone is connected', async () => {
  const t = await setup();
  try {
    t.registry.upsert(speaker('1'));
    await t.supervisor.reconcile();
    t.advance(90_000);
    await t.supervisor.reconcile();
    assert.equal(t.created[0]?.stopped, false, 'inside grace period');
    t.created[0]!.senders = 1;
    t.advance(60_000);
    await t.supervisor.reconcile();
    assert.equal(t.created[0]?.stopped, false, 'in use');
    t.created[0]!.senders = 0;
    await t.supervisor.reconcile();
    assert.equal(t.created[0]?.stopped, true);
    assert.equal(t.stateOf('1')?.state, 'offline');

    t.registry.upsert(speaker('1'));
    await t.supervisor.reconcile();
    assert.equal(t.stateOf('1')?.state, 'active');
  } finally {
    await t.cleanup();
  }
});

test('switching a device off stops its receiver, switching on brings it back', async () => {
  const t = await setup();
  try {
    t.registry.upsert(speaker('1'));
    await t.supervisor.reconcile();
    t.supervisor.setEnabled('1', false);
    await t.supervisor.reconcile();
    assert.equal(t.created[0]?.stopped, true);
    assert.equal(t.stateOf('1')?.enabled, false);
    t.supervisor.setEnabled('1', true);
    await t.supervisor.reconcile();
    assert.equal(t.stateOf('1')?.state, 'active');
    assert.equal(t.created[1]?.spec.port, 3000);
  } finally {
    await t.cleanup();
  }
});

test('a renamed speaker gets a receiver with the new name', async () => {
  const t = await setup();
  try {
    t.registry.upsert(speaker('1'));
    await t.supervisor.reconcile();
    t.registry.upsert(speaker('1', { name: 'Kitchen' }));
    await t.supervisor.reconcile();
    assert.equal(t.created[0]?.stopped, true);
    assert.equal(t.created[1]?.spec.displayName, 'Audio -> Kitchen');
  } finally {
    await t.cleanup();
  }
});

test('a receiver that dies on its own is restarted after the backoff', async () => {
  const t = await setup();
  try {
    t.registry.upsert(speaker('1'));
    await t.supervisor.reconcile();
    t.created[0]!.terminated?.('lounge connection lost');
    await t.supervisor.reconcile();
    assert.equal(t.stateOf('1')?.state, 'error');
    t.advance(6_000);
    await t.supervisor.reconcile();
    assert.equal(t.stateOf('1')?.state, 'active');
  } finally {
    await t.cleanup();
  }
});

test('max_receivers limits the number of receivers and says so', async () => {
  const t = await setup({ max_receivers: 1 });
  try {
    t.registry.upsert(speaker('1'));
    t.registry.upsert(speaker('2'));
    await t.supervisor.reconcile();
    assert.equal(t.created.length, 1);
    assert.match(t.stateOf('2')?.reason ?? '', /max_receivers/);
    await t.supervisor.stopAll();
    assert.equal(t.created[0]?.stopped, true);
  } finally {
    await t.cleanup();
  }
});
