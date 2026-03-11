import 'dotenv/config';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const localYtDlpPath = path.join(repoRoot, 'tools', 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

const env = (name, fallback = '') => process.env[name] ?? fallback;
const asInt = (value, fallback) => {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
};

const asCsvList = (value) => String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean);

function isCandidateLanIpv4(entry) {
  const addr = String(entry?.address ?? '');
  if (!entry || entry.internal || entry.family !== 'IPv4' || !addr) return false;
  if (addr.startsWith('127.')) return false;
  if (addr.startsWith('169.254.')) return false;
  return true;
}

function isPrivateLanRange(address) {
  return address.startsWith('10.')
    || address.startsWith('192.168.')
    || /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(address);
}

function interfacePenalty(iface) {
  const name = String(iface ?? '').toLowerCase();
  if (!name) return 2;
  if (/^(docker|br-|veth|cni|flannel|kube|virbr|tailscale|wg|zt|tun|tap)/.test(name)) return 3;
  if (/^(lo|loopback)/.test(name)) return 4;
  if (/^(eth|en|wlan|wl|lan)/.test(name)) return 0;
  return 1;
}

function candidateSort(a, b) {
  const privateDelta = Number(isPrivateLanRange(b.address)) - Number(isPrivateLanRange(a.address));
  if (privateDelta !== 0) return privateDelta;

  const ifaceDelta = interfacePenalty(a.iface) - interfacePenalty(b.iface);
  if (ifaceDelta !== 0) return ifaceDelta;

  return a.iface.localeCompare(b.iface) || a.address.localeCompare(b.address);
}

function autodetectDialBinding() {
  const candidates = [];
  for (const [iface, addresses] of Object.entries(os.networkInterfaces())) {
    for (const entry of addresses ?? []) {
      if (!isCandidateLanIpv4(entry)) continue;
      candidates.push({ iface, address: entry.address });
    }
  }

  candidates.sort(candidateSort);
  const first = candidates[0] ?? null;
  return {
    detectedAddress: first?.address ?? '',
    detectedInterface: first?.iface ?? '',
    candidateCount: candidates.length,
  };
}

const explicitDialBindAddresses = asCsvList(env('DIAL_BIND_TO_ADDRESSES', ''));
const explicitDialBindInterfaces = asCsvList(env('DIAL_BIND_TO_INTERFACES', ''));
const autoDialBinding = autodetectDialBinding();

const bindToAddresses = explicitDialBindAddresses.length
  ? explicitDialBindAddresses
  : (explicitDialBindInterfaces.length ? [] : (autoDialBinding.detectedAddress ? [autoDialBinding.detectedAddress] : []));

const bindToInterfaces = explicitDialBindInterfaces;

const defaultYtDlpBin = process.env.YT_DLP_BIN
  ?? (existsSync(localYtDlpPath) ? localYtDlpPath : 'yt-dlp');

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
    bindToAddresses,
    bindToInterfaces,
    autoDetectedAddress: autoDialBinding.detectedAddress,
    autoDetectedInterface: autoDialBinding.detectedInterface,
    autoDetectedCandidateCount: autoDialBinding.candidateCount,
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
    pinnedHosts: asCsvList(env('PINNED_HOSTS', '')),
  },
  resolver: {
    ytDlpBin: defaultYtDlpBin,
    ytCookiesFile: env('YT_COOKIES_FILE', ''),
  },
};
