import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YTDlpWrapModule from 'yt-dlp-wrap';

const YTDlpWrap = YTDlpWrapModule.default ?? YTDlpWrapModule;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const localBinDir = path.join(repoRoot, 'tools', 'bin');
const localBinName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
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

const main = async () => {
  if (hasSystemBinary()) {
    console.log('[postinstall] Found system yt-dlp in PATH.');
    return;
  }

  if (hasLocalBinary()) {
    console.log(`[postinstall] Reusing existing local yt-dlp binary at ${localBinPath}.`);
    return;
  }

  console.log('[postinstall] yt-dlp not found in PATH. Downloading local fallback binary...');
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
