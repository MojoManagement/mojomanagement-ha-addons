import { DeviceReceiver } from './device-receiver.mjs';

function safeRegex(value) {
  if (!value) return null;
  try { return new RegExp(value, 'i'); } catch { return null; }
}

function slugify(input) {
  return String(input ?? '').normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'device';
}

function looksAudioLike(device, onlyAudioLike) {
  const text = [device?.friendlyName, device?.name, device?.host, device?.model, device?.displayName].filter(Boolean).join(' ');
  const audioHints = /(speaker|soundbar|audio|jbl|sonos|marshall|bose|harman|denon|yamaha|heos)/i;
  const videoHints = /(tv|display|monitor|shield|roku|fire tv|google tv|chromecast(?! audio)|hub|max)/i;
  if (audioHints.test(text)) return true;
  if (videoHints.test(text)) return false;
  return !onlyAudioLike;
}

export class MultiBridgeSupervisor {
  constructor({ registry, stateStore, logger, config, receiverLogLevel }) {
    this.registry = registry;
    this.stateStore = stateStore;
    this.logger = logger;
    this.config = config;
    this.receiverLogLevel = receiverLogLevel;
    this.instances = new Map();
    this.syncing = false;
    this.nextPort = config.dial.basePort;
    this.includeRegex = safeRegex(config.filters.includeRegex);
    this.excludeRegex = safeRegex(config.filters.excludeRegex);
    this.logger.debug('MultiBridgeSupervisor initialized', {
      maxReceivers: config.discovery.maxReceivers,
      playRetryMs: config.discovery.playRetryMs,
      includeRegex: config.filters.includeRegex,
      excludeRegex: config.filters.excludeRegex,
      allowDuplicateFriendlyNames: config.naming.allowDuplicateFriendlyNames,
    });
  }

  allocatePort(host) {
    const existing = this.stateStore.getHost(host)?.port;
    if (Number.isFinite(existing)) {
      this.logger.debug('Reusing persisted receiver port', { host, port: existing });
      return existing;
    }
    const port = this.nextPort++;
    this.stateStore.setHost(host, { port });
    this.logger.debug('Allocated new receiver port', { host, port });
    return port;
  }

  shouldExpose(device, seenFriendlyNames) {
    const { pinnedHosts, onlyAudioLike } = this.config.filters;
    const host = device?.host || '';
    const name = String(device?.friendlyName ?? '').trim();
    const identity = `${name} ${host}`.trim();
    if (!name || !host) return false;
    if (pinnedHosts.length && !pinnedHosts.includes(host)) return false;
    if (this.includeRegex && !this.includeRegex.test(identity)) return false;
    if (this.excludeRegex && this.excludeRegex.test(identity)) return false;
    if (!looksAudioLike(device, onlyAudioLike)) return false;
    if (!this.config.naming.allowDuplicateFriendlyNames) {
      if (seenFriendlyNames.has(name)) return false;
      seenFriendlyNames.add(name);
    }
    return true;
  }

  buildCandidates() {
    const seenFriendlyNames = new Set();
    const all = this.registry.getActiveDevices();
    const candidates = all
      .filter((d) => this.shouldExpose(d, seenFriendlyNames))
      .slice(0, this.config.discovery.maxReceivers);
    this.logger.debug('Built receiver candidate list', {
      discovered: all.length,
      selected: candidates.length,
      selectedHosts: candidates.map((d) => d.host),
    });
    return candidates;
  }

  async sync() {
    if (this.syncing) {
      this.logger.debug('Skipping sync because previous run is still in progress');
      return;
    }
    this.syncing = true;
    try {
      const now = Date.now();
      const candidates = this.buildCandidates();
      const desiredHosts = new Set(candidates.map((d) => d.host));
      this.logger.debug('Sync cycle started', { desiredHosts: [...desiredHosts], activeInstances: this.instances.size });

      for (const device of candidates) {
        const host = device.host;
        if (this.instances.has(host)) {
          this.instances.get(host).firstMissingAt = null;
          this.logger.debug('Receiver already running; keeping instance', { host });
          continue;
        }

        const baseName = String(device.friendlyName ?? host).trim();
        const visibleName = this.config.naming.allowDuplicateFriendlyNames ? `${baseName} (${host})` : baseName;
        const receiver = new DeviceReceiver({
          port: this.allocatePort(host),
          dialPrefix: `${this.config.dial.prefixBase}/${slugify(host)}`,
          dialBindToAddresses: this.config.dial.bindToAddresses,
          dialBindToInterfaces: this.config.dial.bindToInterfaces,
          virtualName: `${this.config.naming.bridgeNamePrefix} ${visibleName}`.trim(),
          screenName: `${this.config.naming.bridgeScreenPrefix} ${visibleName}`.trim(),
          host,
          registry: this.registry,
          label: visibleName,
          logger: this.logger,
          logLevel: this.receiverLogLevel,
          resolverConfig: this.config.resolver,
          playRetryMs: this.config.discovery.playRetryMs,
        });
        await receiver.start();
        this.instances.set(host, { receiver, firstMissingAt: null });
        this.logger.info(`Receiver started for ${visibleName} (${host})`);
      }

      for (const [host, state] of [...this.instances.entries()]) {
        if (desiredHosts.has(host)) continue;
        if (!state.firstMissingAt) state.firstMissingAt = now;
        const record = this.registry.getRecord(host);
        const age = record ? now - record.lastSeen : Infinity;
        const missingFor = now - state.firstMissingAt;
        const busy = state.receiver.activeSenders > 0;
        if (busy || age < this.config.discovery.offlineHideAfterMs || missingFor < this.config.discovery.offlineHideAfterMs) {
          this.logger.debug('Keeping receiver despite missing candidate', { host, busy, age, missingFor });
          continue;
        }
        await state.receiver.stop();
        this.instances.delete(host);
        this.logger.info(`Receiver removed for ${host}`);
      }

      this.stateStore.setMeta({ instanceCount: this.instances.size });
      await this.stateStore.save();
      this.logger.debug('Sync cycle completed', { activeInstances: this.instances.size });
    } finally {
      this.syncing = false;
    }
  }

  async stopAll() {
    this.logger.debug('Stopping all receivers', { count: this.instances.size });
    for (const [, state] of this.instances.entries()) await state.receiver.stop();
    this.instances.clear();
  }

  getStatus() {
    return {
      instanceCount: this.instances.size,
      receivers: [...this.instances.entries()].map(([host, state]) => ({ host, activeSenders: state.receiver.activeSenders })),
    };
  }
}
