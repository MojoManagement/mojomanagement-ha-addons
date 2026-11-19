import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { silentLogger } from '../src/logger.ts';
import { StateStore } from '../src/state.ts';

async function withDir(run: (file: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'state-test-'));
  try {
    await run(path.join(dir, 'nested', 'state.json'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('persists device data across restarts', () =>
  withDir(async (file) => {
    const store = new StateStore(file, silentLogger);
    await store.load();
    store.update('a', { port: 3000 });
    store.update('a', { disabled: true });
    store.setStoreValue('a', 'app.pid', 'xyz');
    await store.flush();

    const again = new StateStore(file, silentLogger);
    await again.load();
    assert.deepEqual(again.get('a'), { port: 3000, disabled: true, store: { 'app.pid': 'xyz' } });
    assert.equal(again.getStoreValue('a', 'app.pid'), 'xyz');
    assert.equal(again.getStoreValue('a', 'missing'), null);
    assert.deepEqual(again.get('unknown'), {});
  }));

test('a corrupt or outdated file is set aside instead of crashing', () =>
  withDir(async (file) => {
    const store = new StateStore(file, silentLogger);
    await store.load();
    await writeFile(file, '{"hosts": {"10.0.0.1": {"port": 3000}}');
    await store.load();
    assert.deepEqual(store.entries(), []);
    assert.match(await readFile(`${file}.corrupt`, 'utf8'), /hosts/);
  }));
