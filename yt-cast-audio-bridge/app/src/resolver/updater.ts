import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../logger.ts';
import { errorMessage } from '../util.ts';
import { defaultExec, type ExecFn } from './ytdlp.ts';

const RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
const ASSET = 'yt-dlp';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MIN_RETRY_MS = 60 * 60 * 1000;
const MAX_DOWNLOAD_BYTES = 30 * 1024 * 1024;

export type FetchFn = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

export interface YtDlpManagerOptions {
  /** Binary configured by the user; when set, no managed copy is used. */
  explicitBin: string;
  /** Binary shipped with the image (or found on PATH). */
  bundledBin: string;
  /** Directory for the self-updated copy. */
  dataDir: string;
  autoUpdate: boolean;
  logger: Logger;
  exec?: ExecFn;
  fetch?: FetchFn;
  now?: () => number;
}

export interface YtDlpStatus {
  binary: string;
  source: 'configured' | 'updated' | 'bundled';
  version: string;
  autoUpdate: boolean;
  lastUpdateCheckAt: number;
  lastUpdateError: string;
  working: boolean;
}

/** Extracts the checksum for `asset` from a `SHA2-256SUMS` file. */
export function findChecksum(sums: string, asset: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const [hash, name] = line.trim().split(/\s+/);
    if (name === asset && hash && /^[a-f0-9]{64}$/i.test(hash)) return hash.toLowerCase();
  }
  return null;
}

/**
 * Chooses the yt-dlp binary and keeps a managed copy up to date. YouTube
 * changes often; an outdated yt-dlp is the most common reason playback breaks.
 */
export class YtDlpManager {
  readonly #options: YtDlpManagerOptions;
  readonly #exec: ExecFn;
  readonly #fetch: FetchFn;
  readonly #now: () => number;
  readonly #managedPath: string;
  #binary: string;
  #source: YtDlpStatus['source'];
  #version = '';
  #supportsJsRuntimes = false;
  #lastCheckAt = 0;
  #lastError = '';
  #updating: Promise<boolean> | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(options: YtDlpManagerOptions) {
    this.#options = options;
    this.#exec = options.exec ?? defaultExec;
    this.#fetch = options.fetch ?? ((url) => fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) }));
    this.#now = options.now ?? Date.now;
    this.#managedPath = path.join(options.dataDir, 'yt-dlp', ASSET);
    this.#binary = options.explicitBin || options.bundledBin;
    this.#source = options.explicitBin ? 'configured' : 'bundled';
  }

  get binary(): string {
    return this.#binary;
  }

  get supportsJsRuntimes(): boolean {
    return this.#supportsJsRuntimes;
  }

  get managed(): boolean {
    return !this.#options.explicitBin && this.#options.autoUpdate;
  }

  status(): YtDlpStatus {
    return {
      binary: this.#binary,
      source: this.#source,
      version: this.#version,
      autoUpdate: this.managed,
      lastUpdateCheckAt: this.#lastCheckAt,
      lastUpdateError: this.#lastError,
      working: Boolean(this.#version),
    };
  }

  /** Picks the best available binary and starts the daily update check. */
  async start(): Promise<void> {
    if (this.managed && (await this.#probe(this.#managedPath))) {
      this.#use(this.#managedPath, 'updated');
    }
    await this.#inspect();
    if (!this.managed) return;

    const age = await stat(this.#managedPath).then((s) => this.#now() - s.mtimeMs, () => Infinity);
    if (age > CHECK_INTERVAL_MS || !this.#version) void this.update();
    this.#timer = setInterval(() => void this.update(), CHECK_INTERVAL_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Called when resolving keeps failing: an update is the most likely fix. */
  onResolveFailures(consecutiveFailures: number): void {
    if (!this.managed || consecutiveFailures < 2) return;
    if (this.#now() - this.#lastCheckAt < MIN_RETRY_MS) return;
    this.#options.logger.warn('YouTube lookups keep failing; checking for a newer yt-dlp');
    void this.update();
  }

  /** Downloads the latest release, verifies it and switches to it. Resolves to true when a new version is active. */
  update(): Promise<boolean> {
    this.#updating ??= this.#update().finally(() => {
      this.#updating = null;
    });
    return this.#updating;
  }

  async #update(): Promise<boolean> {
    this.#lastCheckAt = this.#now();
    const dir = path.dirname(this.#managedPath);
    const tmp = `${this.#managedPath}.download`;
    try {
      const sums = Buffer.from(await this.#download(`${RELEASE_BASE}/SHA2-256SUMS`)).toString('utf8');
      const expected = findChecksum(sums, ASSET);
      if (!expected) throw new Error('Checksum for yt-dlp not found in release');

      // Skip the download when the binary in use already is the latest release.
      const current = await readFile(this.#binary).then((data) => createHash('sha256').update(data).digest('hex'), () => '');
      if (current === expected) {
        this.#lastError = '';
        this.#options.logger.debug('yt-dlp is already up to date');
        return false;
      }

      const body = Buffer.from(await this.#download(`${RELEASE_BASE}/${ASSET}`));
      const actual = createHash('sha256').update(body).digest('hex');
      if (actual !== expected) throw new Error('Downloaded yt-dlp does not match its published checksum');

      await mkdir(dir, { recursive: true });
      await writeFile(tmp, body, { mode: 0o755 });
      await chmod(tmp, 0o755);
      if (!(await this.#probe(tmp))) throw new Error('Downloaded yt-dlp does not run');
      await rename(tmp, this.#managedPath);

      const before = this.#version;
      this.#use(this.#managedPath, 'updated');
      await this.#inspect();
      this.#lastError = '';
      this.#options.logger.info(`yt-dlp updated: ${before || 'none'} -> ${this.#version}`);
      return true;
    } catch (err) {
      this.#lastError = errorMessage(err);
      this.#options.logger.warn('yt-dlp update failed; keeping the current version', this.#lastError);
      await rm(tmp, { force: true }).catch(() => undefined);
      return false;
    }
  }

  async #download(url: string): Promise<ArrayBuffer> {
    const response = await this.#fetch(url);
    if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}`);
    const body = await response.arrayBuffer();
    if (body.byteLength > MAX_DOWNLOAD_BYTES) throw new Error('Download is unexpectedly large');
    return body;
  }

  #use(binary: string, source: YtDlpStatus['source']): void {
    this.#binary = binary;
    this.#source = source;
  }

  async #probe(binary: string): Promise<boolean> {
    try {
      const { stdout } = await this.#exec(binary, ['--version'], { timeoutMs: 20_000 });
      return /^\d{4}\.\d{2}\.\d{2}/.test(stdout.trim());
    } catch {
      return false;
    }
  }

  async #inspect(): Promise<void> {
    try {
      const { stdout } = await this.#exec(this.#binary, ['--version'], { timeoutMs: 20_000 });
      this.#version = stdout.trim();
      const help = await this.#exec(this.#binary, ['--help'], { timeoutMs: 20_000 });
      this.#supportsJsRuntimes = help.stdout.includes('--js-runtimes');
    } catch (err) {
      this.#version = '';
      this.#supportsJsRuntimes = false;
      this.#options.logger.error(`yt-dlp is not usable (${this.#binary})`, errorMessage(err));
    }
  }
}
