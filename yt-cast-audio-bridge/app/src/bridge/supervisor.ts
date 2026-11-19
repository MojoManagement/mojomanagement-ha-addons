import { isAudioOnly, type CastDevice } from '../cast/device.ts';
import type { CastDeviceRegistry, DeviceRecord } from '../cast/registry.ts';
import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import type { StateStore } from '../state.ts';
import { backoffDelay, errorMessage } from '../util.ts';
import type { ReceiverHandle, ReceiverSnapshot, ReceiverSpec } from './receiver.ts';

export type FilterConfig = Pick<Config, 'onlyAudioLike' | 'includeGroups' | 'includeRegex' | 'excludeRegex' | 'pinnedHosts'>;

export interface Verdict {
  expose: boolean;
  /** Plain-language explanation shown in the UI. */
  reason: string;
}

/** Decides whether a device should get a virtual receiver, and says why not. */
export function evaluateDevice(device: CastDevice, filters: FilterConfig, disabledByUser: boolean): Verdict {
  if (disabledByUser) return { expose: false, reason: 'Switched off here' };
  const identity = `${device.name} ${device.host}`;
  if (filters.pinnedHosts.length) {
    const pinned = filters.pinnedHosts.some((entry) => {
      const value = entry.toLowerCase();
      return value === device.host || value === device.id || value === device.name.toLowerCase();
    });
    if (!pinned) return { expose: false, reason: 'Not listed in pinned_hosts' };
  }
  if (device.isGroup && !filters.includeGroups) return { expose: false, reason: 'Speaker groups are turned off (include_groups)' };
  if (filters.onlyAudioLike && !isAudioOnly(device)) return { expose: false, reason: 'Has a screen (only_audio_like)' };
  if (filters.includeRegex && !filters.includeRegex.test(identity)) return { expose: false, reason: 'Does not match include_regex' };
  if (filters.excludeRegex && filters.excludeRegex.test(identity)) return { expose: false, reason: 'Matches exclude_regex' };
  return { expose: true, reason: '' };
}

/** Gives devices that share a name a distinguishing suffix so the Cast menu stays unambiguous. */
export function uniqueNames(devices: CastDevice[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const device of devices) counts.set(device.name, (counts.get(device.name) ?? 0) + 1);
  const names = new Map<string, string>();
  for (const device of devices) {
    const duplicate = (counts.get(device.name) ?? 0) > 1;
    names.set(device.id, duplicate ? `${device.name} (${device.host})` : device.name);
  }
  return names;
}

/** Picks the lowest free port at or above `base`. */
export function pickPort(base: number, taken: ReadonlySet<number>): number {
  let port = base;
  while (taken.has(port)) port += 1;
  if (port > 65535) throw new Error('No free port left for a receiver');
  return port;
}

interface Running {
  handle: ReceiverHandle;
  spec: ReceiverSpec;
}

interface Failure {
  count: number;
  retryAt: number;
  message: string;
}

export interface DeviceStatus {
  id: string;
  name: string;
  model: string;
  host: string;
  isGroup: boolean;
  online: boolean;
  lastSeen: number;
  enabled: boolean;
  /** 'active' = virtual receiver is running. */
  state: 'active' | 'hidden' | 'offline' | 'error' | 'starting';
  reason: string;
  receiver: ReceiverSnapshot | null;
}

export interface SupervisorOptions {
  registry: CastDeviceRegistry;
  state: StateStore;
  config: Config;
  bindAddresses: string[];
  bindInterfaces: string[];
  logger: Logger;
  createReceiver: (spec: ReceiverSpec) => ReceiverHandle;
  now?: () => number;
}

const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

/**
 * Keeps the set of running virtual receivers in line with the devices on the
 * network. One device failing never affects the others.
 */
