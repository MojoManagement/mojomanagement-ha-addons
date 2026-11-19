import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Constants, type Video } from 'yt-cast-receiver';
import { ForwardingPlayer, type TrackResolver } from '../src/bridge/player.ts';
import type { CastLink, LoadRequest } from '../src/cast/link.ts';
import { silentLogger } from '../src/logger.ts';
import type { Track } from '../src/resolver/ytdlp.ts';

const STATUS = Constants.PLAYER_STATUSES;
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const video = (id: string): Video => ({ id, client: Constants.CLIENTS.YT });
const track = (id: string, extra: Partial<Track> = {}): Track => ({
  id, title: `Title ${id}`, artist: 'Artist', duration: 200, isLive: false, url: `https://media/${id}`, contentType: 'audio/mp4', thumbnail: '', expiresAt: 0, ...extra,
});

class FakeLink extends EventEmitter {
  calls: string[] = [];
  position = 0;
  loadErrors: Error[] = [];
  failNext = '';
  volume = null;
  async load(request: LoadRequest): Promise<void> {
    this.calls.push(`load:${request.url}@${request.startTime}`);
    const error = this.loadErrors.shift();
    if (error) throw error;
  }
  async pause(): Promise<void> { this.#call('pause'); }
  async resume(): Promise<void> { this.#call('resume'); }
  async stop(): Promise<void> { this.#call('stop'); }
  async seek(seconds: number): Promise<void> { this.#call(`seek:${seconds}`); }
  async setVolume(level: number): Promise<void> { this.#call(`volume:${level}`); }
  async setMuted(muted: boolean): Promise<void> { this.#call(`muted:${muted}`); }
  getPosition(): number { return this.position; }
  #call(name: string): void {
    this.calls.push(name);
    if (this.failNext === name) {
      this.failNext = '';
      throw new Error('device said no');
    }
  }
}

function setup(tracks: Record<string, Track | Error | Promise<Track>> = {}) {
  const link = new FakeLink();
  const resolverCalls: string[] = [];
  const resolver: TrackResolver = {
    resolve: async (id) => {
      resolverCalls.push(`resolve:${id}`);
      const result = tracks[id] ?? track(id);
      if (result instanceof Error) throw result;
      return result;
    },
    prefetch: (id) => { resolverCalls.push(`prefetch:${id}`); },
    invalidate: (id) => { resolverCalls.push(`invalidate:${id}`); },
  };
  const player = new ForwardingPlayer({ link: link as unknown as CastLink, resolver, logger: silentLogger });
  player.setLogger({ error() {}, warn() {}, info() {}, debug() {}, setLevel() {} });
  return { player, link, resolverCalls };
}

test('play resolves the video and loads it on the speaker', async () => {
  const { player, link } = setup();
  assert.equal(await player.play(video('aaaaaaaaaaa'), 12), true);
  assert.deepEqual(link.calls, ['load:https://media/aaaaaaaaaaa@12']);
  assert.equal(player.status, STATUS.PLAYING);
  assert.deepEqual(player.nowPlaying, { videoId: 'aaaaaaaaaaa', title: 'Title aaaaaaaaaaa', artist: 'Artist', state: 'playing' });
  assert.equal(await player.getDuration(), 200);
});

test('a failed lookup reports stopped instead of spinning forever', async () => {
  const { player, link } = setup({ bbbbbbbbbbb: new Error('Video unavailable') });
  assert.equal(await player.play(video('bbbbbbbbbbb')), false);
  assert.equal(player.status, STATUS.STOPPED);
  assert.deepEqual(link.calls, []);
  assert.match(player.lastError, /Video unavailable/);
});

test('a failed load is retried once with a fresh lookup', async () => {
  const { player, link, resolverCalls } = setup();
  link.loadErrors = [new Error('Load failed')];
  assert.equal(await player.play(video('aaaaaaaaaaa')), true);
  assert.deepEqual(resolverCalls.slice(0, 3), ['resolve:aaaaaaaaaaa', 'invalidate:aaaaaaaaaaa', 'resolve:aaaaaaaaaaa']);
  assert.equal(link.calls.length, 2);

  link.loadErrors = [new Error('Load failed'), new Error('Load failed')];
  assert.equal(await player.play(video('ccccccccccc')), false);
});

test('a newer play request wins over a slow older one', async () => {
  let release: (value: Track) => void = () => undefined;
  const slow = new Promise<Track>((resolve) => (release = resolve));
  const { player, link } = setup({ slowslowslo: slow });
  const first = player.play(video('slowslowslo'));
  await tick();
  assert.equal(await player.play(video('fastfastfas')), true);
  release(track('slowslowslo'));
  assert.equal(await first, true, 'the overtaken request reports the outcome of the newer one');
  assert.deepEqual(link.calls, ['load:https://media/fastfastfas@0']);
  assert.equal(player.nowPlaying?.videoId, 'fastfastfas');
  assert.equal(player.status, STATUS.PLAYING);
});

test('a stop cancels a play request that is still looking up the video', async () => {
  let release: (value: Track) => void = () => undefined;
  const slow = new Promise<Track>((resolve) => (release = resolve));
  const { player, link } = setup({ slowslowslo: slow });
  const pending = player.play(video('slowslowslo'));
  await tick();
  await player.stop();
  release(track('slowslowslo'));
  assert.equal(await pending, false);
  assert.equal(link.calls.some((call) => call.startsWith('load')), false);
  assert.equal(player.status, STATUS.STOPPED);
});

test('pause, resume, seek and stop are forwarded and failures are reported as false', async () => {
  const { player, link } = setup();
  await player.play(video('aaaaaaaaaaa'));
  assert.equal(await player.pause(), true);
  assert.equal(await player.resume(), true);
  assert.equal(await player.seek(60), true);
  link.failNext = 'pause';
  assert.equal(await player.pause(), false);
  assert.equal(player.status, STATUS.PLAYING);
  assert.equal(await player.stop(), true);
  assert.equal(player.nowPlaying, null);
  assert.deepEqual(link.calls.slice(1), ['pause', 'resume', 'seek:60', 'pause', 'stop']);
});

test('live streams cannot be seeked', async () => {
  const { player, link } = setup({ livelivelive: track('livelivelive', { isLive: true, duration: 0 }) });
  await player.play(video('livelivelive'), 30);
  assert.deepEqual(link.calls, ['load:https://media/livelivelive@0']);
  assert.equal(await player.seek(10), false);
});

test('volume: only changes are sent, and the speaker volume is adopted', async () => {
  const { player, link } = setup();
  player.adoptDeviceVolume({ level: 0.3, muted: false });
  assert.deepEqual(await player.getVolume(), { level: 30, muted: false });
  await player.setVolume({ level: 30, muted: false });
  await player.setVolume({ level: 45, muted: false });
  await player.setVolume({ level: 45, muted: true });
  assert.deepEqual(link.calls, ['volume:0.45', 'muted:true']);
  assert.deepEqual(await player.getVolume(), { level: 45, muted: true });

  link.emit('volume', { level: 0.6, muted: false });
  await tick();
  assert.deepEqual(await player.getVolume(), { level: 60, muted: false });
});

test('pausing on the speaker itself is mirrored to the YouTube app', async () => {
  const { player, link } = setup();
  await player.play(video('aaaaaaaaaaa'));
  link.emit('playerState', 'PAUSED');
  await tick();
  assert.equal(player.status, STATUS.PAUSED);
  link.emit('playerState', 'PLAYING');
  await tick();
  assert.equal(player.status, STATUS.PLAYING);
});

test('when the track ends without a next one the player stops', async () => {
  const { player, link } = setup();
  await player.play(video('aaaaaaaaaaa'));
  link.emit('finished');
  await tick();
  assert.equal(player.status, STATUS.STOPPED);
  assert.equal(player.nowPlaying, null);
});

test('a media error restarts the track once at the last position', async () => {
  const { player, link, resolverCalls } = setup();
  await player.play(video('aaaaaaaaaaa'));
  link.emit('stopped', { reason: 'error', position: 95.7 });
  await tick();
  assert.equal(player.status, STATUS.PLAYING);
  assert.ok(resolverCalls.includes('invalidate:aaaaaaaaaaa'));
  assert.equal(link.calls.at(-1), 'load:https://media/aaaaaaaaaaa@95');

  link.emit('stopped', { reason: 'error', position: 120 });
  await tick();
  assert.equal(player.status, STATUS.STOPPED, 'second error on the same track is final');
});

test('a takeover by another app stops the player', async () => {
  const { player, link } = setup();
  await player.play(video('aaaaaaaaaaa'));
  link.emit('stopped', { reason: 'app-closed', position: 10 });
  await tick();
  assert.equal(player.status, STATUS.STOPPED);
  assert.equal(link.calls.includes('stop'), false, 'nothing of ours is left to stop');
});
