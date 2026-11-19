import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Client, DefaultMediaReceiver } from 'castv2-client';
import type { Logger } from '../logger.ts';
import { backoffDelay, callWithTimeout, clamp, errorMessage, SerialQueue, sleep, withTimeout } from '../util.ts';

type Callback<T> = (err: unknown, result?: T) => void;

export interface CastVolume {
  level?: number;
  muted?: boolean;
}

export interface CastSessionInfo {
  appId: string;
  sessionId: string;
}

export interface ReceiverStatus {
  applications?: CastSessionInfo[];
  volume?: CastVolume;
}

export interface MediaStatus {
  mediaSessionId: number;
  playerState: 'IDLE' | 'PLAYING' | 'PAUSED' | 'BUFFERING';
  idleReason?: string;
  currentTime?: number;
  playbackRate?: number;
}

/** The part of a castv2 media receiver app the bridge uses. */
export interface MediaAppLike extends EventEmitter {
  session: CastSessionInfo;
  load(media: object, options: object, callback: Callback<MediaStatus>): void;
  play(callback: Callback<MediaStatus>): void;
  pause(callback: Callback<MediaStatus>): void;
  stop(callback: Callback<MediaStatus>): void;
  seek(seconds: number, callback: Callback<MediaStatus>): void;
  getStatus(callback: Callback<MediaStatus | undefined>): void;
}

/** The part of a castv2 platform client the bridge uses. */
export interface CastClientLike extends EventEmitter {
  connect(options: { host: string; port: number }, callback: () => void): void;
  close(): void;
  getStatus(callback: Callback<ReceiverStatus>): void;
  getSessions(callback: Callback<CastSessionInfo[]>): void;
  launch(app: unknown, callback: Callback<MediaAppLike>): void;
  join(session: CastSessionInfo, app: unknown, callback: Callback<MediaAppLike>): void;
  stop(app: MediaAppLike, callback: Callback<unknown>): void;
  setVolume(volume: CastVolume, callback: Callback<CastVolume>): void;
}

export interface LoadRequest {
  url: string;
  contentType: string;
  title: string;
  artist?: string;
  imageUrl?: string;
  live: boolean;
  startTime: number;
}

export interface LinkVolume {
  /** 0..1 */
  level: number;
  muted: boolean;
}

export interface StoppedEvent {
  reason: string;
  /** Playback position (seconds) when playback ended. */
  position: number;
}

export interface CastLinkOptions {
  /** Current network endpoint of the device, or null while it is offline. */
  getEndpoint: () => { host: string; port: number } | null;
  logger: Logger;
  createClient?: () => CastClientLike;
  /** Quit the receiver app and disconnect after this long without playback. */
  idleReleaseMs?: number;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  loadTimeoutMs?: number;
  recoverBaseDelayMs?: number;
  recoverAttempts?: number;
}

export class NoSessionError extends Error {
  constructor() {
    super('No media session on the Cast device');
    this.name = 'NoSessionError';
  }
}

const require = createRequire(import.meta.url);
let protocolReady: Promise<void> | null = null;

/**
 * The castv2 library loads its protocol definition asynchronously on import and
 * throws from a socket callback when used before that finished. Wait for it once.
 */
function waitForCastProtocol(): Promise<void> {
  protocolReady ??= (async () => {
    let proto: { CastMessage: { parse(data: Buffer): unknown } };
    try {
      proto = require('castv2/lib/proto.js') as typeof proto;
    } catch {
      return;
    }
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        proto.CastMessage.parse(Buffer.alloc(0));
        return;
      } catch (err) {
        if (!/not loaded/i.test(errorMessage(err))) return;
        await sleep(10);
      }
    }
  })();
  return protocolReady;
}

const MEDIA_APP: unknown = DefaultMediaReceiver;
const MEDIA_APP_ID = 'CC1AD845';

function safeClose(client: CastClientLike): void {
  try {
    client.close();
  } catch {
    // Never connected or already closed.
  }
}

