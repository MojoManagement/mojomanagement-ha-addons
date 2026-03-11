import 'dotenv/config';

const env = (name, fallback = '') => process.env[name] ?? fallback;
const asInt = (value, fallback) => {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  app: {
    name: 'yt-cast-audio-bridge',
    stateFile: env('STATE_FILE', 'state/bridge-state.json'),
    healthPort: asInt(env('HEALTH_PORT', '3099'), 3099),
    logLevel: env('LOG_LEVEL', 'INFO').toUpperCase(),
  },
  dial: {
    basePort: asInt(env('DIAL_BASE_PORT', '3000'), 3000),
    prefixBase: env('DIAL_PREFIX_BASE', '/ytbridge'),
  },
  discovery: {
    intervalMs: asInt(env('DISCOVERY_INTERVAL_MS', '5000'), 5000),
    offlineHideAfterMs: asInt(env('OFFLINE_HIDE_AFTER_MS', '180000'), 180000),
    startupGraceMs: asInt(env('STARTUP_GRACE_MS', '4000'), 4000),
    maxReceivers: asInt(env('MAX_RECEIVERS', '25'), 25),
    playRetryMs: asInt(env('PLAY_RETRY_MS', '8000'), 8000),
  },
  naming: {
    bridgeNamePrefix: env('BRIDGE_NAME_PREFIX', 'Audio ->'),
    bridgeScreenPrefix: env('BRIDGE_SCREEN_PREFIX', 'YouTube on'),
    allowDuplicateFriendlyNames: env('ALLOW_DUPLICATE_FRIENDLY_NAMES', '0') === '1',
  },
  filters: {
    includeRegex: env('INCLUDE_REGEX', ''),
    excludeRegex: env('EXCLUDE_REGEX', 'Chromecast|Google TV|Nest Hub|Shield|Roku|Fire TV'),
    onlyAudioLike: env('ONLY_AUDIO_LIKE', '1') === '1',
    pinnedHosts: env('PINNED_HOSTS', '').split(',').map((s) => s.trim()).filter(Boolean),
  },
  resolver: {
    ytDlpBin: env('YT_DLP_BIN', 'yt-dlp'),
    ytCookiesFile: env('YT_COOKIES_FILE', ''),
  },
};
