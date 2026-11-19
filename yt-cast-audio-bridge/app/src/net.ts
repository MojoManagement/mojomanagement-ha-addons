import { readFileSync } from 'node:fs';
import os from 'node:os';

export interface InterfaceAddress {
  iface: string;
  address: string;
}

export interface LanBinding {
  /** Addresses the DIAL servers and mDNS discovery bind to. Empty means "all". */
  addresses: string[];
  /** Interfaces passed through to the DIAL server when the user named them explicitly. */
  interfaces: string[];
  /** How the binding was chosen, for display in logs and the UI. */
  source: 'explicit-addresses' | 'explicit-interfaces' | 'auto' | 'none';
  candidates: InterfaceAddress[];
}

const VIRTUAL_IFACE = /^(docker|br-|veth|cni|flannel|kube|virbr|tailscale|wg|zt|tun|tap|hassio)/;
const PHYSICAL_IFACE = /^(eth|en|wlan|wl|lan|bond)/;

function isPrivate(address: string): boolean {
  return address.startsWith('10.') || address.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(address);
}

function ifacePenalty(iface: string): number {
  const name = iface.toLowerCase();
  if (PHYSICAL_IFACE.test(name)) return 0;
  if (VIRTUAL_IFACE.test(name)) return 3;
  return 1;
}

/** Lists usable non-loopback IPv4 addresses, best LAN candidate first. */
export function rankLanCandidates(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
  defaultRouteIface: string,
): InterfaceAddress[] {
  const candidates: InterfaceAddress[] = [];
  for (const [iface, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4') continue;
      if (entry.address.startsWith('127.') || entry.address.startsWith('169.254.')) continue;
      candidates.push({ iface, address: entry.address });
    }
  }
  const score = (c: InterfaceAddress): number =>
    (c.iface === defaultRouteIface ? 0 : 100) + (isPrivate(c.address) ? 0 : 10) + ifacePenalty(c.iface);
  return candidates.sort(
    (a, b) => score(a) - score(b) || a.iface.localeCompare(b.iface) || a.address.localeCompare(b.address),
  );
}

/** Parses the Linux routing table (`/proc/net/route`) and returns the default route's interface. */
export function parseDefaultRouteInterface(routeTable: string): string {
  for (const line of routeTable.split(/\r?\n/).slice(1)) {
    const [iface = '', destination = '', , flagsHex = '0'] = line.trim().split(/\s+/);
    const isGateway = (Number.parseInt(flagsHex, 16) & 0x2) === 0x2;
    if (iface && destination === '00000000' && isGateway) return iface;
  }
  return '';
}

function readDefaultRouteInterface(): string {
  try {
    return parseDefaultRouteInterface(readFileSync('/proc/net/route', 'utf8'));
  } catch {
    return '';
  }
}

/**
 * Decides where the bridge listens. Explicit user settings win; otherwise the
 * address on the default-route interface is used so that container bridges such
 * as `docker0` are never picked by accident.
 */
export function resolveLanBinding(
  explicitAddresses: string[],
  explicitInterfaces: string[],
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
  defaultRouteIface: string = readDefaultRouteInterface(),
): LanBinding {
  const candidates = rankLanCandidates(interfaces, defaultRouteIface);
  if (explicitAddresses.length) {
    return { addresses: explicitAddresses, interfaces: explicitInterfaces, source: 'explicit-addresses', candidates };
  }
  if (explicitInterfaces.length) {
    const addresses = candidates.filter((c) => explicitInterfaces.includes(c.iface)).map((c) => c.address);
    return { addresses, interfaces: explicitInterfaces, source: 'explicit-interfaces', candidates };
  }
  const first = candidates[0];
  if (!first) return { addresses: [], interfaces: [], source: 'none', candidates };
  return { addresses: [first.address], interfaces: [], source: 'auto', candidates };
}
