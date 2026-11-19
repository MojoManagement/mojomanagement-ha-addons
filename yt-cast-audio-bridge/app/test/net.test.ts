import assert from 'node:assert/strict';
import type os from 'node:os';
import { test } from 'node:test';
import { parseDefaultRouteInterface, resolveLanBinding } from '../src/net.ts';

const v4 = (address: string): os.NetworkInterfaceInfo =>
  ({ address, family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: `${address}/24` }) as os.NetworkInterfaceInfo;

const interfaces = {
  lo: [{ ...v4('127.0.0.1'), internal: true }],
  docker0: [v4('172.17.0.1')],
  hassio: [v4('172.30.32.1')],
  enp1s0: [v4('192.168.1.20')],
  wlan0: [v4('192.168.1.21')],
};

test('picks the address on the default route interface', () => {
  const binding = resolveLanBinding([], [], interfaces, 'wlan0');
  assert.deepEqual(binding.addresses, ['192.168.1.21']);
  assert.equal(binding.source, 'auto');
});

test('prefers physical interfaces over container bridges without a default route', () => {
  const binding = resolveLanBinding([], [], interfaces, '');
  assert.deepEqual(binding.addresses, ['192.168.1.20']);
});

test('explicit addresses win', () => {
  const binding = resolveLanBinding(['10.1.1.1'], [], interfaces, 'enp1s0');
  assert.deepEqual(binding.addresses, ['10.1.1.1']);
  assert.equal(binding.source, 'explicit-addresses');
});

test('explicit interfaces resolve to their addresses', () => {
  const binding = resolveLanBinding([], ['wlan0'], interfaces, 'enp1s0');
  assert.deepEqual(binding.addresses, ['192.168.1.21']);
  assert.deepEqual(binding.interfaces, ['wlan0']);
});

test('reports when no address is usable', () => {
  const binding = resolveLanBinding([], [], { lo: interfaces.lo }, '');
  assert.equal(binding.source, 'none');
  assert.deepEqual(binding.addresses, []);
});

test('reads the default route interface from the routing table', () => {
  const table = [
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
    'docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
    'enp1s0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0',
  ].join('\n');
  assert.equal(parseDefaultRouteInterface(table), 'enp1s0');
  assert.equal(parseDefaultRouteInterface('Iface\n'), '');
});
