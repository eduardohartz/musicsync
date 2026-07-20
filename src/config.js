import { validate as validateCron } from 'node-cron';

export class ConfigError extends Error {
  constructor(problems) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const PLATFORMS = ['spotify', 'tidal'];
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];
const TIDAL_ACCESS_TYPES = ['PUBLIC', 'UNLISTED'];

function parseBool(raw, name, problems, fallback) {
  if (raw === undefined || raw === '') return fallback;
  if (['true', '1'].includes(raw.toLowerCase())) return true;
  if (['false', '0'].includes(raw.toLowerCase())) return false;
  problems.push(`${name} must be true/false (got "${raw}")`);
  return fallback;
}

function parsePlaylists(raw, problems) {
  if (raw === undefined || raw.trim() === '') {
    problems.push('SYNC_PLAYLISTS is required (comma-separated master playlist ids, "masterId:slaveId" pairs, or "all")');
    return [];
  }
  if (raw.trim() === 'all') return 'all';
  const pairs = [];
  const problemsBefore = problems.length;
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const parts = entry.split(':');
    if (parts.length > 2 || parts.some((p) => p === '' || /\s/.test(p))) {
      problems.push(`SYNC_PLAYLISTS entry "${entry}" is invalid — expected "masterId" or "masterId:slaveId" with no whitespace`);
      continue;
    }
    pairs.push({ masterId: parts[0], slaveId: parts[1] ?? null });
  }
  if (pairs.length === 0 && problems.length === problemsBefore) {
    problems.push('SYNC_PLAYLISTS contained no valid entries');
  }
  return pairs;
}

/**
 * Parse and validate all configuration from environment variables.
 * Reports every problem at once via ConfigError.
 */
export function loadConfig(env = process.env) {
  const problems = [];

  for (const name of ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'TIDAL_CLIENT_ID', 'TIDAL_CLIENT_SECRET']) {
    if (!env[name]) problems.push(`${name} is required`);
  }

  const master = env.SYNC_MASTER ?? '';
  if (!PLATFORMS.includes(master)) {
    problems.push(`SYNC_MASTER must be one of ${PLATFORMS.join('|')} (got "${master}")`);
  }

  const pairs = parsePlaylists(env.SYNC_PLAYLISTS, problems);

  const cron = env.SYNC_CRON ?? '0 */6 * * *';
  if (!validateCron(cron)) problems.push(`SYNC_CRON "${cron}" is not a valid cron expression`);

  const logLevel = env.LOG_LEVEL ?? 'info';
  if (!LOG_LEVELS.includes(logLevel)) {
    problems.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join('|')} (got "${logLevel}")`);
  }

  const accessType = env.TIDAL_ACCESS_TYPE ?? 'UNLISTED';
  if (!TIDAL_ACCESS_TYPES.includes(accessType)) {
    problems.push(`TIDAL_ACCESS_TYPE must be one of ${TIDAL_ACCESS_TYPES.join('|')} (got "${accessType}") — TIDAL has no PRIVATE playlists`);
  }

  const authPort = Number(env.AUTH_PORT ?? '8888');
  if (!Number.isInteger(authPort) || authPort < 1 || authPort > 65535) {
    problems.push(`AUTH_PORT must be an integer between 1 and 65535 (got "${env.AUTH_PORT}")`);
  }

  const matchRetryRuns = Number(env.MATCH_RETRY_RUNS ?? '10');
  if (!Number.isInteger(matchRetryRuns) || matchRetryRuns < 1) {
    problems.push(`MATCH_RETRY_RUNS must be a positive integer (got "${env.MATCH_RETRY_RUNS}")`);
  }

  const config = {
    spotify: {
      clientId: env.SPOTIFY_CLIENT_ID ?? '',
      clientSecret: env.SPOTIFY_CLIENT_SECRET ?? '',
      market: env.SPOTIFY_MARKET ?? 'US',
      playlistPublic: parseBool(env.SPOTIFY_PLAYLIST_PUBLIC, 'SPOTIFY_PLAYLIST_PUBLIC', problems, false),
    },
    tidal: {
      clientId: env.TIDAL_CLIENT_ID ?? '',
      clientSecret: env.TIDAL_CLIENT_SECRET ?? '',
      accessType,
    },
    sync: {
      master,
      slave: master === 'spotify' ? 'tidal' : 'spotify',
      pairs,
      cron,
      onStart: parseBool(env.SYNC_ON_START, 'SYNC_ON_START', problems, true),
      tz: env.SYNC_TZ,
      dryRun: parseBool(env.DRY_RUN, 'DRY_RUN', problems, false),
      matchRetryRuns,
    },
    configDir: env.CONFIG_DIR ?? '/config',
    authPort,
    // 127.0.0.1 keeps the temporary OAuth callback server off the LAN when
    // running natively; the Dockerfile sets AUTH_BIND=0.0.0.0 so the
    // published container port stays reachable.
    authBind: env.AUTH_BIND ?? '127.0.0.1',
    logLevel,
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
