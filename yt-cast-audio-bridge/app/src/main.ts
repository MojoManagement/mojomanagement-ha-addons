import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BridgeSupervisor } from './bridge/supervisor.ts';
import { DeviceReceiver } from './bridge/receiver.ts';
import type { CastDevice } from './cast/device.ts';
import { CastDiscovery } from './cast/discovery.ts';
import { CastDeviceRegistry } from './cast/registry.ts';
import { loadConfig } from './config.ts';
import { createHttpServer } from './http.ts';
import { consoleSink, createLogger, LogBuffer } from './logger.ts';
import { resolveLanBinding } from './net.ts';
import { YtDlpManager } from './resolver/updater.ts';
import { YtDlpResolver } from './resolver/ytdlp.ts';
import { StateStore } from './state.ts';
import { errorMessage, withTimeout } from './util.ts';

const DISCOVERY_INTERVAL_MS = 20_000;
const RECONCILE_INTERVAL_MS = 10_000;
const SELF_TEST_VIDEO = 'jNQXAC9IVRw';

interface Problem {
  level: 'error' | 'warning';
  text: string;
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const version = readVersion();
  const { config, warnings } = loadConfig();
  const logBuffer = new LogBuffer(300);
  const logger = createLogger({ level: config.logLevel, sinks: [consoleSink, (entry) => logBuffer.push(entry)] });

  logger.info(`YT Cast Audio Bridge ${version} starting (Node ${process.version})`);
  for (const warning of warnings) logger.warn(warning);

  // --- crash containment -----------------------------------------------------
  // The Cast and YouTube libraries occasionally throw from deep inside socket
  // callbacks. One stray error must not take every speaker down, but a burst of
  // them means something is really broken: then exit and let the Supervisor restart us.
  const strayErrors: number[] = [];
  const onStrayError = (kind: string, err: unknown): void => {
    logger.error(`Unexpected ${kind}`, err instanceof Error ? (err.stack ?? err.message) : errorMessage(err));
    const now = Date.now();
    strayErrors.push(now);
    while (strayErrors.length && now - (strayErrors[0] ?? now) > 60_000) strayErrors.shift();
    if (strayErrors.length >= 10) {
      logger.error('Too many unexpected errors within a minute; exiting so the add-on is restarted');
      process.exit(1);
    }
  };
  process.on('uncaughtException', (err) => onStrayError('error', err));
  process.on('unhandledRejection', (err) => onStrayError('promise rejection', err));

  // --- components ------------------------------------------------------------
  const binding = resolveLanBinding(config.dialBindAddresses, config.dialBindInterfaces);
  if (binding.source === 'none') logger.error('No usable LAN address found; speakers and phones will not find the bridge');
  else logger.info(`Listening on ${binding.addresses.join(', ') || binding.interfaces.join(', ')} (${binding.source})`);

  const state = new StateStore(path.join(config.dataDir, 'state.json'), logger.child('state'));
  await state.load();

  const ytdlp = new YtDlpManager({
    explicitBin: config.ytDlpBin,
    bundledBin: process.env.YT_DLP_BUNDLED ?? 'yt-dlp',
    dataDir: config.dataDir,
    autoUpdate: config.ytDlpAutoUpdate,
    logger: logger.child('yt-dlp'),
  });
  await ytdlp.start();
  const ytdlpStatus = ytdlp.status();
  if (ytdlpStatus.working) logger.info(`Using yt-dlp ${ytdlpStatus.version} (${ytdlpStatus.source})`);

  const resolver = new YtDlpResolver({
    getBinary: () => ytdlp.binary,
    useNodeRuntime: () => ytdlp.supportsJsRuntimes,
    cookiesFile: config.ytCookiesFile,
    logger: logger.child('resolver'),
    onFailure: (count) => ytdlp.onResolveFailures(count),
  });

  const registry = new CastDeviceRegistry({
    onlineWindowMs: DISCOVERY_INTERVAL_MS * 3 + 5_000,
    forgetAfterMs: Math.max(config.offlineHideAfterMs * 3, 24 * 60 * 60 * 1000),
  });
  const discovery = new CastDiscovery({ addresses: binding.addresses, intervalMs: DISCOVERY_INTERVAL_MS, logger: logger.child('discovery') });

  const supervisor = new BridgeSupervisor({
    registry,
    state,
    config,
    bindAddresses: binding.addresses,
    bindInterfaces: binding.interfaces,
    logger,
    createReceiver: (spec) => new DeviceReceiver(spec, { resolver, state, logger: logger.child(spec.displayName) }),
  });

  let reconcileTimer: NodeJS.Timeout | null = null;
  const scheduleReconcile = (): void => {
    if (reconcileTimer) return;
    reconcileTimer = setTimeout(() => {
      reconcileTimer = null;
      supervisor.reconcile().catch((err: unknown) => logger.error('Reconcile failed', errorMessage(err)));
    }, 300);
  };

