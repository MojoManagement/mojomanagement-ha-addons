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
  }

  touchDevice(device, source = 'unknown') {
    const host = device?.host;
    if (!host) return;
    const now = Date.now();
    const existing = this.records.get(host);
    this.records.set(host, { device, firstSeen: existing?.firstSeen ?? now, lastSeen: now, source });
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
      if ((now - readTimestamp(record?.lastSeen)) > this.offlineHideAfterMs * 3) this.records.delete(host);
    }
  }

  async start() {
    const tick = () => {
      try {
        if (typeof this.client.update === 'function') this.client.update();
      } catch (err) {
        this.logger.warn('Discovery update failed', err?.message ?? err);
      }
      this.refreshFromClientCache();
      this.prune();
    };
    tick();
    this.timer = setInterval(tick, this.intervalMs);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
