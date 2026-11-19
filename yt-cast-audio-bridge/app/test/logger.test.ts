import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLogger, LogBuffer, type LogEntry } from '../src/logger.ts';
import { backoffDelay, redactSecrets, SerialQueue, withTimeout } from '../src/util.ts';

test('respects the log level and scopes child loggers', () => {
  const entries: LogEntry[] = [];
  const logger = createLogger({ level: 'INFO', sinks: [(entry) => entries.push(entry)] });
  logger.debug('hidden');
  logger.child('cast').warn('visible', new Error('boom'));
  logger.info('with data', { port: 3000 });
  assert.deepEqual(entries.map((e) => [e.level, e.scope, e.message]), [
    ['WARN', 'bridge:cast', 'visible (boom)'],
    ['INFO', 'bridge', 'with data {"port":3000}'],
  ]);
});

test('secrets never reach the log', () => {
  const entries: LogEntry[] = [];
  const logger = createLogger({ level: 'DEBUG', sinks: [(entry) => entries.push(entry)] });
  logger.debug("Obtained lounge token: { screenId: 'abc', loungeToken: 'EXAMPLE-token-0123456789abcdefghij' }");
  logger.info('Loading https://rr4---sn-x.googlevideo.com/videoplayback?expire=1&sig=SECRET now');
  assert.equal(entries[0]?.message, "Obtained lounge token: { screenId: 'abc', loungeToken: '<redacted>' }");
  assert.equal(entries[1]?.message, 'Loading <media-url> now');
  assert.equal(redactSecrets('lounge_token=EXAMPLE-token-0123456789'), 'lounge_token=<redacted>');
});

test('the log buffer keeps only the newest entries', () => {
  const buffer = new LogBuffer(2);
  for (const message of ['a', 'b', 'c']) buffer.push({ time: '', level: 'INFO', scope: '', message });
  assert.deepEqual(buffer.list().map((e) => e.message), ['b', 'c']);
});

test('helpers: timeout, serial queue and backoff', async () => {
  await assert.rejects(withTimeout(new Promise(() => undefined), 10, 'Thing'), /Thing timed out after 10 ms/);
  assert.equal(await withTimeout(Promise.resolve(5), 10, 'x'), 5);

  const queue = new SerialQueue();
  const order: string[] = [];
  const slow = queue.run(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
    order.push('slow');
    throw new Error('fails');
  });
  const fast = queue.run(async () => order.push('fast'));
  await assert.rejects(slow, /fails/);
  await fast;
  assert.deepEqual(order, ['slow', 'fast'], 'a failing task does not block the next one');

  assert.deepEqual([1, 2, 3, 10].map((n) => backoffDelay(n, 5000, 300000)), [5000, 10000, 20000, 300000]);
});
