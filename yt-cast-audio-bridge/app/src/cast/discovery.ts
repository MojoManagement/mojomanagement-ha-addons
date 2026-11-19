import { EventEmitter } from 'node:events';
import createMdns, { type MdnsInstance, type MdnsPacket, type MdnsRecord } from 'multicast-dns';
import type { Logger } from '../logger.ts';
import { errorMessage } from '../util.ts';
import { isGroupDevice, type CastDevice } from './device.ts';

export const CAST_SERVICE = '_googlecast._tcp.local';

interface ServiceInstance {
  target?: string;
  port?: number;
  txt?: Map<string, string>;
}

export interface IngestResult {
  devices: CastDevice[];
  /** Ids of devices that announced they are leaving the network. */
  goodbyes: string[];
  /** Record names still missing before a device can be assembled. */
  missing: { name: string; type: 'SRV' | 'TXT' | 'A' }[];
}

function parseTxt(data: unknown): Map<string, string> {
  const txt = new Map<string, string>();
  const chunks = Array.isArray(data) ? data : [data];
  for (const chunk of chunks) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : typeof chunk === 'string' ? chunk : '';
    const split = text.indexOf('=');
    if (split > 0) txt.set(text.slice(0, split).toLowerCase(), text.slice(split + 1));
  }
  return txt;
}

/**
 * Assembles Cast devices from mDNS records. Records for one device may arrive
 * spread over several packets, so partial knowledge is kept between calls.
 */
export class CastRecordCache {
  readonly #instances = new Map<string, ServiceInstance>();
  readonly #addresses = new Map<string, string>();
  readonly #idsByInstance = new Map<string, string>();

  ingest(packet: MdnsPacket): IngestResult {
    const touched = new Set<string>();
    const goodbyes: string[] = [];
    const records: MdnsRecord[] = [...(packet.answers ?? []), ...(packet.additionals ?? [])];

    for (const record of records) {
      const name = record.name.toLowerCase();
      if (record.type === 'PTR' && name === CAST_SERVICE && typeof record.data === 'string') {
        const instance = record.data.toLowerCase();
        if (record.ttl === 0) {
          const id = this.#idsByInstance.get(instance);
          if (id) goodbyes.push(id);
          this.#instances.delete(instance);
          this.#idsByInstance.delete(instance);
        } else {
          if (!this.#instances.has(instance)) this.#instances.set(instance, {});
          touched.add(instance);
        }
      } else if (record.type === 'SRV' && name.endsWith(CAST_SERVICE)) {
        const data = record.data as { target?: unknown; port?: unknown } | undefined;
        if (typeof data?.target === 'string' && typeof data.port === 'number') {
          const instance = this.#instances.get(name) ?? {};
          instance.target = data.target.toLowerCase();
          instance.port = data.port;
          this.#instances.set(name, instance);
          touched.add(name);
        }
      } else if (record.type === 'TXT' && name.endsWith(CAST_SERVICE)) {
        const instance = this.#instances.get(name) ?? {};
        instance.txt = parseTxt(record.data);
        this.#instances.set(name, instance);
        touched.add(name);
      } else if (record.type === 'A' && typeof record.data === 'string') {
        this.#addresses.set(name, record.data);
        for (const [instanceName, instance] of this.#instances) {
          if (instance.target === name) touched.add(instanceName);
        }
      }
    }

    const devices: CastDevice[] = [];
    const missing: IngestResult['missing'] = [];
    for (const instanceName of touched) {
      const instance = this.#instances.get(instanceName);
      if (!instance) continue;
      if (!instance.target || instance.port === undefined) {
        missing.push({ name: instanceName, type: 'SRV' });
        continue;
      }
      if (!instance.txt) {
        missing.push({ name: instanceName, type: 'TXT' });
        continue;
      }
      const host = this.#addresses.get(instance.target);
      if (!host) {
        missing.push({ name: instance.target, type: 'A' });
        continue;
      }
      const capabilitiesText = instance.txt.get('ca');
      const capabilities = capabilitiesText && /^\d+$/.test(capabilitiesText) ? Number(capabilitiesText) : null;
      const model = instance.txt.get('md') ?? '';
      const id = (instance.txt.get('id') ?? instanceName.split('.')[0] ?? instanceName).replace(/-/g, '').toLowerCase();
      this.#idsByInstance.set(instanceName, id);
      devices.push({
        id,
        name: instance.txt.get('fn')?.trim() || model || host,
        model,
        host,
        port: instance.port,
        capabilities,
        isGroup: isGroupDevice(model, capabilities),
      });
    }
    return { devices, goodbyes, missing };
  }
}

export interface CastDiscoveryOptions {
  /** Local addresses to run discovery on. Empty means the system default interface. */
  addresses: string[];
  intervalMs?: number;
  logger: Logger;
  mdnsFactory?: (options: { interface?: string }) => MdnsInstance;
}

/** Events: `device` (CastDevice) whenever a device is seen, `gone` (id) on goodbye. */
export class CastDiscovery extends EventEmitter {
  readonly #options: CastDiscoveryOptions;
  readonly #cache = new CastRecordCache();
  #sockets: MdnsInstance[] = [];
  #timers: NodeJS.Timeout[] = [];
  #lastResponseAt = 0;

