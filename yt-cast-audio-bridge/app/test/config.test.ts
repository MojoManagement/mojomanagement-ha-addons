import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig } from '../src/config.ts';

const defaults = { dataDir: '/tmp/x' };

test('defaults apply when nothing is configured', () => {
  const { config, warnings } = parseConfig({}, defaults);
  assert.equal(config.dialBasePort, 3000);
  assert.equal(config.onlyAudioLike, true);
  assert.equal(config.includeRegex, null);
  assert.equal(config.logLevel, 'INFO');
  assert.equal(config.dataDir, '/tmp/x');
  assert.deepEqual(warnings, []);
});

test('accepts add-on option types and env-style strings alike', () => {
  const { config, warnings } = parseConfig(
    { dial_base_port: '4000', only_audio_like: '0', pinned_hosts: '10.0.0.5, Kitchen', dial_bind_to_addresses: ['192.168.1.2'], log_level: 'debug', autoplay: false },
    defaults,
  );
  assert.equal(config.dialBasePort, 4000);
  assert.equal(config.onlyAudioLike, false);
  assert.deepEqual(config.pinnedHosts, ['10.0.0.5', 'Kitchen']);
  assert.deepEqual(config.dialBindAddresses, ['192.168.1.2']);
  assert.equal(config.logLevel, 'DEBUG');
  assert.equal(config.autoplay, false);
  assert.deepEqual(warnings, []);
});

test('invalid values fall back to defaults and are reported', () => {
  const { config, warnings } = parseConfig(
    { dial_base_port: 80, max_receivers: 'many', exclude_regex: '([', log_level: 'LOUD', only_audio_like: 'maybe' },
    defaults,
  );
  assert.equal(config.dialBasePort, 3000);
  assert.equal(config.maxReceivers, 25);
  assert.equal(config.excludeRegex, null);
  assert.equal(config.logLevel, 'INFO');
  assert.equal(config.onlyAudioLike, true);
  assert.equal(warnings.length, 5);
  assert.match(warnings.join('\n'), /exclude_regex.*not a valid regular expression/);
});

test('warns when the status port collides with the receiver port range', () => {
  const { warnings } = parseConfig({ dial_base_port: 3090, health_port: 3099 }, defaults);
  assert.match(warnings.join('\n'), /health_port/);
});

test('a missing cookies file is ignored with a warning', () => {
  const { config, warnings } = parseConfig({ yt_cookies_file: '/does/not/exist.txt' }, defaults);
  assert.equal(config.ytCookiesFile, '');
  assert.equal(warnings.length, 1);
});
