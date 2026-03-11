import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceBoundCastTarget } from '../src/cast-target.mjs';

test('DeviceBoundCastTarget.play retries once on transient null destroy error', async () => {
  let calls = 0;
  const device = {
    play(url, optionsOrCallback, maybeCallback) {
      calls += 1;
      const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
      if (calls === 1) {
        cb(new TypeError("Cannot read properties of null (reading 'destroy')"));
        return;
      }
      cb(null, { ok: true, url });
    },
  };

  const target = new DeviceBoundCastTarget({ getRecord: () => ({ device }), playRetryMs: 100 });
  const result = await target.play('https://example.test/audio.mp3', 0);

  assert.deepEqual(result, { ok: true, url: 'https://example.test/audio.mp3' });
  assert.equal(calls, 2);
});

test('DeviceBoundCastTarget.play does not swallow non-transient errors', async () => {
  const device = {
    play(_url, callback) {
      callback(new Error('boom'));
    },
  };

  const target = new DeviceBoundCastTarget({ getRecord: () => ({ device }), playRetryMs: 100 });
  await assert.rejects(() => target.play('https://example.test/audio.mp3', 0), /boom/);
});

test('DeviceBoundCastTarget serializes control commands to avoid stop/play overlap', async () => {
  const events = [];
  let stopCallback;

  const device = {
    stop(callback) {
      events.push('stop:start');
      stopCallback = callback;
    },
    play(_url, callback) {
      events.push('play:start');
      callback(null, 'ok');
    },
  };

  const target = new DeviceBoundCastTarget({ getRecord: () => ({ device }), playRetryMs: 100 });

  const stopPromise = target.stop();
  const playPromise = target.play('https://example.test/audio.mp3', 0);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events, ['stop:start']);

  stopCallback(null);
  await Promise.all([stopPromise, playPromise]);

  assert.deepEqual(events, ['stop:start', 'play:start']);
});
