import ChromecastAPI from 'chromecast-api';

function readTimestamp(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export class CastDeviceRegistry {
  constructor({ intervalMs, offlineHideAfterMs, logger, client }) {
    this.client = client ?? new ChromecastAPI();
    this.intervalMs = intervalMs;
    this.offlineHideAfterMs = offlineHideAfterMs;
    this.logger = logger;
    this.records = new Map();
    this.timer = null;

    this.client.on('device', (device) => this.touchDevice(device, 'event'));
    this.logger?.debug?.('CastDeviceRegistry initialized', { intervalMs, offlineHideAfterMs });
  }

  touchDevice(device, source = 'unknown') {
    const host = device?.host;
    if (!host) return;
    const now = Date.now();
    const existing = this.records.get(host);
    this.records.set(host, { device, firstSeen: existing?.firstSeen ?? now, lastSeen: now, source });
    if (!existing) this.logger?.debug?.('Discovered new cast device', { host, source, name: device?.friendlyName ?? device?.name ?? '' });
  }

  refreshFromClientCache() {
    for (const device of this.client.devices ?? []) this.touchDevice(device, 'cache');
  }

  getRecord(host) {
    return this.records.get(host) ?? null;
  }

  getActiveRecords(now = Date.now()) {
    return [...this.records.values()]
      .filter((record) => (now - readTimestamp(record?.lastSeen)) <= this.offlineHideAfterMs)
      .sort((a, b) => readTimestamp(b?.lastSeen) - readTimestamp(a?.lastSeen));
  }

  getActiveDevices(now = Date.now()) {
    return this.getActiveRecords(now).map((r) => r.device).filter(Boolean);
  }

  prune() {
    const now = Date.now();
    for (const [host, record] of this.records.entries()) {
      if ((now - readTimestamp(record?.lastSeen)) > this.offlineHideAfterMs * 3) {
        this.records.delete(host);
        this.logger?.debug?.('Pruned stale device record', { host });
      }
    }
  }

  async start() {
    const tick = () => {
      const before = this.records.size;
      try {
        if (typeof this.client.update === 'function') this.client.update();
      } catch (err) {
        this.logger?.warn?.('Discovery update failed', err?.message ?? err);
      }
      this.refreshFromClientCache();
      this.prune();
      this.logger?.debug?.('Discovery tick completed', {
        recordsBefore: before,
        recordsAfter: this.records.size,
        active: this.getActiveRecords().length,
      });
    };
    tick();
    this.timer = setInterval(tick, this.intervalMs);
    this.logger?.debug?.('Discovery loop started', { intervalMs: this.intervalMs });
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.logger?.debug?.('Discovery loop stopped');
  }
}
