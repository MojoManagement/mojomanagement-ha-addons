import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { CastLink, NoSessionError, type CastClientLike, type CastSessionInfo, type LoadRequest, type MediaStatus, type StoppedEvent } from '../src/cast/link.ts';
import { silentLogger } from '../src/logger.ts';

type Cb<T> = (err: unknown, result?: T) => void;

class FakeApp extends EventEmitter {
  session: CastSessionInfo = { appId: 'CC1AD845', sessionId: 's1' };
  calls: string[] = [];
  nextMediaSessionId = 1;
  loadError: Error | null = null;
  current: MediaStatus | undefined;

  load(_media: object, options: { currentTime?: number }, cb: Cb<MediaStatus>): void {
    this.calls.push(`load@${options.currentTime ?? 0}`);
    if (this.loadError) return cb(this.loadError);
    this.current = { mediaSessionId: this.nextMediaSessionId++, playerState: 'PLAYING', currentTime: options.currentTime ?? 0, playbackRate: 1 };
    cb(null, this.current);
  }
  play(cb: Cb<MediaStatus>): void { this.#set('play', 'PLAYING', cb); }
  pause(cb: Cb<MediaStatus>): void { this.#set('pause', 'PAUSED', cb); }
  stop(cb: Cb<MediaStatus>): void { this.#set('stop', 'IDLE', cb); }
  seek(seconds: number, cb: Cb<MediaStatus>): void {
    if (this.current) this.current = { ...this.current, currentTime: seconds };
    this.#set(`seek:${seconds}`, this.current?.playerState ?? 'PLAYING', cb);
  }
  getStatus(cb: Cb<MediaStatus | undefined>): void { this.calls.push('getStatus'); cb(null, this.current); }
  #set(call: string, state: MediaStatus['playerState'], cb: Cb<MediaStatus>): void {
    this.calls.push(call);
    if (!this.current) return cb(new Error('no media'));
    this.current = { ...this.current, playerState: state };
    cb(null, this.current);
  }
}

class FakeClient extends EventEmitter {
  app = new FakeApp();
  sessions: CastSessionInfo[] = [];
  calls: string[] = [];
  connectMode: 'ok' | 'error' | 'hang' = 'ok';
  volume = { level: 0.3, muted: false };
  closed = false;

  connect(_options: object, cb: () => void): void {
    this.calls.push('connect');
    if (this.connectMode === 'ok') queueMicrotask(cb);
    else if (this.connectMode === 'error') queueMicrotask(() => this.emit('error', new Error('ECONNREFUSED')));
  }
  close(): void { this.closed = true; }
  getStatus(cb: Cb<object>): void { cb(null, { volume: this.volume, applications: this.sessions }); }
  getSessions(cb: Cb<CastSessionInfo[]>): void { cb(null, this.sessions); }
  launch(_app: unknown, cb: Cb<FakeApp>): void { this.calls.push('launch'); this.sessions = [this.app.session]; cb(null, this.app); }
  join(_session: CastSessionInfo, _app: unknown, cb: Cb<FakeApp>): void { this.calls.push('join'); cb(null, this.app); }
  stop(_app: unknown, cb: Cb<unknown>): void { this.calls.push('quit'); this.sessions = []; cb(null, []); }
  setVolume(volume: { level?: number; muted?: boolean }, cb: Cb<object>): void {
    this.calls.push(`volume:${JSON.stringify(volume)}`);
    this.volume = { ...this.volume, ...volume };
    cb(null, this.volume);
  }
}

const request: LoadRequest = { url: 'https://example/a.m4a', contentType: 'audio/mp4', title: 'Song', live: false, startTime: 0 };
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

function setup(overrides: { online?: boolean } = {}) {
  const clients: FakeClient[] = [];
  let prepare: (client: FakeClient) => void = () => undefined;
  const link = new CastLink({
    getEndpoint: () => (overrides.online === false ? null : { host: '10.0.0.5', port: 8009 }),
    logger: silentLogger,
    createClient: () => {
      const client = new FakeClient();
      prepare(client);
      clients.push(client);
      return client as unknown as CastClientLike;
    },
    idleReleaseMs: 30,
    connectTimeoutMs: 40,
    requestTimeoutMs: 40,
    loadTimeoutMs: 40,
    recoverBaseDelayMs: 5,
    recoverAttempts: 2,
  });
  const events: string[] = [];
  link.on('finished', () => events.push('finished'));
  link.on('stopped', (event: StoppedEvent) => events.push(`stopped:${event.reason}`));
  link.on('playerState', (state: string) => events.push(`state:${state}`));
  link.on('volume', (volume: { level: number }) => events.push(`volume:${volume.level}`));
  return { link, clients, events, onNewClient: (fn: (client: FakeClient) => void) => (prepare = fn) };
}

test('load connects, launches the media app and reports the device volume', async () => {
  const { link, clients, events } = setup();
  await link.load({ ...request, startTime: 42 });
  const client = clients[0];
  assert.deepEqual(client?.calls, ['connect', 'launch']);
  assert.deepEqual(client?.app.calls, ['load@42', 'getStatus']);
  assert.deepEqual(link.volume, { level: 0.3, muted: false });
  assert.ok(link.getPosition() >= 42);
  assert.deepEqual(events, ['volume:0.3']);
  await link.close();
});

test('reuses the connection for the next track and joins an existing session', async () => {
  const { link, clients } = setup();
  await link.load(request);
  await link.load(request);
  assert.equal(clients.length, 1);
  assert.deepEqual(clients[0]?.app.calls, ['load@0', 'getStatus', 'load@0', 'getStatus']);
  await link.close();
});

test('forwards pause, resume, seek and volume', async () => {
  const { link, clients } = setup();
  await link.load(request);
  await link.pause();
  await link.seek(30);
  await link.resume();
  await link.setVolume(0.8);
  await link.setMuted(true);
  assert.deepEqual(clients[0]?.app.calls, ['load@0', 'getStatus', 'pause', 'seek:30', 'play']);
  assert.deepEqual(clients[0]?.calls.slice(2), ['volume:{"level":0.8}', 'volume:{"muted":true}']);
  assert.deepEqual(link.volume, { level: 0.8, muted: true });
  await link.close();
});

test('reports finished, external pause and external stop for our media only', async () => {
  const { link, clients, events } = setup();
  await link.load(request);
  const app = clients[0]!.app;
  events.length = 0;
  app.emit('status', { mediaSessionId: 99, playerState: 'IDLE', idleReason: 'FINISHED' });
  app.emit('status', { mediaSessionId: 1, playerState: 'BUFFERING' });
  app.emit('status', { mediaSessionId: 1, playerState: 'PAUSED', currentTime: 10 });
  app.emit('status', { mediaSessionId: 1, playerState: 'PLAYING', currentTime: 10 });
  app.emit('status', { mediaSessionId: 1, playerState: 'IDLE', idleReason: 'FINISHED' });
  app.emit('status', { mediaSessionId: 1, playerState: 'IDLE', idleReason: 'FINISHED' });
  assert.deepEqual(events, ['state:PAUSED', 'state:PLAYING', 'finished']);

  await link.load(request);
  events.length = 0;
  app.emit('status', { mediaSessionId: 2, playerState: 'IDLE', idleReason: 'ERROR' });
  assert.deepEqual(events, ['stopped:error']);
  await link.close();
});

test('notices when another app takes over the speaker', async () => {
  const { link, clients, events } = setup();
  await link.load(request);
  events.length = 0;
  clients[0]!.emit('status', { applications: [{ appId: 'SPOTIFY', sessionId: 'other' }], volume: { level: 0.3, muted: false } });
  assert.deepEqual(events, ['stopped:app-closed']);
  await link.close();
});

test('device volume changes are reported once', async () => {
  const { link, clients, events } = setup();
  await link.load(request);
  events.length = 0;
  clients[0]!.emit('status', { applications: [clients[0]!.app.session], volume: { level: 0.5, muted: false } });
  clients[0]!.emit('status', { applications: [clients[0]!.app.session], volume: { level: 0.5, muted: false } });
  assert.deepEqual(events, ['volume:0.5']);
  await link.close();
});

test('an offline or unreachable device fails fast instead of hanging', async () => {
  const offline = setup({ online: false });
  await assert.rejects(offline.link.load(request), /offline/);

  const refused = setup();
  refused.onNewClient((client) => (client.connectMode = 'error'));
  await assert.rejects(refused.link.load(request), /ECONNREFUSED/);
  assert.equal(refused.clients[0]?.closed, true);

  const hanging = setup();
  hanging.onNewClient((client) => (client.connectMode = 'hang'));
  await assert.rejects(hanging.link.load(request), /timed out/);
  assert.equal(hanging.link.connected, false);
});

test('a stale connection is replaced and the command retried once', async () => {
  const { link, clients } = setup();
  await link.load(request);
  clients[0]!.app.load = () => undefined; // device no longer answers
  await link.load(request);
  assert.equal(clients.length, 2);
  assert.equal(clients[0]?.closed, true);
  assert.deepEqual(clients[1]?.app.calls, ['load@0', 'getStatus']);
  await link.close();
});

test('a rejected load is not retried', async () => {
  const { link, clients } = setup();
  await link.load(request);
  clients[0]!.app.loadError = new Error('Load failed');
  await assert.rejects(link.load(request), /Load failed/);
  assert.equal(clients.length, 1);
  await link.close();
});

test('after a connection drop it rejoins and keeps the session when playback continues', async () => {
  const { link, clients, events, onNewClient } = setup();
  await link.load(request);
  const first = clients[0]!;
  events.length = 0;
  onNewClient((client) => {
    client.sessions = [first.app.session];
    client.app.current = { mediaSessionId: 1, playerState: 'PLAYING', currentTime: 55, playbackRate: 1 };
  });
  first.emit('error', new Error('Device timeout'));
  await tick(30);
  assert.equal(clients.length, 2);
  assert.deepEqual(clients[1]?.calls, ['connect', 'join']);
  assert.deepEqual(events, []);
  assert.ok(link.getPosition() >= 55);
  await link.close();
});

test('after a connection drop it reports the stop when the session is gone', async () => {
  const { link, clients, events } = setup();
  await link.load(request);
  events.length = 0;
  clients[0]!.emit('error', new Error('Device timeout'));
  await tick(30);
  assert.deepEqual(events.filter((e) => e.startsWith('stopped')), ['stopped:session-lost']);
  await link.close();
});

test('stop never throws and the idle speaker is released', async () => {
  const { link, clients } = setup();
  await link.load(request);
  await link.stop();
  assert.deepEqual(clients[0]?.app.calls, ['load@0', 'getStatus', 'stop']);
  await tick(60);
  assert.ok(clients[0]?.calls.includes('quit'));
  assert.equal(link.connected, false);
  await link.stop();
});

test('the idle release leaves a session alone that someone else is using', async () => {
  const { link, clients } = setup();
  await link.load(request);
  await link.stop();
  clients[0]!.app.current = { mediaSessionId: 7, playerState: 'PLAYING' };
  await tick(60);
  assert.equal(clients[0]?.calls.includes('quit'), false);
  assert.equal(link.connected, false);
});

test('commands without a session fail with a clear error', async () => {
  const { link } = setup();
  await assert.rejects(link.pause(), NoSessionError);
  await link.close();
});