  discovery.on('device', (device: CastDevice) => {
    if (!registry.get(device.id)) logger.info(`Found ${device.isGroup ? 'speaker group' : 'Cast device'} "${device.name}" (${device.model || 'unknown model'}) at ${device.host}`);
    registry.upsert(device);
  });
  discovery.on('gone', (id: string) => registry.markGone(id));
  registry.on('change', scheduleReconcile);
  discovery.start();
  const interval = setInterval(scheduleReconcile, RECONCILE_INTERVAL_MS);

  // --- status ----------------------------------------------------------------
  const collectProblems = (): Problem[] => {
    const problems: Problem[] = warnings.map((text) => ({ level: 'warning', text }));
    const devices = supervisor.status();
    const yt = ytdlp.status();
    if (binding.source === 'none') problems.push({ level: 'error', text: 'No usable network address found. Set dial_bind_to_addresses in the add-on configuration.' });
    if (!yt.working) problems.push({ level: 'error', text: `yt-dlp is not working (${yt.binary}). Playback cannot start.` });
    else if (resolver.stats.consecutiveFailures >= 2) problems.push({ level: 'error', text: `YouTube lookups are failing: ${resolver.stats.lastError}` });
    if (yt.lastUpdateError) problems.push({ level: 'warning', text: `yt-dlp update failed: ${yt.lastUpdateError}` });
    if (Date.now() - startedAt > 30_000) {
      if (!devices.length) problems.push({ level: 'warning', text: 'No Cast devices found yet. Home Assistant and the speakers must be in the same network, and mDNS (UDP 5353) must not be blocked.' });
      else if (!devices.some((d) => d.state === 'active')) problems.push({ level: 'warning', text: 'Cast devices were found, but none is exposed. Check the reasons in the device list.' });
    }
    for (const device of devices) {
      if (device.state === 'error') problems.push({ level: 'error', text: `${device.name}: ${device.reason}` });
    }
    return problems;
  };

  const getStatus = (): unknown => {
    const devices = supervisor.status();
    return {
      version,
      startedAt,
      now: Date.now(),
      problems: collectProblems(),
      network: {
        addresses: binding.addresses,
        source: binding.source,
        candidates: binding.candidates,
        receiverPorts: devices.flatMap((d) => (d.receiver ? [d.receiver.port] : [])).sort((a, b) => a - b),
        healthPort: config.healthPort,
      },
      discovery: { lastResponseAt: discovery.lastResponseAt },
      ytdlp: { ...ytdlp.status(), stats: resolver.stats },
      devices,
      logs: logBuffer.list().slice(-150),
    };
  };

  const server = createHttpServer({
    port: config.healthPort,
    uiOpen: config.uiOpen,
    uiDir: path.join(import.meta.dirname, '..', 'ui'),
    logger: logger.child('http'),
    getHealth: () => ({
      // Healthy as long as the control loop keeps running.
      ok: Date.now() - Math.max(supervisor.lastReconcileAt, startedAt) < RECONCILE_INTERVAL_MS * 6,
      version,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      receivers: supervisor.receiverCount,
    }),
    getStatus,
    actions: {
      setDeviceEnabled: async (id, enabled) => {
        if (!registry.get(id)) throw new Error(`Unknown device ${id}`);
        supervisor.setEnabled(id, enabled);
        await supervisor.reconcile();
      },
      requestPairingCode: async (id) => {
        try {
          return { ok: true, ...(await supervisor.requestPairingCode(id)) };
        } catch (err) {
          return { ok: false, error: errorMessage(err) };
        }
      },
      rescan: async () => {
        discovery.query();
        await supervisor.reconcile();
      },
      updateYtDlp: async () => {
        const updated = await ytdlp.update();
        return { ok: !ytdlp.status().lastUpdateError, updated, ...ytdlp.status() };
      },
      selfTest: async () => {
        const began = Date.now();
        resolver.invalidate(SELF_TEST_VIDEO);
        try {
          const track = await resolver.resolve(SELF_TEST_VIDEO);
          return { ok: true, ms: Date.now() - began, title: track.title };
        } catch (err) {
          return { ok: false, ms: Date.now() - began, error: errorMessage(err) };
        }
      },
    },
  });
  server.on('error', (err) => logger.error(`Status server could not listen on port ${config.healthPort}`, errorMessage(err)));
  server.listen(config.healthPort, () => logger.info(`Status page and health check on port ${config.healthPort}`));

  // --- shutdown --------------------------------------------------------------
  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info(`Stopping (${signal})`);
    clearInterval(interval);
    if (reconcileTimer) clearTimeout(reconcileTimer);
    discovery.stop();
    ytdlp.stop();
    server.close();
    try {
      await withTimeout(supervisor.stopAll(), 8_000, 'Stopping receivers');
    } catch (err) {
      logger.warn('Receivers did not stop in time', errorMessage(err));
    }
    await state.flush();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? (err.stack ?? err.message) : errorMessage(err)}\n`);
  process.exit(1);
});
