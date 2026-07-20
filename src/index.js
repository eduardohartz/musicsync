import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import cron from 'node-cron';
import { loadConfig, ConfigError } from './config.js';
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

/** Wire every component from ENV config. Exits with a readable message on bad config. */
export function buildContext() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
  const logger = createLogger(config.logLevel);
  const tokens = createTokenStore(config.configDir, logger.child('tokens'));
  const state = createStateStore(config.configDir, logger.child('state'));
  const spotify = createSpotifyAdapter({ config, tokens, logger });
  const tidal = createTidalAdapter({ config, tokens, logger });
  const [master, slave] = config.sync.master === 'spotify' ? [spotify, tidal] : [tidal, spotify];
  const overrides = readJson(path.join(config.configDir, 'overrides.json'), {}, logger.child('overrides'));
  const matcher = createMatcher({
    slave, state, overrides, logger, retryRuns: config.sync.matchRetryRuns,
  });
  const engine = createSyncEngine({ config, master, slave, state, matcher, logger });
  return { config, logger, tokens, state, adapters: { spotify, tidal }, master, slave, matcher, engine };
}

export async function main() {
  const ctx = buildContext();
  const { config, logger, tokens, engine, adapters } = ctx;
  const log = logger.child('service');

  for (const svc of ['spotify', 'tidal']) {
    if (!tokens.get(svc)?.refreshToken) {
      log.error(`${svc} is not authorized yet — run "docker compose run --rm -p 127.0.0.1:${config.authPort}:${config.authPort} musicsync auth" (or "npm run auth") first`);
      process.exit(1);
    }
  }

  let inFlight = null;
  let authRequired = false;
  let tokensMtimeAtAuthError = 0;
  let scheduledTask = null;

  const tokensMtime = () => {
    try {
      return fs.statSync(tokens.file).mtimeMs;
    } catch {
      return 0;
    }
  };

  async function runOnce(trigger) {
    // cron's noOverlap only covers cron-triggered executions; this guard also
    // protects the startup run from a cron tick landing while it's running.
    if (inFlight) {
      log.warn(`previous sync still in progress, skipping ${trigger} trigger`);
      return;
    }
    if (authRequired) {
      if (tokensMtime() === tokensMtimeAtAuthError) {
        log.error('sync suspended: authorization expired — run "musicsync auth", then the next tick resumes automatically');
        return;
      }
      authRequired = false; // tokens changed on disk; try again
      log.info('token file changed, resuming syncs');
    }

    const spotifyAuth = adapters.spotify.describeAuth();
    if (spotifyAuth.warn) {
      log.warn(`Spotify authorization expires in ~${spotifyAuth.daysLeft} days — refresh tokens hard-expire 6 months after consent; re-run "musicsync auth" soon`, { authorizedAt: spotifyAuth.authorizedAt });
    }

    log.info(`sync run starting (${trigger})`);
    inFlight = (async () => {
      try {
        await engine.runSync();
        writeHealth(config.configDir, {
          status: 'OK',
          lastOkAt: new Date().toISOString(),
          nextDueMs: scheduledTask?.msToNext?.() ?? null,
        });
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          authRequired = true;
          tokensMtimeAtAuthError = tokensMtime();
          writeHealth(config.configDir, { status: 'AUTH_REQUIRED', platform: err.platform, at: new Date().toISOString() });
          log.error(`AUTHORIZATION REQUIRED for ${err.platform}: ${err.message}`);
          log.error('musicsync keeps running but will not sync until you re-authorize.');
        } else {
          log.error('sync run failed', { error: String(err.stack ?? err) });
        }
      } finally {
        inFlight = null;
      }
    })();
    await inFlight;
  }

  scheduledTask = cron.schedule(config.sync.cron, () => runOnce('cron'), {
    name: 'musicsync',
    timezone: config.sync.tz,
    noOverlap: true,
  });
  log.info('scheduled', {
    cron: config.sync.cron,
    tz: config.sync.tz ?? 'system',
    master: config.sync.master,
    dryRun: config.sync.dryRun || undefined,
    nextRun: scheduledTask.getNextRun()?.toISOString(),
  });

  async function shutdown(signal) {
    log.info(`${signal} received, shutting down`);
    try {
      await cron.shutdown(10_000);
      if (inFlight) await inFlight;
      ctx.state.save();
    } catch (err) {
      log.error('shutdown error', { error: String(err) });
    }
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  if (config.sync.onStart) await runOnce('startup');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
