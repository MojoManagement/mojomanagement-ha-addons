import { EventEmitter } from 'node:events';
import type { CastDevice } from './device.ts';

export interface DeviceRecord {
  device: CastDevice;
  firstSeen: number;
  lastSeen: number;
  /** The device said goodbye and has not been seen since. */
  gone: boolean;
}

/**
 * Remembers every Cast device seen on the network, keyed by its stable id.
 * Emits `change` when a device appears, disappears or changes name/address.
 */
export class CastDeviceRegistry extends EventEmitter {
  readonly #records = new Map<string, DeviceRecord>();
  readonly #onlineWindowMs: number;
  readonly #forgetAfterMs: number;
  readonly #now: () => number;

  constructor(options: { onlineWindowMs: number; forgetAfterMs: number; now?: () => number }) {
    super();
    this.#onlineWindowMs = options.onlineWindowMs;
    this.#forgetAfterMs = options.forgetAfterMs;
    this.#now = options.now ?? Date.now;
  }

  upsert(device: CastDevice): void {
    const now = this.#now();
    const existing = this.#records.get(device.id);
    const changed =
      !existing ||
      existing.gone ||
      !this.#isFresh(existing, now) ||
      existing.device.name !== device.name ||
      existing.device.host !== device.host ||
      existing.device.port !== device.port;
    this.#records.set(device.id, { device, firstSeen: existing?.firstSeen ?? now, lastSeen: now, gone: false });
    if (changed) this.emit('change');
  }

  markGone(id: string): void {
    const record = this.#records.get(id);
    if (!record || record.gone) return;
    record.gone = true;
    this.emit('change');
  }

  get(id: string): DeviceRecord | null {
    return this.#records.get(id) ?? null;
  }

  isOnline(id: string): boolean {
    const record = this.#records.get(id);
    return Boolean(record && !record.gone && this.#isFresh(record, this.#now()));
  }

  /** All known devices, most stable order first (by first appearance, then name). */
  list(): DeviceRecord[] {
    return [...this.#records.values()].sort(
      (a, b) => a.firstSeen - b.firstSeen || a.device.name.localeCompare(b.device.name) || a.device.id.localeCompare(b.device.id),
    );
  }

  /** Drops devices that have been away for a long time. */
  prune(): void {
    const now = this.#now();
    for (const [id, record] of this.#records) {
      if (now - record.lastSeen > this.#forgetAfterMs) this.#records.delete(id);
    }
  }

  #isFresh(record: DeviceRecord, now: number): boolean {
    return now - record.lastSeen <= this.#onlineWindowMs;
  }
}
