import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from './logger.ts';
import { errorMessage } from './util.ts';

export interface DeviceState {
  /** DIAL port reserved for this device's virtual receiver. */
  port?: number;
  /** Last known name, so the UI can show devices that are currently offline. */
  name?: string;
  /** The user switched this device off in the web UI. */
  disabled?: boolean;
  /** Key/value data owned by the YouTube receiver library (pairing ids etc.). */
  store?: Record<string, unknown>;
}

interface StateFile {
  version: 2;
  devices: Record<string, DeviceState>;
}

const SAVE_DELAY_MS = 1000;

/** Small JSON state file with atomic, debounced writes. */
export class StateStore {
  readonly #file: string;
  readonly #logger: Logger;
  #state: StateFile = { version: 2, devices: {} };
  #timer: NodeJS.Timeout | null = null;
  #writing: Promise<void> = Promise.resolve();

  constructor(file: string, logger: Logger) {
    this.#file = file;
    this.#logger = logger;
  }

  async load(): Promise<void> {
    await mkdir(path.dirname(this.#file), { recursive: true });
    let raw: string;
    try {
      raw = await readFile(this.#file, 'utf8');
    } catch {
      return; // First start: nothing saved yet.
    }
    try {
      const parsed = JSON.parse(raw) as Partial<StateFile>;
      if (parsed.version !== 2 || typeof parsed.devices !== 'object' || parsed.devices === null) {
        throw new Error('unknown state format');
      }
      this.#state = { version: 2, devices: parsed.devices };
    } catch (err) {
      const backup = `${this.#file}.corrupt`;
      await rename(this.#file, backup).catch(() => undefined);
      this.#logger.warn(`State file was unreadable and has been moved to ${backup}; starting fresh`, errorMessage(err));
    }
  }

  get(id: string): DeviceState {
    return this.#state.devices[id] ?? {};
  }

  entries(): [string, DeviceState][] {
    return Object.entries(this.#state.devices);
  }

  update(id: string, patch: Partial<DeviceState>): void {
    this.#state.devices[id] = { ...this.#state.devices[id], ...patch };
    this.#scheduleSave();
  }

  getStoreValue(id: string, key: string): unknown {
    return this.#state.devices[id]?.store?.[key] ?? null;
  }

  setStoreValue(id: string, key: string, value: unknown): void {
    const device = this.#state.devices[id] ?? {};
    this.#state.devices[id] = { ...device, store: { ...device.store, [key]: value } };
    this.#scheduleSave();
  }

  /** Writes pending changes now; used on shutdown. */
  async flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
      this.#write();
    }
    await this.#writing;
  }

  #scheduleSave(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#write();
    }, SAVE_DELAY_MS);
    this.#timer.unref();
  }

  #write(): void {
    this.#writing = this.#writing.then(async () => {
      const tmp = `${this.#file}.tmp`;
      try {
        await writeFile(tmp, JSON.stringify(this.#state, null, 2), { mode: 0o600 });
        await rename(tmp, this.#file);
      } catch (err) {
        this.#logger.error('Could not save state file', errorMessage(err));
      }
    });
  }
}
