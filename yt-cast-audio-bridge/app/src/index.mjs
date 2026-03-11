#!/usr/bin/env node
import { Constants } from 'yt-cast-receiver';
import { config } from './config.mjs';
import { createLogger } from './logger.mjs';
import { StateStore } from './state-store.mjs';
import { CastDeviceRegistry } from './registry.mjs';
import { MultiBridgeSupervisor } from './bridge-supervisor.mjs';
import { startHealthServer } from './health-server.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (process.argv.includes('--help')) {
  console.log('yt-cast-audio-bridge\n\nUsage: yt-cast-audio-bridge\nStarts discovery and virtual receiver bridge.');
  process.exit(0);
}

const logger = createLogger(config.app.name, config.app.logLevel);
logger.debug('Bootstrapping bridge process', {
  pid: process.pid,
  node: process.version,
  platform: process.platform,
  argv: process.argv.slice(2),
});
const stateStore = new StateStore(config.app.stateFile, logger);
await stateStore.load();
stateStore.setMeta({ appPid: process.pid, startedAt: Date.now() });
await stateStore.save();

const registry = new CastDeviceRegistry({
  intervalMs: config.discovery.intervalMs,
  offlineHideAfterMs: config.discovery.offlineHideAfterMs,
  logger,
});

const receiverLogLevel = Constants.LOG_LEVELS[config.app.logLevel] ?? Constants.LOG_LEVELS.INFO;
const supervisor = new MultiBridgeSupervisor({ registry, stateStore, logger, config, receiverLogLevel });

logger.info(`DIAL config: basePort=${config.dial.basePort}, prefixBase=${config.dial.prefixBase}, bindToAddresses=${config.dial.bindToAddresses.join('|') || 'all'}, bindToInterfaces=${config.dial.bindToInterfaces.join('|') || 'all'}, defaultRouteIface=${config.dial.autoDetectedDefaultRouteInterface || 'n/a'}, autoDetected=${config.dial.autoDetectedInterface || 'n/a'}:${config.dial.autoDetectedAddress || 'n/a'} (candidates=${config.dial.autoDetectedCandidateCount})`);
logger.debug('Effective runtime config snapshot', {
  app: config.app,
  dial: config.dial,
  discovery: config.discovery,
  naming: config.naming,
  filters: { ...config.filters, pinnedHosts: [...config.filters.pinnedHosts] },
  resolver: {
    ytDlpBin: config.resolver.ytDlpBin,
    hasCookiesFile: Boolean(config.resolver.ytCookiesFile),
  },
});
await registry.start();
logger.info('Discovery started');
await sleep(config.discovery.startupGraceMs);
logger.debug('Startup grace period completed, running first sync');
await supervisor.sync();

const syncTimer = setInterval(() => void supervisor.sync(), config.discovery.intervalMs);
const healthServer = startHealthServer({ port: config.app.healthPort, getStatus: () => supervisor.getStatus(), logger });
logger.debug('Recurring sync timer started', { intervalMs: config.discovery.intervalMs });

async function shutdown(signal) {
  logger.info(`Stopping on ${signal}`);
  clearInterval(syncTimer);
  healthServer.close();
  await supervisor.stopAll();
  await registry.stop();
  stateStore.setMeta({ appPid: null, stoppedAt: Date.now() });
  await stateStore.save();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
