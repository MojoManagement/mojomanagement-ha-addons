import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { silentLogger } from '../src/logger.ts';
import { findChecksum, YtDlpManager, type FetchFn } from '../src/resolver/updater.ts';
import type { ExecFn } from '../src/resolver/ytdlp.ts';

const BINARY = Buffer.from('#!/bin/sh\necho new\n');
const SUM = createHash('sha256').update(BINARY).digest('hex');

function response(body: Buffer | string, status = 200) {
  const buffer = Buffer.from(body);
  return { ok: status === 200, status, arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer };
}

async function setup(options: { sums?: string; downloadRuns?: boolean; explicitBin?: string } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ytdlp-test-'));
  const managed = path.join(dataDir, 'yt-dlp', 'yt-dlp');
  const versions: Record<string, string> = { bundled: '2026.01.01', [managed]: '', [`${managed}.download`]: options.downloadRuns === false ? '' : '2026.10.26' };
  const exec: ExecFn = async (file, args) => {
    if (args[0] === '--help') return { stdout: 'options: --js-runtimes RUNTIME', stderr: '' };
    const version = versions[file];
    if (!version) throw new Error('not runnable');
    return { stdout: `${version}\n`, stderr: '' };
  };
  const fetch: FetchFn = async (url) => (url.endsWith('SHA2-256SUMS') ? response(options.sums ?? `${SUM}  yt-dlp\nabc  yt-dlp.exe\n`) : response(BINARY));
  const manager = new YtDlpManager({ explicitBin: options.explicitBin ?? '', bundledBin: 'bundled', dataDir, autoUpdate: true, logger: silentLogger, exec, fetch });
  return { manager, managed, versions, cleanup: () => rm(dataDir, { recursive: true, force: true }) };
}

test('finds the checksum of the right asset', () => {
  const sums = `${'a'.repeat(64)}  yt-dlp.exe\n${'b'.repeat(64)}  yt-dlp\n`;
  assert.equal(findChecksum(sums, 'yt-dlp'), 'b'.repeat(64));
  assert.equal(findChecksum(sums, 'yt-dlp_linux'), null);
  assert.equal(findChecksum('short  yt-dlp', 'yt-dlp'), null);
});

test('downloads, verifies and activates a new version', async () => {
  const { manager, managed, versions, cleanup } = await setup();
  try {
    assert.equal(manager.binary, 'bundled');
    versions[managed] = '2026.10.26';
    assert.equal(await manager.update(), true);
    assert.equal(manager.binary, managed);
    assert.deepEqual(await readFile(managed), BINARY);
    const status = manager.status();
    assert.equal(status.version, '2026.10.26');
    assert.equal(status.source, 'updated');
    assert.equal(manager.supportsJsRuntimes, true);
    assert.equal(await manager.update(), false, 'already up to date');
  } finally {
    await cleanup();
  }
});

test('keeps the current version when the checksum does not match', async () => {
  const { manager, cleanup } = await setup({ sums: `${'0'.repeat(64)}  yt-dlp\n` });
  try {
    assert.equal(await manager.update(), false);
    assert.equal(manager.binary, 'bundled');
    assert.match(manager.status().lastUpdateError, /checksum/);
  } finally {
    await cleanup();
  }
});

test('keeps the current version when the download does not run', async () => {
  const { manager, cleanup } = await setup({ downloadRuns: false });
  try {
    assert.equal(await manager.update(), false);
    assert.equal(manager.binary, 'bundled');
    assert.match(manager.status().lastUpdateError, /does not run/);
  } finally {
    await cleanup();
  }
});

test('a configured binary is never replaced', async () => {
  const { manager, cleanup } = await setup({ explicitBin: 'bundled' });
  try {
    await manager.start();
    assert.equal(manager.managed, false);
    assert.equal(manager.status().source, 'configured');
    manager.onResolveFailures(5);
    assert.equal(manager.status().lastUpdateCheckAt, 0);
  } finally {
    manager.stop();
    await cleanup();
  }
});