  constructor(options: CastDiscoveryOptions) {
    super();
    this.#options = options;
  }

  get lastResponseAt(): number {
    return this.#lastResponseAt;
  }

  start(): void {
    // Bind to the wildcard address: a socket bound to a unicast address receives no
    // multicast on Linux. `interface` alone selects where group traffic is sent and joined.
    const factory = this.#options.mdnsFactory ?? ((options) => createMdns({ ...options, bind: '0.0.0.0', reuseAddr: true }));
    const targets = this.#options.addresses.length ? this.#options.addresses : [undefined];
    for (const address of targets) {
      try {
        const socket = factory(address ? { interface: address } : {});
        socket.on('response', (packet: MdnsPacket) => this.#onResponse(socket, packet));
        socket.on('error', (err: unknown) => this.#options.logger.warn('mDNS socket error', errorMessage(err)));
        this.#sockets.push(socket);
      } catch (err) {
        this.#options.logger.warn(`Could not start mDNS discovery on ${address ?? 'default interface'}`, errorMessage(err));
      }
    }
    // A few quick queries at startup so devices show up fast, then a steady refresh.
    this.query();
    for (const delay of [1000, 3000]) this.#timers.push(setTimeout(() => this.query(), delay).unref());
    this.#timers.push(setInterval(() => this.query(), this.#options.intervalMs ?? 20_000).unref());
  }

  query(): void {
    for (const socket of this.#sockets) this.#send(socket, [{ name: CAST_SERVICE, type: 'PTR' }]);
  }

  stop(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers = [];
    for (const socket of this.#sockets) {
      try {
        socket.destroy();
      } catch {
        // Socket was already closed.
      }
    }
    this.#sockets = [];
  }

  #send(socket: MdnsInstance, questions: { name: string; type: string }[]): void {
    try {
      socket.query(questions, (err) => {
        if (err) this.#options.logger.debug('mDNS query failed', errorMessage(err));
      });
    } catch (err) {
      this.#options.logger.debug('mDNS query failed', errorMessage(err));
    }
  }

  #onResponse(socket: MdnsInstance, packet: MdnsPacket): void {
    let result: IngestResult;
    try {
      result = this.#cache.ingest(packet);
    } catch (err) {
      this.#options.logger.debug('Ignoring malformed mDNS packet', errorMessage(err));
      return;
    }
    if (result.devices.length) this.#lastResponseAt = Date.now();
    for (const device of result.devices) this.emit('device', device);
    for (const id of result.goodbyes) this.emit('gone', id);
    if (result.missing.length) this.#send(socket, result.missing);
  }
}
