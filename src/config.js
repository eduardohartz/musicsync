import { validate as validateCron } from 'node-cron';

export class ConfigError extends Error {
  constructor(problems) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const PLATFORMS = ['spotify', 'tidal'];
const MODES = ['one-way', 'two-way'];
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];
const TIDAL_ACCESS_TYPES = ['PUBLIC', 'UNLISTED'];

function parseBool(raw, name, problems, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'boolean') return raw;
  if (['true', '1'].includes(String(raw).toLowerCase())) return true;
  if (['false', '0'].includes(String(raw).toLowerCase())) return false;
  problems.push(`${name} must be true/false (got "${raw}")`);
  return fallback;
}

function parsePlaylists(raw, problems) {
  if (raw === undefined || raw === null || raw === '') return [];
  if (Array.isArray(raw)) {
    // settings.json form: [{primaryId, secondaryId}]
    return raw
      .filter((p) => p && typeof p.primaryId === 'string' && p.primaryId)
      .map((p) => ({ primaryId: p.primaryId, secondaryId: p.secondaryId ?? null, name: p.name ?? null }));
  }
  if (String(raw).trim() === 'all') return 'all';
  const pairs = [];
  const problemsBefore = problems.length;
  for (const entry of String(raw).split(',').map((s) => s.trim()).filter(Boolean)) {
    const parts = entry.split(':');
    if (parts.length > 2 || parts.some((p) => p === '' || /\s/.test(p))) {
      problems.push(`SYNC_PLAYLISTS entry "${entry}" is invalid — expected "primaryId" or "primaryId:secondaryId" with no whitespace`);
      continue;
    }
    pairs.push({ primaryId: parts[0], secondaryId: parts[1] ?? null, name: null });
  }
  if (pairs.length === 0 && problems.length === problemsBefore) {
    problems.push('SYNC_PLAYLISTS contained no valid entries');
  }
  return pairs;
}

const pick = (...values) => values.find((v) => v !== undefined && v !== null && v !== '');

/**
 * Build configuration from ENV seeded defaults merged with panel-managed
 * settings.json (settings win for app settings; panel vars are ENV-only).
 *
 * Malformed values throw ConfigError. MISSING values do not throw — they are
 * reported in `config.incomplete` so the web panel can run its setup wizard;
 * headless callers decide whether incomplete is fatal.
 */
export function loadConfig(env = process.env, settings = {}) {
  const problems = [];
  const incomplete = [];
  const s = settings ?? {};

  const spotifyClientId = pick(s.spotify?.clientId, env.SPOTIFY_CLIENT_ID) ?? '';
  const spotifyClientSecret = pick(s.spotify?.clientSecret, env.SPOTIFY_CLIENT_SECRET) ?? '';
  const tidalClientId = pick(s.tidal?.clientId, env.TIDAL_CLIENT_ID) ?? '';
  const tidalClientSecret = pick(s.tidal?.clientSecret, env.TIDAL_CLIENT_SECRET) ?? '';
  if (!spotifyClientId) incomplete.push('Spotify client id');
  if (!spotifyClientSecret) incomplete.push('Spotify client secret');
  if (!tidalClientId) incomplete.push('TIDAL client id');
  if (!tidalClientSecret) incomplete.push('TIDAL client secret');

  const mode = pick(s.sync?.mode, env.SYNC_MODE) ?? 'one-way';
  if (!MODES.includes(mode)) problems.push(`SYNC_MODE must be one of ${MODES.join('|')} (got "${mode}")`);

  const sourceRaw = pick(s.sync?.source, env.SYNC_SOURCE) ?? null;
  if (sourceRaw && !PLATFORMS.includes(sourceRaw)) {
    problems.push(`SYNC_SOURCE must be one of ${PLATFORMS.join('|')} (got "${sourceRaw}")`);
  }
  if (mode === 'one-way' && !sourceRaw) incomplete.push('sync source platform (SYNC_SOURCE)');
  // two-way has no source; pairs are just linked playlists
  const source = mode === 'one-way' ? sourceRaw : null;

  const pairs = parsePlaylists(pick(s.sync?.pairs, env.SYNC_PLAYLISTS), problems);
  if (pairs !== 'all' && pairs.length === 0) incomplete.push('playlist selection (SYNC_PLAYLISTS)');

  const cron = pick(s.sync?.cron, env.SYNC_CRON) ?? '0 */6 * * *';
  if (!validateCron(cron)) problems.push(`SYNC_CRON "${cron}" is not a valid cron expression`);

  const periodic = parseBool(pick(s.sync?.periodic, env.SYNC_PERIODIC), 'SYNC_PERIODIC', problems, true);

  const logLevel = pick(s.logLevel, env.LOG_LEVEL) ?? 'info';
  if (!LOG_LEVELS.includes(logLevel)) problems.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join('|')} (got "${logLevel}")`);

  const accessType = pick(s.tidal?.accessType, env.TIDAL_ACCESS_TYPE) ?? 'UNLISTED';
  if (!TIDAL_ACCESS_TYPES.includes(accessType)) {
    problems.push(`TIDAL_ACCESS_TYPE must be one of ${TIDAL_ACCESS_TYPES.join('|')} (got "${accessType}") — TIDAL has no PRIVATE playlists`);
  }

  const panelPort = Number(env.PORT ?? '8080');
  if (!Number.isInteger(panelPort) || panelPort < 1 || panelPort > 65535) {
    problems.push(`PORT must be an integer between 1 and 65535 (got "${env.PORT}")`);
  }

  const matchRetryRuns = Number(pick(s.sync?.matchRetryRuns, env.MATCH_RETRY_RUNS) ?? '10');
  if (!Number.isInteger(matchRetryRuns) || matchRetryRuns < 1) {
    problems.push(`MATCH_RETRY_RUNS must be a positive integer (got "${env.MATCH_RETRY_RUNS}")`);
  }

  const bypassAuth = parseBool(env.WEB_PANEL_BYPASS_AUTH, 'WEB_PANEL_BYPASS_AUTH', problems, false);
  const password = env.WEB_PANEL_PASSWORD || null;

  const config = {
    spotify: {
      clientId: spotifyClientId,
      clientSecret: spotifyClientSecret,
      market: pick(s.spotify?.market, env.SPOTIFY_MARKET) ?? 'US',
      playlistPublic: parseBool(pick(s.spotify?.playlistPublic, env.SPOTIFY_PLAYLIST_PUBLIC), 'SPOTIFY_PLAYLIST_PUBLIC', problems, false),
    },
    tidal: {
      clientId: tidalClientId,
      clientSecret: tidalClientSecret,
      accessType,
    },
    sync: {
      mode,
      source,
      pairs,
      periodic,
      cron,
      onStart: parseBool(pick(s.sync?.onStart, env.SYNC_ON_START), 'SYNC_ON_START', problems, true),
      tz: pick(s.sync?.tz, env.SYNC_TZ),
      dryRun: parseBool(pick(s.sync?.dryRun, env.DRY_RUN), 'DRY_RUN', problems, false),
      matchRetryRuns,
    },
    panel: {
      enabled: Boolean(password || bypassAuth),
      port: panelPort,
      password,
      bypassAuth,
      bind: env.PANEL_BIND ?? '127.0.0.1',
    },
    configDir: env.CONFIG_DIR ?? '/config',
    logLevel,
    incomplete,
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
