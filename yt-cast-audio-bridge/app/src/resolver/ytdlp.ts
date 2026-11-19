import { execFile } from 'node:child_process';
import type { Logger } from '../logger.ts';
import { errorMessage } from '../util.ts';

export interface Track {
  id: string;
  title: string;
  artist: string;
  /** Seconds; 0 for live streams. */
  duration: number;
  isLive: boolean;
  url: string;
  contentType: string;
  thumbnail: string;
  /** Epoch ms after which the media URL must not be used any more. */
  expiresAt: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export type ExecFn = (file: string, args: string[], options: { timeoutMs: number }) => Promise<ExecResult>;

export const defaultExec: ExecFn = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: options.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || '').trim().split('\n').pop() ?? '';
          reject(new Error(detail || err.message));
        } else {
          resolve({ stdout: String(stdout), stderr: String(stderr) });
        }
      },
    );
  });

const VIDEO_ID = /^[A-Za-z0-9_-]{6,20}$/;
// AAC in MP4 plays on every Cast device; everything after it is a fallback.
const FORMAT_SELECTOR = 'bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio/best[height<=480]/best';
const PRINT_TEMPLATE = '%(.{id,title,duration,is_live,url,ext,protocol,uploader,channel,thumbnail})j';
const MAX_URL_LIFETIME_MS = 5 * 60 * 60 * 1000;
const EXPIRY_MARGIN_MS = 10 * 60 * 1000;

export function contentTypeFor(ext: string, protocol: string): string {
  if (protocol.startsWith('m3u8')) return 'application/x-mpegURL';
  switch (ext) {
    case 'm4a':
    case 'mp4':
      return 'audio/mp4';
    case 'webm':
    case 'opus':
      return 'audio/webm';
    case 'mp3':
      return 'audio/mpeg';
    default:
      return 'audio/mp4';
  }
}

/** Reads the `expire=<unix seconds>` parameter YouTube puts into media URLs. */
export function urlExpiry(url: string, now: number): number {
  const fallback = now + 60 * 60 * 1000;
  const match = /[?&/]expire[=/](\d{9,11})/.exec(url);
  if (!match) return fallback;
  const expiresAt = Number(match[1]) * 1000 - EXPIRY_MARGIN_MS;
  return Math.min(expiresAt, now + MAX_URL_LIFETIME_MS);
}

export function parseTrack(stdout: string, videoId: string, now: number): Track {
  const line = stdout.split('\n').find((candidate) => candidate.trim().startsWith('{'));
  if (!line) throw new Error('yt-dlp returned no result');
  const info = JSON.parse(line) as Record<string, unknown>;
  const url = typeof info.url === 'string' ? info.url : '';
  if (!/^https?:\/\//.test(url)) throw new Error(`No playable audio stream for ${videoId}`);
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  const isLive = info.is_live === true;
  return {
    id: videoId,
    title: text(info.title) || videoId,
    artist: text(info.uploader) || text(info.channel),
    duration: isLive ? 0 : Number(info.duration) || 0,
    isLive,
    url,
    contentType: contentTypeFor(text(info.ext), text(info.protocol)),
    thumbnail: text(info.thumbnail),
    expiresAt: urlExpiry(url, now),
  };
}

export interface ResolverStats {
  resolved: number;
  failed: number;
  cacheHits: number;
  consecutiveFailures: number;
  lastError: string;
  lastErrorAt: number;
  lastDurationMs: number;
}

export interface YtDlpResolverOptions {
  /** Returns the yt-dlp binary to use right now (it can change after an update). */
  getBinary: () => string;
  cookiesFile?: string;
  /** Whether the binary understands `--js-runtimes`. */
  useNodeRuntime?: () => boolean;
  exec?: ExecFn;
  logger: Logger;
  now?: () => number;
  timeoutMs?: number;
  cacheSize?: number;
  /** Called after every failed resolve with the number of consecutive failures. */
  onFailure?: (consecutiveFailures: number) => void;
}

/**
 * Turns a YouTube video id into a media URL a Cast device can play. Results are
 * cached until the URL expires, and concurrent requests for the same video share one yt-dlp run.
 */
export class YtDlpResolver {
  readonly #options: YtDlpResolverOptions;
  readonly #exec: ExecFn;
  readonly #now: () => number;
  readonly #cache = new Map<string, Track>();
  readonly #inflight = new Map<string, Promise<Track>>();
  readonly stats: ResolverStats = {
    resolved: 0,
    failed: 0,
    cacheHits: 0,
    consecutiveFailures: 0,
    lastError: '',
    lastErrorAt: 0,
    lastDurationMs: 0,
  };

  constructor(options: YtDlpResolverOptions) {
    this.#options = options;
    this.#exec = options.exec ?? defaultExec;
    this.#now = options.now ?? Date.now;
  }

  resolve(videoId: string): Promise<Track> {
    if (!VIDEO_ID.test(videoId)) return Promise.reject(new Error(`Invalid YouTube video id: ${videoId}`));
    const cached = this.#cache.get(videoId);
    if (cached && cached.expiresAt > this.#now()) {
      this.stats.cacheHits += 1;
      // Refresh recency so frequently used entries survive eviction.
      this.#cache.delete(videoId);
      this.#cache.set(videoId, cached);
      return Promise.resolve(cached);
    }
    const running = this.#inflight.get(videoId);
    if (running) return running;

    const promise = this.#run(videoId).finally(() => this.#inflight.delete(videoId));
    this.#inflight.set(videoId, promise);
    return promise;
  }

  /** Resolves in the background so that the next track starts without delay. */
  prefetch(videoId: string): void {
    this.resolve(videoId).catch((err: unknown) => {
      this.#options.logger.debug(`Prefetch of ${videoId} failed`, errorMessage(err));
    });
  }

  invalidate(videoId: string): void {
    this.#cache.delete(videoId);
  }

  async #run(videoId: string): Promise<Track> {
    const args = ['--ignore-config', '--no-playlist', '--no-warnings', '--no-progress', '--socket-timeout', '10'];
    if (this.#options.useNodeRuntime?.()) args.push('--js-runtimes', 'node');
    if (this.#options.cookiesFile) args.push('--cookies', this.#options.cookiesFile);
    args.push('-f', FORMAT_SELECTOR, '-O', PRINT_TEMPLATE, '--', `https://www.youtube.com/watch?v=${videoId}`);

    const startedAt = this.#now();
    try {
      const { stdout } = await this.#exec(this.#options.getBinary(), args, { timeoutMs: this.#options.timeoutMs ?? 40_000 });
      const track = parseTrack(stdout, videoId, this.#now());
      this.#store(track);
      this.stats.resolved += 1;
      this.stats.consecutiveFailures = 0;
      this.stats.lastDurationMs = this.#now() - startedAt;
      this.#options.logger.debug(`Resolved ${videoId} in ${this.stats.lastDurationMs} ms: "${track.title}"`);
      return track;
    } catch (err) {
      this.stats.failed += 1;
      this.stats.consecutiveFailures += 1;
      this.stats.lastError = errorMessage(err);
      this.stats.lastErrorAt = this.#now();
      this.#options.onFailure?.(this.stats.consecutiveFailures);
      throw new Error(`Could not resolve ${videoId}: ${errorMessage(err)}`);
    }
  }

  #store(track: Track): void {
    this.#cache.set(track.id, track);
    const limit = this.#options.cacheSize ?? 64;
    while (this.#cache.size > limit) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
  }
}