/**
 * Owns the connection to one Cast device. All commands run one at a time and
 * every network step has a timeout, so a dead device can never stall the bridge.
 *
 * Events:
 * - `finished`: the current media played to its end.
 * - `stopped` (StoppedEvent): playback ended for any other reason.
 * - `playerState` ('PLAYING' | 'PAUSED'): the device changed state on its own.
 * - `volume` (LinkVolume): the device volume changed.
 */
export class CastLink extends EventEmitter {
  readonly #options: Required<Omit<CastLinkOptions, 'createClient'>> & { createClient: () => CastClientLike };
  readonly #queue = new SerialQueue();
  #client: CastClientLike | null = null;
  #app: MediaAppLike | null = null;
  /** Media session started by us; null when nothing of ours is playing. */
  #mediaSessionId: number | null = null;
  #loading = false;
  #media: { state: MediaStatus['playerState']; time: number; at: number; rate: number } | null = null;
  #volume: LinkVolume | null = null;
  #idleTimer: NodeJS.Timeout | null = null;
  #recoverTimer: NodeJS.Timeout | null = null;
  #closed = false;

  constructor(options: CastLinkOptions) {
    super();
    this.#options = {
      idleReleaseMs: 120_000,
      connectTimeoutMs: 6_000,
      requestTimeoutMs: 8_000,
      loadTimeoutMs: 20_000,
      recoverBaseDelayMs: 2_000,
      recoverAttempts: 5,
      createClient: () => new Client() as unknown as CastClientLike,
      ...options,
    };
  }

  get volume(): LinkVolume | null {
    return this.#volume;
  }

  get connected(): boolean {
    return this.#client !== null;
  }

  /** Current playback position in seconds, extrapolated from the last device report. */
  getPosition(): number {
    const media = this.#media;
    if (!media) return 0;
    if (media.state !== 'PLAYING') return media.time;
    return media.time + ((Date.now() - media.at) / 1000) * media.rate;
  }

  load(request: LoadRequest): Promise<void> {
    return this.#queue.run(async () => {
      this.#cancelTimers();
      this.#loading = true;
      this.#mediaSessionId = null;
      this.#media = null;
      try {
        const status = await this.#withReconnect(async () => {
          const app = await this.#ensureApp(true);
          const loaded = await callWithTimeout<MediaStatus>(
            (cb) => app.load(buildMedia(request), { autoplay: true, currentTime: request.startTime }, cb),
            this.#options.loadTimeoutMs,
            'Cast load',
          );
          // The client library only learns the media session from a status request or a
          // later broadcast. Ask now, so that pause/stop work immediately after a load.
          await this.#syncMediaStatus(app).catch(() => undefined);
          return loaded;
        });
        this.#mediaSessionId = status.mediaSessionId;
        this.#recordMedia(status);
      } catch (err) {
        this.#scheduleIdleRelease();
        throw err;
      } finally {
        this.#loading = false;
      }
    });
  }

  pause(): Promise<void> {
    return this.#mediaCommand('Cast pause', (app, cb) => app.pause(cb));
  }

  resume(): Promise<void> {
    return this.#mediaCommand('Cast resume', (app, cb) => app.play(cb));
  }

  seek(seconds: number): Promise<void> {
    return this.#mediaCommand('Cast seek', (app, cb) => app.seek(Math.max(0, seconds), cb));
  }

  /** Stops our media. Never rejects: a device that cannot be reached has nothing left to stop. */
  stop(): Promise<void> {
    return this.#queue.run(async () => {
      const hadMedia = this.#mediaSessionId !== null;
      this.#mediaSessionId = null;
      this.#media = null;
      this.#cancelTimers();
      if (hadMedia && this.#app) {
        const app = this.#app;
        try {
          await callWithTimeout<MediaStatus>((cb) => app.stop(cb), this.#options.requestTimeoutMs, 'Cast stop');
        } catch (err) {
          this.#options.logger.debug('Stop was not confirmed by the device', errorMessage(err));
        }
      }
      this.#scheduleIdleRelease();
    });
  }

  setVolume(level: number): Promise<void> {
    return this.#volumeCommand({ level: clamp(level, 0, 1) });
  }

  setMuted(muted: boolean): Promise<void> {
    return this.#volumeCommand({ muted });
  }

  /** Connects briefly (if needed) to learn the device's current volume. */
  refreshVolume(): Promise<void> {
    return this.#queue.run(async () => {
      await this.#ensureConnected();
      if (this.#mediaSessionId === null) this.#scheduleIdleRelease();
    });
  }

  /** Stops playback, quits the receiver app if it is ours and disconnects. */
  close(): Promise<void> {
    this.#closed = true;
    return this.#queue.run(async () => {
      this.#cancelTimers();
      await this.#release(this.#mediaSessionId !== null);
      this.removeAllListeners();
    });
  }

  // --- connection management -------------------------------------------------

  async #ensureConnected(): Promise<CastClientLike> {
    if (this.#client) return this.#client;
    const endpoint = this.#options.getEndpoint();
    if (!endpoint) throw new Error('Cast device is offline');

    await waitForCastProtocol();
    const client = this.#options.createClient();
    client.on('error', (err: unknown) => this.#onConnectionLost(client, err));
    client.on('status', (status: ReceiverStatus) => this.#onReceiverStatus(client, status));
    try {
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          client.once('error', reject);
          client.connect(endpoint, resolve);
        }),
        this.#options.connectTimeoutMs,
        `Connecting to ${endpoint.host}:${endpoint.port}`,
      );
    } catch (err) {
      safeClose(client);
      throw err;
    }
    this.#client = client;
    this.#options.logger.debug(`Connected to ${endpoint.host}:${endpoint.port}`);
    try {
      const status = await callWithTimeout<ReceiverStatus>((cb) => client.getStatus(cb), this.#options.requestTimeoutMs, 'Cast status');
      this.#onReceiverStatus(client, status);
    } catch (err) {
      this.#options.logger.debug('Could not read receiver status', errorMessage(err));
    }
    return client;
  }

  async #ensureApp(launch: boolean): Promise<MediaAppLike> {
    if (this.#app) return this.#app;
    const client = await this.#ensureConnected();
    const timeout = this.#options.requestTimeoutMs;
    const sessions = await callWithTimeout<CastSessionInfo[]>((cb) => client.getSessions(cb), timeout, 'Cast sessions');
    const existing = (sessions ?? []).find((session) => session.appId === MEDIA_APP_ID);

    let app: MediaAppLike;
    if (existing) {
      app = await callWithTimeout<MediaAppLike>((cb) => client.join(existing, MEDIA_APP, cb), timeout, 'Cast join');
    } else if (launch) {
      app = await callWithTimeout<MediaAppLike>((cb) => client.launch(MEDIA_APP, cb), this.#options.loadTimeoutMs, 'Cast launch');
    } else {
      throw new NoSessionError();
    }
    app.on('status', (status: MediaStatus) => this.#onMediaStatus(app, status));
    app.on('close', () => {
      if (this.#app === app) this.#app = null;
    });
    this.#app = app;
    return app;
  }

  /** Runs `action`; if it fails on a connection that was already open, reconnects and retries once. */
  async #withReconnect<T>(action: () => Promise<T>): Promise<T> {
    const reused = this.#client !== null;
    try {
      return await action();
    } catch (err) {
      if (err instanceof NoSessionError) throw err;
      const client = this.#client;
      const retry = reused && !/Load (failed|cancelled)/i.test(errorMessage(err));
      if (client) this.#dropConnection(client);
      if (!retry) throw err;
      this.#options.logger.debug('Command failed on existing connection, retrying on a fresh one', errorMessage(err));
      return action();
    }
  }

  #mediaCommand(what: string, invoke: (app: MediaAppLike, cb: Callback<MediaStatus>) => void): Promise<void> {
    return this.#queue.run(async () => {
      const status = await this.#withReconnect(async () => {
        const joined = this.#app === null;
        const app = await this.#ensureApp(false);
        if (joined) await this.#syncMediaStatus(app);
        return callWithTimeout<MediaStatus>((cb) => invoke(app, cb), this.#options.requestTimeoutMs, what);
      });
      if (status && status.mediaSessionId === this.#mediaSessionId) this.#recordMedia(status);
    });
  }

  #volumeCommand(volume: CastVolume): Promise<void> {
    return this.#queue.run(async () => {
      await this.#withReconnect(async () => {
        const client = await this.#ensureConnected();
        const applied = await callWithTimeout<CastVolume>((cb) => client.setVolume(volume, cb), this.#options.requestTimeoutMs, 'Cast volume');
        this.#updateVolume(applied ?? volume, false);
      });
      if (this.#mediaSessionId === null) this.#scheduleIdleRelease();
    });
  }

  /** After (re)joining a session the media controller must learn the current media session. */
  async #syncMediaStatus(app: MediaAppLike): Promise<MediaStatus | undefined> {
    return callWithTimeout<MediaStatus | undefined>((cb) => app.getStatus(cb), this.#options.requestTimeoutMs, 'Cast media status');
  }

  #dropConnection(client: CastClientLike): void {
    safeClose(client);
    if (this.#client !== client) return;
    this.#client = null;
    this.#app = null;
  }

  #onConnectionLost(client: CastClientLike, err: unknown): void {
    const wasCurrent = this.#client === client;
    this.#dropConnection(client);
    if (!wasCurrent || this.#closed) return;
    this.#options.logger.debug('Connection to Cast device lost', errorMessage(err));
    if (this.#mediaSessionId !== null && !this.#loading) this.#scheduleRecover(1);
  }

  /** The speaker usually keeps playing through a short network drop; find out whether it still does. */
  #scheduleRecover(attempt: number): void {
    if (this.#recoverTimer) clearTimeout(this.#recoverTimer);
    const delay = backoffDelay(attempt, this.#options.recoverBaseDelayMs, 30_000);
    this.#recoverTimer = setTimeout(() => {
      this.#recoverTimer = null;
      void this.#queue.run(async () => {
        const expected = this.#mediaSessionId;
        if (expected === null || this.#closed) return;
        try {
          const app = await this.#ensureApp(false);
          const status = await this.#syncMediaStatus(app);
          if (this.#mediaSessionId !== expected) return;
          if (!status || status.mediaSessionId !== expected) {
            this.#endPlayback('session-lost');
            return;
          }
          this.#options.logger.info('Reconnected to Cast device, playback continues');
          this.#onMediaStatus(app, status);
        } catch (err) {
          if (this.#mediaSessionId !== expected) return;
          if (err instanceof NoSessionError) {
            this.#endPlayback('session-lost');
          } else if (attempt >= this.#options.recoverAttempts) {
            this.#options.logger.warn('Giving up reconnecting to Cast device', errorMessage(err));
            this.#endPlayback('connection-lost');
          } else {
            this.#scheduleRecover(attempt + 1);
          }
        }
      });
    }, delay);
    this.#recoverTimer.unref();
  }

  // --- device events ---------------------------------------------------------

  #onMediaStatus(app: MediaAppLike, status: MediaStatus): void {
    if (app !== this.#app || this.#loading) return;
    if (this.#mediaSessionId === null || status.mediaSessionId !== this.#mediaSessionId) return;

    if (status.playerState === 'IDLE') {
      if (status.idleReason === 'FINISHED') {
        this.#mediaSessionId = null;
        this.#media = null;
        this.#scheduleIdleRelease();
        this.emit('finished');
      } else {
        this.#endPlayback((status.idleReason ?? 'idle').toLowerCase());
      }
      return;
    }
    const previous = this.#media?.state;
    this.#recordMedia(status);
    if (status.playerState !== 'BUFFERING' && status.playerState !== previous) {
      this.emit('playerState', status.playerState);
    }
  }

  #onReceiverStatus(client: CastClientLike, status: ReceiverStatus | undefined): void {
    if (!status || (this.#client !== null && client !== this.#client)) return;
    if (status.volume) this.#updateVolume(status.volume, true);
    const app = this.#app;
    if (app && Array.isArray(status.applications) && !status.applications.some((a) => a.sessionId === app.session?.sessionId)) {
      // Another app (or the user) took over the speaker.
      this.#app = null;
      if (this.#mediaSessionId !== null && !this.#loading) this.#endPlayback('app-closed');
    }
  }

  #endPlayback(reason: string): void {
    const event: StoppedEvent = { reason, position: this.getPosition() };
    this.#mediaSessionId = null;
    this.#media = null;
    this.#scheduleIdleRelease();
    this.emit('stopped', event);
  }

  #recordMedia(status: MediaStatus): void {
    this.#media = {
      state: status.playerState,
      time: Number.isFinite(status.currentTime) ? Number(status.currentTime) : (this.#media?.time ?? 0),
      at: Date.now(),
      rate: Number.isFinite(status.playbackRate) ? Number(status.playbackRate) : 1,
    };
  }

  #updateVolume(volume: CastVolume, notify: boolean): void {
    const next: LinkVolume = {
      level: typeof volume.level === 'number' ? clamp(volume.level, 0, 1) : (this.#volume?.level ?? 0.5),
      muted: typeof volume.muted === 'boolean' ? volume.muted : (this.#volume?.muted ?? false),
    };
    const previous = this.#volume;
    this.#volume = next;
    const changed = !previous || Math.abs(previous.level - next.level) >= 0.005 || previous.muted !== next.muted;
    if (changed && notify) this.emit('volume', next);
  }

  // --- idle handling ---------------------------------------------------------

  #cancelTimers(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    if (this.#recoverTimer) clearTimeout(this.#recoverTimer);
    this.#idleTimer = null;
    this.#recoverTimer = null;
  }

  #scheduleIdleRelease(): void {
    if (this.#closed) return;
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      void this.#queue.run(async () => {
        if (this.#mediaSessionId !== null || this.#loading) return;
        await this.#release(false);
      });
    }, this.#options.idleReleaseMs);
    this.#idleTimer.unref();
  }

  /**
   * Frees the speaker: quits the receiver app unless somebody else is using it
   * (`force` quits regardless, used when our own media is still playing).
   */
  async #release(force: boolean): Promise<void> {
    const client = this.#client;
    if (!client) return;
    const app = this.#app;
    this.#mediaSessionId = null;
    this.#media = null;
    try {
      if (app) {
        let inUse = false;
        if (!force) {
          const status = await this.#syncMediaStatus(app).catch(() => undefined);
          inUse = Boolean(status && status.playerState !== 'IDLE');
        }
        if (!inUse) {
          await callWithTimeout<unknown>((cb) => client.stop(app, cb), this.#options.requestTimeoutMs, 'Cast app stop');
        }
      }
    } catch (err) {
      this.#options.logger.debug('Could not quit receiver app', errorMessage(err));
    } finally {
      this.#dropConnection(client);
    }
  }
}

function buildMedia(request: LoadRequest): object {
  return {
    contentId: request.url,
    contentType: request.contentType,
    streamType: request.live ? 'LIVE' : 'BUFFERED',
    metadata: {
      type: 0,
      metadataType: 3,
      title: request.title,
      ...(request.artist ? { artist: request.artist } : {}),
      ...(request.imageUrl ? { images: [{ url: request.imageUrl }] } : {}),
    },
  };
}
