import assert from 'node:assert/strict';
import { test } from 'node:test';
import { silentLogger } from '../src/logger.ts';
import { contentTypeFor, parseTrack, urlExpiry, YtDlpResolver, type ExecFn } from '../src/resolver/ytdlp.ts';

const NOW = 1_800_000_000_000;
const json = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: 'jNQXAC9IVRw', title: 'Me at the zoo', duration: 19, is_live: false, ext: 'm4a', protocol: 'https', uploader: 'jawed',
    url: `https://rr4.googlevideo.com/videoplayback?expire=${NOW / 1000 + 6 * 3600}&itag=140`, ...extra,
  });

function setup(responses: (string | Error)[]) {
  let now = NOW;
  const calls: { file: string; args: string[] }[] = [];
  const failures: number[] = [];
  const exec: ExecFn = async (file, args) => {
    calls.push({ file, args });
    const next = responses.shift();
    if (next === undefined) throw new Error('unexpected call');
    if (next instanceof Error) throw next;
    return { stdout: next, stderr: '' };
  };
  const resolver = new YtDlpResolver({
    getBinary: () => '/bin/yt-dlp', useNodeRuntime: () => true, exec, logger: silentLogger, now: () => now, cacheSize: 2,
    onFailure: (count) => failures.push(count),
  });
  return { resolver, calls, failures, advance: (ms: number) => (now += ms) };
}

test('parses yt-dlp output into a track', () => {
  const track = parseTrack(`WARNING: noise\n${json()}\n`, 'jNQXAC9IVRw', NOW);
  assert.equal(track.title, 'Me at the zoo');
  assert.equal(track.artist, 'jawed');
  assert.equal(track.duration, 19);
  assert.equal(track.contentType, 'audio/mp4');
  assert.equal(track.expiresAt, NOW + 5 * 3600_000, 'capped at five hours');
});

test('rejects output without a playable url', () => {
  assert.throws(() => parseTrack(json({ url: '' }), 'x', NOW), /No playable audio/);
  assert.throws(() => parseTrack('', 'x', NOW), /no result/);
});

test('content type and expiry helpers', () => {
  assert.equal(contentTypeFor('mp4', 'm3u8_native'), 'application/x-mpegURL');
  assert.equal(contentTypeFor('webm', 'https'), 'audio/webm');
  assert.equal(urlExpiry('https://x/videoplayback?a=1', NOW), NOW + 3600_000);
  assert.equal(urlExpiry(`https://x/videoplayback?expire=${NOW / 1000 + 1800}`, NOW), NOW + 20 * 60_000, 'ten minute safety margin');
});

test('passes safe arguments and never interprets the id as an option', async () => {
  const { resolver, calls } = setup([json()]);
  await resolver.resolve('jNQXAC9IVRw');
  const args = calls[0]?.args ?? [];
  assert.equal(args.at(-2), '--');
  assert.equal(args.at(-1), 'https://www.youtube.com/watch?v=jNQXAC9IVRw');
  assert.ok(args.includes('--ignore-config'));
  assert.deepEqual(args.slice(args.indexOf('--js-runtimes'), args.indexOf('--js-runtimes') + 2), ['--js-runtimes', 'node']);
  await assert.rejects(resolver.resolve('--exec=rm'), /Invalid YouTube video id/);
  await assert.rejects(resolver.resolve('a&b=c'), /Invalid YouTube video id/);
  assert.equal(calls.length, 1);
});

test('caches results until the url expires', async () => {
  const { resolver, calls, advance } = setup([json(), json({ title: 'Second' })]);
  await resolver.resolve('jNQXAC9IVRw');
  await resolver.resolve('jNQXAC9IVRw');
  assert.equal(calls.length, 1);
  assert.equal(resolver.stats.cacheHits, 1);
  advance(5 * 3600_000 + 1);
  assert.equal((await resolver.resolve('jNQXAC9IVRw')).title, 'Second');
});

test('concurrent requests share one yt-dlp run', async () => {
  const { resolver, calls } = setup([json()]);
  const [a, b] = await Promise.all([resolver.resolve('jNQXAC9IVRw'), resolver.resolve('jNQXAC9IVRw')]);
  assert.equal(a, b);
  assert.equal(calls.length, 1);
});

test('counts consecutive failures and resets on success', async () => {
  const { resolver, failures } = setup([new Error('Sign in to confirm'), new Error('again'), json()]);
  await assert.rejects(resolver.resolve('jNQXAC9IVRw'), /Sign in to confirm/);
  await assert.rejects(resolver.resolve('jNQXAC9IVRw'));
  assert.deepEqual(failures, [1, 2]);
  await resolver.resolve('jNQXAC9IVRw');
  assert.equal(resolver.stats.consecutiveFailures, 0);
});

test('invalidate forces a new lookup and the cache stays bounded', async () => {
  const { resolver, calls } = setup([json(), json(), json(), json(), json()]);
  await resolver.resolve('aaaaaaaaaaa');
  resolver.invalidate('aaaaaaaaaaa');
  await resolver.resolve('aaaaaaaaaaa');
  await resolver.resolve('bbbbbbbbbbb');
  await resolver.resolve('ccccccccccc');
  assert.equal(calls.length, 4);
  await resolver.resolve('aaaaaaaaaaa');
  assert.equal(calls.length, 5, 'oldest entry was evicted');
});