export class BridgeSupervisor {
  readonly #options: SupervisorOptions;
  readonly #now: () => number;
  readonly #running = new Map<string, Running>();
  readonly #failures = new Map<string, Failure>();
  readonly #verdicts = new Map<string, Verdict>();
  /** Ports that turned out to be occupied by something else on this host. */
  readonly #blockedPorts = new Set<number>();
  #reconciling: Promise<void> | null = null;
  #rerun = false;
  #lastReconcileAt = 0;

  constructor(options: SupervisorOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  get lastReconcileAt(): number {
    return this.#lastReconcileAt;
  }

  get receiverCount(): number {
    return this.#running.size;
  }

  /** Brings running receivers in line with the current device list. Calls made while one runs are coalesced. */
  reconcile(): Promise<void> {
    if (this.#reconciling) {
      this.#rerun = true;
      return this.#reconciling;
    }
    this.#reconciling = (async () => {
      try {
        do {
          this.#rerun = false;
          await this.#reconcileOnce();
        } while (this.#rerun);
      } finally {
        this.#reconciling = null;
      }
    })();
    return this.#reconciling;
  }

  setEnabled(id: string, enabled: boolean): void {
    this.#options.state.update(id, { disabled: !enabled });
    this.#failures.delete(id);
  }

  async stopAll(): Promise<void> {
    if (this.#reconciling) await this.#reconciling.catch(() => undefined);
    await Promise.all([...this.#running.keys()].map((id) => this.#stop(id, 'bridge is shutting down')));
  }

  status(): DeviceStatus[] {
    return this.#options.registry.list().map((record) => {
      const { device } = record;
      const online = this.#options.registry.isOnline(device.id);
      const running = this.#running.get(device.id);
      const failure = this.#failures.get(device.id);
      const verdict = this.#verdicts.get(device.id) ?? { expose: false, reason: '' };
      let state: DeviceStatus['state'];
      let reason = verdict.reason;
      if (running) state = 'active';
      else if (!verdict.expose) state = 'hidden';
      else if (failure) {
        state = 'error';
        reason = failure.message;
      } else if (!online) state = 'offline';
      else state = 'starting';
      return {
        id: device.id,
        name: device.name,
        model: device.model,
        host: device.host,
        isGroup: device.isGroup,
        online,
        lastSeen: record.lastSeen,
        enabled: !this.#options.state.get(device.id).disabled,
        state,
        reason,
        receiver: running ? running.handle.snapshot() : null,
      };
    });
  }

  async #reconcileOnce(): Promise<void> {
    const { registry, config, state } = this.#options;
    const now = this.#now();
    registry.prune();
    const records = registry.list();

    // 1. Which devices should have a receiver?
    const wanted: DeviceRecord[] = [];
    this.#verdicts.clear();
    for (const record of records) {
      const verdict = evaluateDevice(record.device, config, Boolean(state.get(record.device.id).disabled));
      if (verdict.expose && wanted.length >= config.maxReceivers) {
        this.#verdicts.set(record.device.id, { expose: false, reason: `More than max_receivers (${config.maxReceivers}) devices` });
        continue;
      }
      this.#verdicts.set(record.device.id, verdict);
      if (verdict.expose) wanted.push(record);
    }
    const names = uniqueNames(wanted.map((record) => record.device));
    const wantedIds = new Set(wanted.map((record) => record.device.id));

    // 2. Stop receivers that are no longer wanted, renamed, or whose speaker is gone for good.
    for (const [id, running] of [...this.#running]) {
      const record = registry.get(id);
      const busy = running.handle.snapshot().senders > 0;
      if (!record || !wantedIds.has(id)) {
        await this.#stop(id, this.#verdicts.get(id)?.reason || 'device is no longer known');
        continue;
      }
      const expectedName = this.#displayName(names.get(id) ?? record.device.name);
      if (running.spec.displayName !== expectedName && !busy) {
        await this.#stop(id, 'speaker was renamed');
        continue;
      }
      const offlineFor = now - record.lastSeen;
      if (!registry.isOnline(id) && offlineFor > config.offlineHideAfterMs && !busy) {
        await this.#stop(id, 'speaker is offline');
      }
    }

    // 3. Start receivers for online devices that have none.
    for (const record of wanted) {
      const { device } = record;
      if (this.#running.has(device.id) || !registry.isOnline(device.id)) continue;
      const failure = this.#failures.get(device.id);
      if (failure && failure.retryAt > now) continue;
      await this.#start(device, this.#displayName(names.get(device.id) ?? device.name), names.get(device.id) ?? device.name);
    }
    this.#lastReconcileAt = this.#now();
  }

  #displayName(name: string): string {
    return `${this.#options.config.namePrefix} ${name}`.trim();
  }

  #allocatePort(deviceId: string): number {
    const { state, config } = this.#options;
    const taken = new Set<number>([config.healthPort, ...this.#blockedPorts]);
    for (const [id, entry] of state.entries()) {
      if (id !== deviceId && typeof entry.port === 'number') taken.add(entry.port);
    }
    for (const running of this.#running.values()) taken.add(running.spec.port);

    const saved = state.get(deviceId).port;
    if (typeof saved === 'number' && saved >= config.dialBasePort && saved <= 65535 && !taken.has(saved)) return saved;
    return pickPort(config.dialBasePort, taken);
  }

  async #start(device: CastDevice, displayName: string, plainName: string): Promise<void> {
    const { registry, state, config, logger } = this.#options;
    let port = 0;
    try {
      port = this.#allocatePort(device.id);
      state.update(device.id, { port, name: device.name });
      const spec: ReceiverSpec = {
        deviceId: device.id,
        displayName,
        screenName: `${config.screenPrefix} ${plainName}`.trim(),
        port,
        bindAddresses: this.#options.bindAddresses,
        bindInterfaces: this.#options.bindInterfaces,
        autoplay: config.autoplay,
        getEndpoint: () => {
          const current = registry.get(device.id)?.device;
          return current ? { host: current.host, port: current.port } : null;
        },
      };
      const handle = this.#options.createReceiver(spec);
      handle.onTerminated((reason) => {
        logger.warn(`Receiver for ${device.name} stopped unexpectedly; it will be restarted`, reason);
        this.#running.delete(device.id);
        void handle.stop().catch(() => undefined);
        this.#recordFailure(device.id, reason);
        void this.reconcile();
      });
      await handle.start();
      this.#running.set(device.id, { handle, spec });
      this.#failures.delete(device.id);
      logger.info(`"${displayName}" is now available in the YouTube app (port ${port})`);
    } catch (err) {
      const message = errorMessage(err);
      if (port && /EADDRINUSE|Failed to start DIAL server/i.test(`${message} ${errorMessage((err as { cause?: unknown })?.cause ?? '')}`)) {
        // Something else owns this port; never try it again during this run.
        this.#blockedPorts.add(port);
        state.update(device.id, { port: undefined });
      }
      const failure = this.#recordFailure(device.id, message);
      logger.error(`Could not start receiver for ${device.name}; retrying in ${Math.round((failure.retryAt - this.#now()) / 1000)} s`, message);
    }
  }

  #recordFailure(id: string, message: string): Failure {
    const count = (this.#failures.get(id)?.count ?? 0) + 1;
    const failure = { count, retryAt: this.#now() + backoffDelay(count, RETRY_BASE_MS, RETRY_MAX_MS), message };
    this.#failures.set(id, failure);
    return failure;
  }

  async #stop(id: string, why: string): Promise<void> {
    const running = this.#running.get(id);
    if (!running) return;
    this.#running.delete(id);
    try {
      await running.handle.stop();
    } catch (err) {
      this.#options.logger.warn(`Receiver "${running.spec.displayName}" did not stop cleanly`, errorMessage(err));
    }
    this.#options.logger.info(`"${running.spec.displayName}" removed from the YouTube app (${why})`);
  }
}
