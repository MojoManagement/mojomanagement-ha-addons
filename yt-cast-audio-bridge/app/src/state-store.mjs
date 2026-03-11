import fs from 'node:fs/promises';
import path from 'node:path';

export class StateStore {
  constructor(filePath, logger) {
    this.filePath = filePath;
    this.logger = logger;
    this.state = { hosts: {}, meta: {} };
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      this.state = JSON.parse(raw);
      this.logger.info(`State loaded from ${this.filePath}`);
      this.logger.debug('State payload loaded', {
        hosts: Object.keys(this.state.hosts ?? {}).length,
        metaKeys: Object.keys(this.state.meta ?? {}),
      });
    } catch {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await this.save();
      this.logger.info(`State initialized at ${this.filePath}`);
      this.logger.debug('State file missing/corrupt; initialized new state', { filePath: this.filePath });
    }
    return this.state;
  }

  getHost(host) {
    return this.state.hosts[host] ?? null;
  }

  setHost(host, data) {
    this.state.hosts[host] = { ...this.state.hosts[host], ...data, updatedAt: Date.now() };
    this.logger.debug('Host state updated', { host, keys: Object.keys(data ?? {}) });
  }

  setMeta(data) {
    this.state.meta = { ...this.state.meta, ...data, updatedAt: Date.now() };
    this.logger.debug('Meta state updated', { keys: Object.keys(data ?? {}) });
  }

  async save() {
    await fs.writeFile(this.filePath, JSON.stringify(this.state, null, 2));
    this.logger.debug('State file saved', {
      filePath: this.filePath,
      hosts: Object.keys(this.state.hosts ?? {}).length,
      metaKeys: Object.keys(this.state.meta ?? {}),
    });
  }
}
