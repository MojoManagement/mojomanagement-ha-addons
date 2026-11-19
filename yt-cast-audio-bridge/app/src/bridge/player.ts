import { Constants, Player, type Video, type Volume } from 'yt-cast-receiver';
import type { CastLink, LinkVolume, StoppedEvent } from '../cast/link.ts';
import type { Logger } from '../logger.ts';
import type { Track } from '../resolver/ytdlp.ts';
import { clamp, errorMessage } from '../util.ts';

const STATUS = Constants.PLAYER_STATUSES;

export interface TrackResolver {
  resolve(videoId: string): Promise<Track>;
  prefetch(videoId: string): void;
  invalidate(videoId: string): void;
}

export interface NowPlaying {
  videoId: string;
  title: string;
  artist: string;
  state: 'playing' | 'paused' | 'loading';
}

/** Implements the YouTube receiver's player by forwarding everything to one Cast device. */
export class ForwardingPlayer extends Player {
  readonly #link: CastLink;
  readonly #resolver: TrackResolver;
  readonly #log: Logger;
  /** Incremented on every play/stop so that slow, superseded requests can tell they are stale. */
  #generation = 0;
  /** Outcome of the most recent play request (or `false` after a stop). */
  #latest: Promise<boolean> = Promise.resolve(false);
  #track: Track | null = null;
  #volume: Volume = { level: 50, muted: false };
  /** Video id for which an automatic restart after a media error was already tried. */
  #recoveredVideoId = '';
  lastError = '';

