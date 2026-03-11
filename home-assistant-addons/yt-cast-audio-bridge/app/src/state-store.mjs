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
    } catch {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await this.save();
      this.logger.info(`State initialized at ${this.filePath}`);
    }
    return this.state;
  }

  getHost(host) {
    return this.state.hosts[host] ?? null;
  }

  setHost(host, data) {
    this.state.hosts[host] = { ...this.state.hosts[host], ...data, updatedAt: Date.now() };
  }

  setMeta(data) {
    this.state.meta = { ...this.state.meta, ...data, updatedAt: Date.now() };
  }

  async save() {
    await fs.writeFile(this.filePath, JSON.stringify(this.state, null, 2));
  }
}
