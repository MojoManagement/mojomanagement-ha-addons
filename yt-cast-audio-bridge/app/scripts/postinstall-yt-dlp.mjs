import { existsSync, mkdirSync, chmodSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import YTDlpWrapModule from 'yt-dlp-wrap';

const YTDlpWrap = YTDlpWrapModule.default ?? YTDlpWrapModule;
const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const localBinDir = path.join(repoRoot, 'tools', 'bin');
const localBinName = process.platform === 'win32' ? 'yt-dlp.cmd' : 'yt-dlp';
const localBinPath = path.join(localBinDir, localBinName);

const warnSoftFailure = (error) => {
  console.warn('[postinstall] Could not provision local yt-dlp fallback.');
  console.warn(`[postinstall] ${error?.message ?? error}`);
  console.warn('[postinstall] Install yt-dlp manually or set YT_DLP_BIN.');
};

process.on('uncaughtException', (error) => {
  warnSoftFailure(error);
  process.exit(0);
});

process.on('unhandledRejection', (error) => {
  warnSoftFailure(error);
  process.exit(0);
});

const hasSystemBinary = () => {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(cmd, ['yt-dlp'], { stdio: 'ignore' });
  return result.status === 0;
};

const hasLocalBinary = () => existsSync(localBinPath);


const findPythonWithYtDlpModule = () => {
  const candidates = process.platform === 'win32'
    ? ['py', 'python', 'python3']
    : ['python3', 'python'];

  for (const cmd of candidates) {
    const result = spawnSync(cmd, ['-m', 'yt_dlp', '--version'], { stdio: 'ignore' });
    if (result.status === 0) return cmd;
  }
  return '';
};

const provisionPythonModuleShim = (pythonCmd) => {
  if (!pythonCmd) return false;

  mkdirSync(localBinDir, { recursive: true });

  if (process.platform === 'win32') {
    const shim = `@echo off
"${pythonCmd}" -m yt_dlp %*
`;
    writeFileSync(localBinPath, shim, 'utf8');
  } else {
    const shim = `#!/usr/bin/env sh
exec ${pythonCmd} -m yt_dlp "$@"
`;
    writeFileSync(localBinPath, shim, 'utf8');
    chmodSync(localBinPath, 0o755);
  }

  console.log(`[postinstall] Provisioned local yt-dlp shim via '${pythonCmd} -m yt_dlp' at ${localBinPath}.`);
  return true;
};

const patchYtCastReceiver = () => {
  let targetPath;
  try {
    const entryPath = require.resolve('yt-cast-receiver');
    targetPath = path.join(path.dirname(entryPath), 'lib', 'app', 'YouTubeApp.js');
  } catch {
    console.warn('[postinstall] yt-cast-receiver not found; skipping protocol patch.');
    return;
  }

  const source = readFileSync(targetPath, 'utf8');

  const anchor = `        case 'getNowPlaying': {
            sendMessages.push(new Message.NowPlaying(AID, isSessionActive ? await __classPrivateFieldGet(this, _YouTubeApp_player, "f").getState() : null));
            break;
        }
`;

  if (!source.includes(anchor)) {
    console.warn('[postinstall] Unable to locate message handler anchor in yt-cast-receiver; skipping protocol patch.');
    return;
  }

  let patched = source;

  if (!patched.includes("case 'getDiscoveryDeviceId':")) {
    const discoveryCase = `        case 'getDiscoveryDeviceId': {
            sendMessages.push(new Message(AID, 'discoveryDeviceId', {}));
            break;
        }
`;
    patched = patched.replace(anchor, `${anchor}${discoveryCase}`);
  }

  if (!patched.includes("case 'noop':")) {
    const noopCase = `        case 'noop': {
            break;
        }
`;
    patched = patched.replace(anchor, `${anchor}${noopCase}`);
  }

  if (patched === source) {
    console.log('[postinstall] yt-cast-receiver protocol patch already present.');
    return;
  }

  writeFileSync(targetPath, patched);
  console.log('[postinstall] Patched yt-cast-receiver protocol handlers (getDiscoveryDeviceId/noop).');
};

const main = async () => {
  patchYtCastReceiver();

  if (hasSystemBinary()) {
    console.log('[postinstall] Found system yt-dlp in PATH.');
    return;
  }

  if (hasLocalBinary()) {
    console.log(`[postinstall] Reusing existing local yt-dlp binary at ${localBinPath}.`);
    return;
  }

  const pythonCmd = findPythonWithYtDlpModule();
  if (provisionPythonModuleShim(pythonCmd)) {
    return;
  }

  console.log('[postinstall] yt-dlp not found in PATH and no python yt_dlp module detected. Downloading local fallback binary...');
  mkdirSync(localBinDir, { recursive: true });

  await YTDlpWrap.downloadFromGithub(localBinPath);

  if (process.platform !== 'win32') {
    chmodSync(localBinPath, 0o755);
  }

  console.log(`[postinstall] Downloaded yt-dlp fallback to ${localBinPath}.`);
};

main().catch((error) => {
  warnSoftFailure(error);
});
