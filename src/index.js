import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import cron from 'node-cron';
import { loadConfig, ConfigError } from './config.js';
import { readSettings, writeSettings, updateSettings } from './settings.js';
import { createLogger } from './logger.js';
import { createTokenStore } from './tokens.js';
import { createStateStore } from './state.js';
import { readJson } from './store.js';
import { createSpotifyAdapter } from './platforms/spotify.js';
import { createTidalAdapter } from './platforms/tidal.js';
import { createMatcher } from './match.js';
import { createSyncEngine } from './sync.js';
import { writeHealth } from './health.js';
import { AuthRequiredError } from './http.js';

const VERSION = readJson(new URL('../package.json', import.meta.url).pathname, {}).version ?? 'dev';

const SETTINGS_FIELDS = {
  spotify: ['clientId', 'clientSecret', 'market', 'playlistPublic'],
  tidal: ['clientId', 'clientSecret', 'accessType'],
  sync: ['mode', 'source', 'pairs', 'periodic', 'cron', 'onStart', 'tz', 'dryRun', 'matchRetryRuns'],
};

/** Keep only known fields; a blank clientSecret means "keep the stored one". */
function sanitizeSettingsPatch(patch) {
  const out = {};
  for (const [section, fields] of Object.entries(SETTINGS_FIELDS)) {
    if (!patch[section] || typeof patch[section] !== 'object') continue;
    const clean = {};
    for (const field of fields) {
      const value = patch[section][field];
      if (value === undefined) continue;
      if (field === 'clientSecret' && value === '') continue;
      clean[field] = value;
    }
    if (Object.keys(clean).length > 0) out[section] = clean;
  }
  if (typeof patch.logLevel === 'string') out.logLevel = patch.logLevel;
  return out;
}

function mergeSettings(current, patch) {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    next[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? { ...current[key], ...value }
      : value;
  }
  return next;
}

/**
 * The runtime owns config, adapters, engine, scheduling, and service phase.
 * The web panel mutates it via applySettings/triggerSync; everything reads
 * through accessors so panel-applied settings take effect without restart.
 */
