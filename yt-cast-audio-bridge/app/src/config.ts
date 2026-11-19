import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { LOG_LEVELS, type LogLevel } from './logger.ts';

export interface Config {
  /** Prefix of the name shown in the YouTube app's Cast menu. */
  namePrefix: string;
  /** Prefix of the name shown for manually linked devices. */
  screenPrefix: string;
  dialBasePort: number;
  dialBindAddresses: string[];
  dialBindInterfaces: string[];
  maxReceivers: number;
  /** Only expose devices without a screen (speakers, audio groups). */
  onlyAudioLike: boolean;
  includeGroups: boolean;
  includeRegex: RegExp | null;
  excludeRegex: RegExp | null;
  /** When non-empty, only devices whose IP, id or name is listed are exposed. */
  pinnedHosts: string[];
  offlineHideAfterMs: number;
  autoplay: boolean;
  ytDlpBin: string;
  ytDlpAutoUpdate: boolean;
  ytCookiesFile: string;
  logLevel: LogLevel;
  healthPort: number;
  dataDir: string;
  /** Allow the web UI and API from any address instead of Home Assistant ingress only. */
  uiOpen: boolean;
}

export interface LoadedConfig {
  config: Config;
  /** Human readable problems with the supplied options; the bridge still starts with defaults. */
  warnings: string[];
}

type Raw = Record<string, unknown>;

class Reader {
  readonly warnings: string[] = [];
  readonly #raw: Raw;

  constructor(raw: Raw) {
    this.#raw = raw;
  }

  #has(key: string): boolean {
    const value = this.#raw[key];
    return value !== undefined && value !== null && value !== '';
  }

  string(key: string, fallback: string): string {
    if (!this.#has(key)) return fallback;
    const value = this.#raw[key];
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number') return String(value);
    this.warnings.push(`Option "${key}" must be text; using "${fallback}".`);
    return fallback;
  }

  int(key: string, fallback: number, min: number, max: number): number {
    if (!this.#has(key)) return fallback;
    const value = Number(this.#raw[key]);
    if (!Number.isInteger(value) || value < min || value > max) {
      this.warnings.push(`Option "${key}" must be a whole number between ${min} and ${max}; using ${fallback}.`);
      return fallback;
    }
    return value;
  }

  bool(key: string, fallback: boolean): boolean {
    if (!this.#has(key)) return fallback;
    const value = this.#raw[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      const text = value.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(text)) return true;
      if (['0', 'false', 'no', 'off'].includes(text)) return false;
    }
    this.warnings.push(`Option "${key}" must be true or false; using ${fallback}.`);
    return fallback;
  }

  list(key: string): string[] {
    if (!this.#has(key)) return [];
    const value = this.#raw[key];
    const items = Array.isArray(value) ? value : String(value).split(',');
    return items.map((item) => String(item ?? '').trim()).filter(Boolean);
  }

  regex(key: string): RegExp | null {
    const source = this.string(key, '');
    if (!source) return null;
    try {
      return new RegExp(source, 'i');
    } catch {
      this.warnings.push(`Option "${key}" is not a valid regular expression and is ignored: ${source}`);
      return null;
    }
  }

  oneOf<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
    const value = this.string(key, fallback).toUpperCase();
    if ((allowed as readonly string[]).includes(value)) return value as T;
    this.warnings.push(`Option "${key}" must be one of ${allowed.join(', ')}; using ${fallback}.`);
    return fallback;
  }
}

/** Builds a validated config from raw option values (add-on options or env). Never throws. */
export function parseConfig(raw: Raw, defaults: { dataDir: string }): LoadedConfig {
  const reader = new Reader(raw);
  const config: Config = {
    namePrefix: reader.string('bridge_name_prefix', 'Audio ->'),
    screenPrefix: reader.string('bridge_screen_prefix', 'YouTube on'),
    dialBasePort: reader.int('dial_base_port', 3000, 1024, 65000),
    dialBindAddresses: reader.list('dial_bind_to_addresses'),
    dialBindInterfaces: reader.list('dial_bind_to_interfaces'),
    maxReceivers: reader.int('max_receivers', 25, 1, 100),
    onlyAudioLike: reader.bool('only_audio_like', true),
    includeGroups: reader.bool('include_groups', true),
    includeRegex: reader.regex('include_regex'),
    excludeRegex: reader.regex('exclude_regex'),
    pinnedHosts: reader.list('pinned_hosts'),
    offlineHideAfterMs: reader.int('offline_hide_after_ms', 180_000, 10_000, 3_600_000),
    autoplay: reader.bool('autoplay', true),
    ytDlpBin: reader.string('yt_dlp_bin', ''),
    ytDlpAutoUpdate: reader.bool('yt_dlp_auto_update', true),
    ytCookiesFile: reader.string('yt_cookies_file', ''),
    logLevel: reader.oneOf('log_level', LOG_LEVELS, 'INFO'),
    healthPort: reader.int('health_port', 3099, 1024, 65535),
    dataDir: reader.string('data_dir', defaults.dataDir),
    uiOpen: reader.bool('ui_open', false),
  };

  const receiverPortEnd = config.dialBasePort + config.maxReceivers - 1;
  if (config.healthPort >= config.dialBasePort && config.healthPort <= receiverPortEnd) {
    reader.warnings.push(
      `Option "health_port" (${config.healthPort}) lies inside the receiver port range ${config.dialBasePort}-${receiverPortEnd}; that port is skipped for receivers.`,
    );
  }
  if (config.ytCookiesFile && !existsSync(config.ytCookiesFile)) {
    reader.warnings.push(`Option "yt_cookies_file" points to a missing file and is ignored: ${config.ytCookiesFile}`);
    config.ytCookiesFile = '';
  }
  return { config, warnings: reader.warnings };
}

export const OPTION_KEYS = [
  'bridge_name_prefix',
  'bridge_screen_prefix',
  'dial_base_port',
  'dial_bind_to_addresses',
  'dial_bind_to_interfaces',
  'max_receivers',
  'only_audio_like',
  'include_groups',
  'include_regex',
  'exclude_regex',
  'pinned_hosts',
  'offline_hide_after_ms',
  'autoplay',
  'yt_dlp_bin',
  'yt_dlp_auto_update',
  'yt_cookies_file',
  'log_level',
  'health_port',
  'data_dir',
  'ui_open',
] as const;

/**
 * Reads options from the Home Assistant options file when present; environment
 * variables (upper-cased option names) override individual values.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const optionsFile = env.OPTIONS_FILE ?? '/data/options.json';
  const raw: Raw = {};
  const earlyWarnings: string[] = [];
  const insideAddon = existsSync(optionsFile);
  if (insideAddon) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(optionsFile, 'utf8'));
      if (parsed && typeof parsed === 'object') Object.assign(raw, parsed);
    } catch {
      earlyWarnings.push(`Could not read ${optionsFile}; using default options.`);
    }
  }
  for (const key of OPTION_KEYS) {
    const value = env[key.toUpperCase()];
    if (value !== undefined) raw[key] = value;
  }
  const dataDir = insideAddon ? '/data/yt-cast-audio-bridge' : path.resolve('state');
  const loaded = parseConfig(raw, { dataDir });
  return { config: loaded.config, warnings: [...earlyWarnings, ...loaded.warnings] };
}
