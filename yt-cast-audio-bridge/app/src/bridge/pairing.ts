import type { EventEmitter } from 'node:events';
import type { Logger } from '../logger.ts';
import { errorMessage } from '../util.ts';

/** The part of the receiver library's pairing service that is used here. */
export interface PairingService extends EventEmitter {
  start(): void;
  stop(): void;
}

export interface PairingCode {
  /** Twelve digits, as entered under "Link with TV code" in the YouTube app. */
  code: string;
  /** Epoch ms until which fresh codes are shown; request again afterwards. */
  validUntil: number;
}

/**
 * Shows a "TV code" for a limited time. With such a code a phone can link to a
 * speaker through YouTube's servers, which also works when the phone cannot
 * discover the bridge on the network (other VLAN, no SSDP forwarding).
 *
 * The library refreshes the code every few minutes while its service runs, so the
 * service is only kept running for a short window after somebody asked for a code.
 */
export class PairingWindow {
  readonly #service: PairingService;
  readonly #log: Logger;
  readonly #windowMs: number;
  readonly #firstCodeTimeoutMs: number;
  #code = '';
  #validUntil = 0;
  #timer: NodeJS.Timeout | null = null;
  #waiters: { resolve: (code: PairingCode) => void; reject: (err: Error) => void }[] = [];

  constructor(service: PairingService, logger: Logger, options: { windowMs?: number; firstCodeTimeoutMs?: number } = {}) {
    this.#service = service;
    this.#log = logger;
    this.#windowMs = options.windowMs ?? 10 * 60_000;
    this.#firstCodeTimeoutMs = options.firstCodeTimeoutMs ?? 15_000;

    service.on('response', (code: string) => {
      this.#code = String(code);
      for (const waiter of this.#waiters.splice(0)) waiter.resolve({ code: this.#code, validUntil: this.#validUntil });
    });
    service.on('error', (err: unknown) => {
      // The library stops its service on error.
      this.#log.warn('Could not get a TV code from YouTube', errorMessage(err));
      this.#close(new Error(`YouTube did not provide a TV code: ${errorMessage(err)}`));
    });
  }

  /** The code currently on offer, or null when no pairing window is open. */
  get current(): PairingCode | null {
    return this.#code && this.#timer ? { code: this.#code, validUntil: this.#validUntil } : null;
  }

  /** Opens (or extends) the pairing window and resolves with a code. */
  request(): Promise<PairingCode> {
    this.#validUntil = Date.now() + this.#windowMs;
    const running = this.#timer !== null;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#close(new Error('The pairing window closed')), this.#windowMs);
    this.#timer.unref();

    if (running && this.#code) return Promise.resolve({ code: this.#code, validUntil: this.#validUntil });
    const pending = new Promise<PairingCode>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#waiters = this.#waiters.filter((waiter) => waiter.resolve !== onResolve);
        reject(new Error('YouTube did not answer in time; try again'));
      }, this.#firstCodeTimeoutMs);
      const onResolve = (code: PairingCode): void => {
        clearTimeout(timeout);
        resolve(code);
      };
      this.#waiters.push({
        resolve: onResolve,
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });
    });
    if (!running) {
      try {
        this.#service.start();
      } catch (err) {
        this.#close(new Error(errorMessage(err)));
      }
    }
    return pending;
  }

  /** Stops showing codes. Phones that are already linked stay linked. */
  stop(): void {
    this.#close(new Error('The receiver was stopped'));
  }

  #close(reason: Error): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#code = '';
    for (const waiter of this.#waiters.splice(0)) waiter.reject(reason);
    try {
      this.#service.stop();
    } catch {
      // Already stopped.
    }
  }
}
