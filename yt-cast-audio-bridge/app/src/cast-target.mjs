const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function callDevice(device, method, ...args) {
  return new Promise((resolve, reject) => {
    if (!device || typeof device[method] !== 'function') return reject(new Error(`Method not found: ${method}`));
    device[method](...args, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

function readNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function getCurrentTime(device) {
  // NOTE:
  // chromecast-api#getCurrentTime can throw asynchronously in some sessions when
  // `player.getStatus()` resolves with an undefined status object.
  // To keep the bridge process stable we avoid that call path and read the most
  // recent known status snapshot only.
  const mediaStatus = device?.player?.status ?? device?.player?.media?.status;
  return Promise.resolve(readNumber(mediaStatus?.currentTime, 0));
}

const isNoSessionStartedError = (err) => /no session started/i.test(String(err?.message ?? err ?? ''));

export class DeviceBoundCastTarget {
  constructor({ getRecord, playRetryMs }) {
    this.getRecord = getRecord;
    this.playRetryMs = playRetryMs;
    this.owner = null;
    this.boundHosts = new Set();
  }

  attachOwner(player) {
    this.owner = player;
  }

  async waitForDevice(timeoutMs = this.playRetryMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const record = this.getRecord();
      if (record?.device) return record.device;
      await sleep(400);
    }
    return null;
  }

  async getDeviceOrWait() {
    const record = this.getRecord();
    if (record?.device) return record.device;
    const waited = await this.waitForDevice();
    if (!waited) throw new Error('Cast target offline');
    return waited;
  }

  async play(url, startTime = 0) {
    const device = await this.getDeviceOrWait();
    return startTime > 0 ? callDevice(device, 'play', url, { startTime }) : callDevice(device, 'play', url);
  }

  async pause() { return callDevice(await this.getDeviceOrWait(), 'pause'); }
  async resume() { return callDevice(await this.getDeviceOrWait(), 'resume'); }
  async seekTo(seconds) { return callDevice(await this.getDeviceOrWait(), 'seekTo', seconds); }
  async setVolume(level) { return callDevice(await this.getDeviceOrWait(), 'setVolume', Math.max(0, Math.min(1, level))); }
  async getPosition() { return getCurrentTime(await this.getDeviceOrWait()); }

  async stop() {
    try {
      await callDevice(await this.getDeviceOrWait(), 'stop');
    } catch (err) {
      if (!isNoSessionStartedError(err)) throw err;
    }
  }

  static isNoSessionStartedError(err) {
    return isNoSessionStartedError(err);
  }
}