  constructor(options: { link: CastLink; resolver: TrackResolver; logger: Logger }) {
    super();
    this.#link = options.link;
    this.#resolver = options.resolver;
    this.#log = options.logger;

    this.#link.on('finished', () => void this.#guard('advance', () => this.#onFinished()));
    this.#link.on('stopped', (event: StoppedEvent) => void this.#guard('stop handling', () => this.#onStopped(event)));
    this.#link.on('playerState', (state: 'PLAYING' | 'PAUSED') => void this.#guard('state sync', () => this.#onDeviceState(state)));
    this.#link.on('volume', (volume: LinkVolume) => void this.#guard('volume sync', () => this.#onDeviceVolume(volume)));
    this.on('state', () => this.#prefetchNext());
  }

  get nowPlaying(): NowPlaying | null {
    if (!this.#track) return null;
    const state = this.status === STATUS.PLAYING ? 'playing' : this.status === STATUS.PAUSED ? 'paused' : 'loading';
    return { videoId: this.#track.id, title: this.#track.title, artist: this.#track.artist, state };
  }

  protected async doPlay(video: Video, position: number): Promise<boolean> {
    const generation = ++this.#generation;
    const attempt = this.#playNow(video, Number(position) || 0, generation);
    this.#latest = attempt;
    let result = await attempt;
    // If a newer play or a stop overtook this request, report that outcome instead,
    // so the state shown on the phone always matches what the speaker is doing.
    let seen = generation;
    while (seen !== this.#generation) {
      seen = this.#generation;
      result = await this.#latest;
    }
    return result;
  }

  async #playNow(video: Video, startTime: number, generation: number): Promise<boolean> {
    try {
      const startedAt = Date.now();
      let track = await this.#resolver.resolve(video.id);
      const lookedUpAt = Date.now();
      if (generation !== this.#generation) return false;
      try {
        await this.#load(track, startTime);
      } catch (err) {
        if (generation !== this.#generation) return false;
        // A cached media URL can go stale early; look the video up again once.
        this.#log.warn(`Could not start "${track.title}", retrying with a fresh lookup`, errorMessage(err));
        this.#resolver.invalidate(video.id);
        track = await this.#resolver.resolve(video.id);
        if (generation !== this.#generation) return false;
        await this.#load(track, startTime);
      }
      if (generation !== this.#generation) return false;
      this.#track = track;
      this.lastError = '';
      // The timings show where the wait before the first sound comes from.
      const seconds = (ms: number): string => (ms / 1000).toFixed(1);
      this.#log.info(
        `Playing "${track.title}"${track.artist ? ` by ${track.artist}` : ''} (lookup ${seconds(lookedUpAt - startedAt)} s, speaker ${seconds(Date.now() - lookedUpAt)} s)`,
      );
      return true;
    } catch (err) {
      if (generation === this.#generation) {
        this.lastError = errorMessage(err);
        this.#log.error('Playback failed', this.lastError);
      }
      return false;
    }
  }

  /** Marks any play request still in flight as outdated. */
  #cancelPending(): void {
    this.#generation += 1;
    this.#latest = Promise.resolve(false);
  }

  protected async doPause(): Promise<boolean> {
    return this.#attempt('Pause', () => this.#link.pause());
  }

  protected async doResume(): Promise<boolean> {
    return this.#attempt('Resume', () => this.#link.resume());
  }

  protected async doStop(): Promise<boolean> {
    this.#cancelPending();
    this.#track = null;
    await this.#link.stop();
    return true;
  }

  protected async doSeek(position: number): Promise<boolean> {
    if (this.#track?.isLive) return false;
    return this.#attempt('Seek', () => this.#link.seek(Number(position) || 0));
  }

  protected async doSetVolume(volume: Volume): Promise<boolean> {
    const level = clamp(Math.round(Number(volume.level)), 0, 100);
    const muted = Boolean(volume.muted);
    return this.#attempt('Volume change', async () => {
      if (muted !== this.#volume.muted) await this.#link.setMuted(muted);
      if (!muted && level !== this.#volume.level) await this.#link.setVolume(level / 100);
      this.#volume = { level: muted ? this.#volume.level : level, muted };
    });
  }

  protected async doGetVolume(): Promise<Volume> {
    return this.#volume;
  }

  protected async doGetPosition(): Promise<number> {
    if (!this.#track) return 0;
    const position = this.#link.getPosition();
    return this.#track.duration > 0 ? Math.min(position, this.#track.duration) : position;
  }

  protected async doGetDuration(): Promise<number> {
    return this.#track?.duration ?? 0;
  }

  /** Adopts the speaker's real volume instead of pushing a default onto it. */
  adoptDeviceVolume(volume: LinkVolume | null): void {
    if (volume) this.#volume = { level: Math.round(volume.level * 100), muted: volume.muted };
  }

  #load(track: Track, startTime: number): Promise<void> {
    return this.#link.load({
      url: track.url,
      contentType: track.contentType,
      title: track.title,
      artist: track.artist,
      imageUrl: track.thumbnail,
      live: track.isLive,
      startTime: track.isLive ? 0 : startTime,
    });
  }

  async #onFinished(): Promise<void> {
    const generation = this.#generation;
    this.#log.debug('Track finished, advancing');
    const advanced = await this.next();
    if (!advanced && generation === this.#generation) {
      this.#track = null;
      await this.notifyExternalStateChange(STATUS.STOPPED);
    }
  }

  async #onStopped(event: StoppedEvent): Promise<void> {
    const video = this.queue.current;
    const active = this.status === STATUS.PLAYING || this.status === STATUS.PAUSED;
    if (!active) return;

    if (event.reason === 'error' && video && this.#recoveredVideoId !== video.id) {
      // Typically an expired media URL in the middle of a long track: pick up where it broke.
      this.#recoveredVideoId = video.id;
      this.#resolver.invalidate(video.id);
      this.#log.warn('Speaker reported a media error, restarting the track at the last position');
      await this.notifyExternalStateChange(STATUS.STOPPED);
      await this.play(video, Math.max(0, Math.floor(event.position)));
      return;
    }
    this.#log.info(`Playback ended on the speaker (${event.reason})`);
    this.#cancelPending();
    this.#track = null;
    await this.notifyExternalStateChange(STATUS.STOPPED);
  }

  async #onDeviceState(state: 'PLAYING' | 'PAUSED'): Promise<void> {
    if (state === 'PAUSED' && this.status === STATUS.PLAYING) await this.notifyExternalStateChange(STATUS.PAUSED);
    else if (state === 'PLAYING' && this.status === STATUS.PAUSED) await this.notifyExternalStateChange(STATUS.PLAYING);
  }

  async #onDeviceVolume(volume: LinkVolume): Promise<void> {
    const next = { level: Math.round(volume.level * 100), muted: volume.muted };
    if (next.level === this.#volume.level && next.muted === this.#volume.muted) return;
    this.#volume = next;
    await this.notifyExternalStateChange();
  }

  #prefetchNext(): void {
    if (this.status !== STATUS.PLAYING) return;
    const queue = this.queue.getState();
    const upcoming = queue.next ?? queue.autoplay;
    if (upcoming?.id) this.#resolver.prefetch(upcoming.id);
  }

  async #attempt(what: string, action: () => Promise<void>): Promise<boolean> {
    try {
      await action();
      return true;
    } catch (err) {
      this.#log.warn(`${what} failed`, errorMessage(err));
      return false;
    }
  }

  async #guard(what: string, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (err) {
      this.#log.warn(`Error during ${what}`, errorMessage(err));
    }
  }
}
