import { format } from 'node:util';
import YouTubeCastReceiver, { Constants, DataStore, type Logger as ReceiverLogger } from 'yt-cast-receiver';
import { CastLink } from '../cast/link.ts';
import type { Logger } from '../logger.ts';
import type { StateStore } from '../state.ts';
import { errorMessage } from '../util.ts';
import { PairingWindow, type PairingCode, type PairingService } from './pairing.ts';
import { ForwardingPlayer, type NowPlaying, type TrackResolver } from './player.ts';

export interface ReceiverSpec {
  deviceId: string;
  /** Name shown in the YouTube app's Cast menu. */
  displayName: string;
  screenName: string;
  port: number;
  bindAddresses: string[];
  bindInterfaces: string[];
  autoplay: boolean;
  getEndpoint: () => { host: string; port: number } | null;
}

export interface ReceiverSnapshot {
  port: number;
  displayName: string;
  senders: number;
  nowPlaying: NowPlaying | null;
  lastError: string;
  /** TV code currently on offer for linking a phone, if somebody asked for one. */
  pairing: PairingCode | null;
}

/** What the supervisor needs from a running virtual receiver. */
export interface ReceiverHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  snapshot(): ReceiverSnapshot;
  /** Provides a TV code for linking a phone that cannot discover the bridge. */
  requestPairingCode(): Promise<PairingCode>;
  /** Called once when the receiver died on its own and must be restarted. */
  onTerminated(listener: (reason: string) => void): void;
}

/** Routes the receiver library's log output into the bridge logger. */
function adaptLogger(logger: Logger): ReceiverLogger {
  return {
    error: (...msg: unknown[]) => logger.error(format(...msg)),
    warn: (...msg: unknown[]) => logger.warn(format(...msg)),
    // The library is chatty at info level (every keep-alive round trip).
    info: (...msg: unknown[]) => logger.debug(format(...msg)),
    debug: (...msg: unknown[]) => logger.debug(format(...msg)),
    setLevel: () => undefined,
  };
}

/** Persists the receiver's pairing data so the YouTube app recognises it after a restart. */
class DeviceDataStore extends DataStore {
  readonly #state: StateStore;
  readonly #deviceId: string;

  constructor(state: StateStore, deviceId: string) {
    super();
    this.#state = state;
    this.#deviceId = deviceId;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.#state.setStoreValue(this.#deviceId, key, value);
  }

  async get<T>(key: string): Promise<T | null> {
    return this.#state.getStoreValue(this.#deviceId, key) as T | null;
  }
}

/** One virtual YouTube receiver bound to one Cast device. */
export class DeviceReceiver implements ReceiverHandle {
  readonly #spec: ReceiverSpec;
  readonly #log: Logger;
  readonly #link: CastLink;
  readonly #player: ForwardingPlayer;
  readonly #receiver: YouTubeCastReceiver;
  #pairing: PairingWindow | null = null;
  #terminated: ((reason: string) => void) | null = null;
  #running = false;

  constructor(spec: ReceiverSpec, deps: { resolver: TrackResolver; state: StateStore; logger: Logger }) {
    this.#spec = spec;
    this.#log = deps.logger;
    this.#link = new CastLink({ getEndpoint: spec.getEndpoint, logger: deps.logger.child('cast') });
    this.#player = new ForwardingPlayer({ link: this.#link, resolver: deps.resolver, logger: deps.logger });

    this.#receiver = new YouTubeCastReceiver(this.#player, {
      dial: {
        port: spec.port,
        prefix: `/ytbridge/${spec.deviceId}`,
        bindToAddresses: spec.bindAddresses.length ? spec.bindAddresses : undefined,
        bindToInterfaces: spec.bindInterfaces.length ? spec.bindInterfaces : undefined,
      },
      app: {
        enableAutoplayOnConnect: spec.autoplay,
        resetPlayerOnDisconnectPolicy: Constants.RESET_PLAYER_ON_DISCONNECT_POLICIES.ALL_EXPLICITLY_DISCONNECTED,
        mutePolicy: Constants.MUTE_POLICIES.PRESERVE_VOLUME_LEVEL,
      },
      device: { name: spec.displayName, screenName: spec.screenName, brand: 'YT Cast Audio Bridge', model: 'Audio Bridge' },
      dataStore: new DeviceDataStore(deps.state, spec.deviceId),
      logger: adaptLogger(deps.logger.child('yt')),
    });

    this.#receiver.on('senderConnect', (sender) => {
      this.#log.info(`${sender.name || 'A phone'} connected`);
      // Show the speaker's real volume in the YouTube app right away.
      this.#link
        .refreshVolume()
        .then(() => this.#player.adoptDeviceVolume(this.#link.volume))
        .catch((err: unknown) => this.#log.debug('Could not read speaker volume', errorMessage(err)));
    });
    this.#receiver.on('senderDisconnect', (sender) => this.#log.info(`${sender.name || 'A phone'} disconnected`));
    this.#receiver.on('error', (err) => this.#log.warn('Receiver error', errorMessage(err)));
    this.#receiver.on('terminate', (err) => {
      this.#running = false;
      this.#terminated?.(errorMessage(err));
    });
  }

  onTerminated(listener: (reason: string) => void): void {
    this.#terminated = listener;
  }

  async start(): Promise<void> {
    await this.#receiver.start();
    this.#running = true;
  }

  async stop(): Promise<void> {
    this.#terminated = null;
    this.#pairing?.stop();
    try {
      if (this.#running) await this.#receiver.stop();
    } catch (err) {
      this.#log.debug('Receiver did not stop cleanly', errorMessage(err));
    }
    this.#running = false;
    await this.#link.close();
  }

  requestPairingCode(): Promise<PairingCode> {
    if (!this.#running) return Promise.reject(new Error('The receiver is not running'));
    this.#pairing ??= new PairingWindow(this.#receiver.getPairingCodeRequestService() as unknown as PairingService, this.#log);
    return this.#pairing.request();
  }

  snapshot(): ReceiverSnapshot {
    return {
      port: this.#spec.port,
      displayName: this.#spec.displayName,
      senders: this.#running ? this.#receiver.getConnectedSenders().length : 0,
      nowPlaying: this.#player.nowPlaying,
      lastError: this.#player.lastError,
      pairing: this.#pairing?.current ?? null,
    };
  }
}
