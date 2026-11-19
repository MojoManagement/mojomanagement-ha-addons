import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { CastLink, type StoppedEvent } from '../src/cast/link.ts';
import { silentLogger } from '../src/logger.ts';
import { FakeCastDevice } from './helpers/fake-cast-device.ts';

// These tests run the real castv2-client library against a fake speaker that
// speaks the real Cast protocol over TLS on localhost.

const request = { url: 'https://example.test/audio.m4a', contentType: 'audio/mp4', title: 'Song', artist: 'Band', live: false, startTime: 0 };
const until = async (condition: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

let device: FakeCastDevice;
before(async () => {
  device = new FakeCastDevice();
  await device.listen();
});
after(() => device.close());

function connect(options: { idleReleaseMs?: number } = {}) {
  const link = new CastLink({
    getEndpoint: () => ({ host: '127.0.0.1', port: device.port }),
    logger: silentLogger,
    idleReleaseMs: options.idleReleaseMs ?? 60_000,
    recoverBaseDelayMs: 20,
  });
  const events: string[] = [];
  link.on('finished', () => events.push('finished'));
  link.on('stopped', (event: StoppedEvent) => events.push(`stopped:${event.reason}`));
  link.on('playerState', (state: string) => events.push(`state:${state}`));
  link.on('volume', (volume: { level: number }) => events.push(`volume:${volume.level}`));
  return { link, events };
}

test('plays, controls and finishes a track on a real Cast connection', async () => {
  const { link, events } = connect();
  await link.load({ ...request, startTime: 30 });
  assert.equal(device.session?.appId, 'CC1AD845');
  assert.deepEqual(device.loads.at(-1), { url: request.url, currentTime: 30, title: 'Song' });
  assert.deepEqual(link.volume, { level: 0.4, muted: false });
  assert.ok(link.getPosition() >= 30);

  await link.pause();
  assert.equal(device.media?.playerState, 'PAUSED');
  await link.seek(90);
  assert.equal(device.media?.currentTime, 90);
  await link.resume();
  assert.equal(device.media?.playerState, 'PLAYING');

  await link.setVolume(0.7);
  await link.setMuted(true);
  assert.deepEqual(device.volume, { level: 0.7, muted: true });
  await link.setMuted(false);

  events.length = 0;
  device.finishTrack();
  await until(() => events.includes('finished'), 'finished event');
  assert.deepEqual(events.filter((e) => e === 'finished' || e.startsWith('stopped')), ['finished']);

  // The next track reuses the running app instead of relaunching it.
  const launches = device.commands.filter((c) => c === 'LAUNCH').length;
  await link.load(request);
  assert.equal(device.commands.filter((c) => c === 'LAUNCH').length, launches);
  await link.close();
  assert.equal(device.session, null, 'closing the link quits our app');
});

test('mirrors pause and volume changes made on the speaker', async () => {
  const { link, events } = connect();
  await link.load(request);
  events.length = 0;
  device.setPlayerState('PAUSED', 12);
  device.setVolumeOnDevice(0.9);
  await until(() => events.includes('state:PAUSED') && events.includes('volume:0.9'), 'mirrored events');
  assert.equal(Math.round(link.getPosition()), 12);
  await link.close();
});

test('reports a media error and a takeover by another app', async () => {
  const { link, events } = connect();
  await link.load(request);
  device.failTrack();
  await until(() => events.includes('stopped:error'), 'error event');

  await link.load(request);
  device.launchOtherApp();
  await until(() => events.includes('stopped:app-closed'), 'takeover event');
  await link.close();
  assert.equal(device.session?.appId, 'OTHER', 'the other app is left alone');
  device.session = null;
});

test('survives a dropped connection while the speaker keeps playing', async () => {
  const { link, events } = connect();
  await link.load(request);
  events.length = 0;
  device.dropConnections();
  await until(() => link.connected, 'reconnect');
  assert.deepEqual(events.filter((e) => e.startsWith('stopped')), []);
  await link.pause();
  assert.equal(device.media?.playerState, 'PAUSED');
  await link.close();
});

test('stop ends our media, and an idle speaker is released', async () => {
  const { link } = connect({ idleReleaseMs: 50 });
  await link.load(request);
  await link.stop();
  assert.equal(device.media, null);
  await until(() => device.session === null && !link.connected, 'idle release');
  await link.close();
});
