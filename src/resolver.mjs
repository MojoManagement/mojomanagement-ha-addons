import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function scoreAudioFormat(format) {
  if (!format || !format.url || format.vcodec !== 'none') return -1;
  let score = 0;
  if (format.ext === 'm4a') score += 1000;
  if ((format.acodec ?? '').includes('mp4a')) score += 900;
  if (format.ext === 'mp4') score += 800;
  if (format.ext === 'webm') score += 500;
  if (format.protocol === 'https' || format.protocol === 'http') score += 200;
  if (Number.isFinite(format.abr)) score += Math.min(format.abr, 320);
  return score;
}

function pickBestAudioFormat(formats) {
  const candidates = (formats ?? []).filter((f) => scoreAudioFormat(f) >= 0);
  if (!candidates.length) return null;
  return [...candidates].sort((a, b) => scoreAudioFormat(b) - scoreAudioFormat(a))[0];
}

export async function resolveYouTubeAudio(videoId, { ytDlpBin, ytCookiesFile }) {
  const args = [
    '--no-playlist',
    '--dump-single-json',
    '--no-warnings',
    '--no-call-home',
    `https://www.youtube.com/watch?v=${videoId}`,
  ];
  if (ytCookiesFile) args.unshift('--cookies', ytCookiesFile);

  const { stdout, stderr } = await execFileAsync(ytDlpBin, args, { maxBuffer: 50 * 1024 * 1024 });
  if (!stdout) throw new Error(`yt-dlp returned no output. stderr=${stderr ?? ''}`);

  const info = JSON.parse(stdout);
  const audioFormat = pickBestAudioFormat(info.formats);
  if (!audioFormat?.url) throw new Error(`No usable audio-only format for ${videoId}`);

  return {
    id: videoId,
    title: info.title ?? videoId,
    duration: Number(info.duration ?? 0),
    isLive: Boolean(info.is_live),
    mediaUrl: audioFormat.url,
  };
}
