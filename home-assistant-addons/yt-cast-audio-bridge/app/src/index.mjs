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

await registry.start();
logger.info('Discovery started');
await sleep(config.discovery.startupGraceMs);
await supervisor.sync();

const syncTimer = setInterval(() => void supervisor.sync(), config.discovery.intervalMs);
const healthServer = startHealthServer({ port: config.app.healthPort, getStatus: () => supervisor.getStatus(), logger });

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