export function createRuntime({ env = process.env } = {}) {
  const configDir = env.CONFIG_DIR ?? '/config';
  let settings = readSettings(configDir);
  let config = loadConfig(env, settings); // ConfigError on malformed values is fatal upstream
  const logger = createLogger(config.logLevel);
  const log = logger.child('service');
  const tokens = createTokenStore(configDir, logger.child('tokens'));
  const state = createStateStore(configDir, logger.child('state'));

  let adapters;
  let engine;
  function build() {
    adapters = {
      spotify: createSpotifyAdapter({ config, tokens, logger }),
      tidal: createTidalAdapter({ config, tokens, logger }),
    };
    const overrides = readJson(path.join(configDir, 'overrides.json'), {}, logger.child('overrides'));
    const matcher = createMatcher({ adapters, state, overrides, logger, retryRuns: config.sync.matchRetryRuns });
    engine = createSyncEngine({ config, adapters, state, matcher, logger });
  }
  build();

  let inFlight = null;
  let authRequired = false;
  let authRequiredPlatform = null;
  let tokensMtimeAtAuthError = 0;
  let scheduledTask = null;
  let lastRunError = null;

  const tokensMtime = () => {
    try {
      return fs.statSync(tokens.file).mtimeMs;
    } catch {
      return 0;
    }
  };
  const connected = (platform) => Boolean(tokens.get(platform)?.refreshToken);
  const ready = () => config.incomplete.length === 0 && connected('spotify') && connected('tidal');
  const needsSetup = () => !settings.setupComplete && !ready();

  function phase() {
    if (inFlight) return 'syncing';
    if (authRequired) return 'auth_required';
    if (!ready()) return 'setup';
    return 'idle';
  }

  function writePhaseHealth() {
    const current = phase();
    if (current === 'setup') writeHealth(configDir, { status: 'SETUP', at: new Date().toISOString() });
    else if (current === 'auth_required') {
      writeHealth(configDir, { status: 'AUTH_REQUIRED', platform: authRequiredPlatform, at: new Date().toISOString() });
    }
  }

  async function runOnce(trigger) {
    // cron's noOverlap only covers cron-triggered executions; this guard also
    // protects panel/startup runs from overlapping with a cron tick.
    if (inFlight) {
      log.warn(`previous sync still in progress, skipping ${trigger} trigger`);
      return;
    }
    if (!ready()) {
      log.warn(`sync skipped (${trigger}): configuration or account connection incomplete`);
      return;
    }
    if (authRequired) {
      if (tokensMtime() === tokensMtimeAtAuthError) {
        log.error('sync suspended: authorization expired — reconnect the account in the web panel');
        return;
      }
      authRequired = false; // tokens changed on disk; try again
      log.info('tokens changed, resuming syncs');
    }

    const spotifyAuth = adapters.spotify.describeAuth();
    if (spotifyAuth.warn) {
      log.warn(`Spotify authorization expires in ~${spotifyAuth.daysLeft} days — refresh tokens hard-expire 6 months after consent; reconnect soon`, { authorizedAt: spotifyAuth.authorizedAt });
    }

    log.info(`sync run starting (${trigger})`);
    inFlight = (async () => {
      try {
        await engine.runSync();
        lastRunError = null;
        writeHealth(configDir, {
          status: 'OK',
          lastOkAt: new Date().toISOString(),
          periodic: config.sync.periodic,
          nextDueMs: scheduledTask?.msToNext?.() ?? null,
        });
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          authRequired = true;
          authRequiredPlatform = err.platform;
          tokensMtimeAtAuthError = tokensMtime();
          writePhaseHealth();
          log.error(`AUTHORIZATION REQUIRED for ${err.platform}: ${err.message}`);
          log.error('musicsync keeps running but will not sync until you reconnect.');
        } else {
          lastRunError = String(err);
          log.error('sync run failed', { error: String(err.stack ?? err) });
        }
      } finally {
        inFlight = null;
      }
    })();
    await inFlight;
  }

  function scheduleCron() {
    if (scheduledTask) {
      scheduledTask.destroy();
      scheduledTask = null;
    }
    if (!config.sync.periodic || !ready()) return;
    scheduledTask = cron.schedule(config.sync.cron, () => runOnce('cron'), {
      timezone: config.sync.tz,
      noOverlap: true,
    });
    log.info('scheduled', {
      cron: config.sync.cron,
      tz: config.sync.tz ?? 'system',
      mode: config.sync.mode,
      nextRun: scheduledTask.getNextRun()?.toISOString(),
    });
  }

  const runtime = {
    logger,
    tokens,
    state,
    configDir,
    config: () => config,
    adapters: () => adapters,
    engine: () => engine,
    settings: () => settings,
    phase,
    ready,
    connected,
    runOnce,
    scheduleCron,
    writePhaseHealth,

    triggerSync(trigger) {
      if (inFlight) return { busy: true };
      if (!ready()) return { blocked: 'configuration or account connection is incomplete' };
      void runOnce(trigger);
      return { started: true };
    },

    async applySettings(patch) {
      const clean = sanitizeSettingsPatch(patch);
      const candidateSettings = mergeSettings(settings, clean);
      const candidate = loadConfig(env, candidateSettings); // throws ConfigError with problems
      writeSettings(configDir, candidateSettings);
      settings = candidateSettings;
      config = candidate;
      build();
      scheduleCron();
      writePhaseHealth();
      log.info('settings applied from panel', { incomplete: config.incomplete });
      return config;
    },

    async completeSetup() {
      settings = updateSettings(configDir, { setupComplete: true });
      config = loadConfig(env, settings);
      build();
      scheduleCron();
      log.info('setup completed');
    },

    onConnected() {
      authRequired = false;
      if (ready()) scheduleCron();
    },

    overview() {
      const pairs = Object.entries(state.data.pairs).map(([primaryId, ps]) => ({
        primaryId,
        name: ps.name ?? null,
        spotifyPlaylistId: ps.spotifyPlaylistId ?? null,
        tidalPlaylistId: ps.tidalPlaylistId ?? null,
        lastResult: ps.lastResult ?? null,
        lastSyncedAt: ps.lastSyncedAt ?? null,
        unmatchedCount: ps.unmatchedCount ?? 0,
      }));
      return {
        version: VERSION,
        needsSetup: needsSetup(),
        incomplete: config.incomplete,
        phase: phase(),
        syncing: Boolean(inFlight),
        lastRunError,
        mode: config.sync.mode,
        source: config.sync.source,
        periodic: config.sync.periodic,
        cron: config.sync.cron,
        tz: config.sync.tz ?? null,
        dryRun: config.sync.dryRun,
        nextRun: scheduledTask?.getNextRun()?.toISOString() ?? null,
        connections: {
          spotify: { connected: connected('spotify'), ...adapters.spotify.describeAuth() },
          tidal: { connected: connected('tidal'), ...adapters.tidal.describeAuth() },
        },
        configuredPairs: config.sync.pairs === 'all' ? 'all' : config.sync.pairs.length,
        pairs,
        unmatchedTotal: Object.keys(state.data.failures).length,
        runCount: state.data.runCount,
      };
    },

    unmatchedReport() {
      return readJson(state.reportFile, { generatedAt: null, unmatched: [] });
    },

    async shutdown() {
      await cron.shutdown(10_000);
      if (inFlight) await inFlight;
      state.save();
    },
  };
  return runtime;
}

export async function main() {
  let runtime;
  try {
    runtime = createRuntime();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
  const config = runtime.config();
  const log = runtime.logger.child('service');

  // The web panel IS the product surface — no panel, no service.
  if (!config.panel.enabled) {
    process.stderr.write('musicsync requires the web panel: set WEB_PANEL_PASSWORD (or WEB_PANEL_BYPASS_AUTH=true for trusted networks) and restart.\n');
    process.exit(1);
  }

  log.info(`musicsync v${VERSION} starting`, { mode: config.sync.mode });
  const { createWebServer } = await import('./web/server.js');
  const webServer = createWebServer({ runtime, logger: runtime.logger }).start();

  if (!runtime.ready()) {
    runtime.writePhaseHealth();
    log.info(`setup needed — open the web panel at http://127.0.0.1:${config.panel.port} to finish configuration`);
  } else {
    runtime.scheduleCron();
    if (config.sync.onStart) await runtime.runOnce('startup');
    else if (!config.sync.periodic) log.info('periodic sync is off — trigger runs from the panel');
  }

  async function shutdown(signal) {
    log.info(`${signal} received, shutting down`);
    try {
      await runtime.shutdown();
      if (webServer) await new Promise((resolve) => webServer.close(resolve));
    } catch (err) {
      log.error('shutdown error', { error: String(err) });
    }
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
