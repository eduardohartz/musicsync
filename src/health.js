import path from 'node:path';
import { readJson, writeJsonAtomic } from './store.js';

const MIN_STALE_MS = 26 * 3600 * 1000; // generous floor for infrequent schedules

export function healthFile(configDir) {
  return path.join(configDir, 'health.json');
}

export function writeHealth(configDir, data) {
  writeJsonAtomic(healthFile(configDir), data);
}

export function readHealth(configDir) {
  return readJson(healthFile(configDir), null);
}

/**
 * Heartbeat evaluation for the Docker HEALTHCHECK. Unhealthy when the service
 * needs re-authorization or the last successful run is older than twice the
 * cron interval (with a 26 h floor).
 */
export function evaluateHealth(data, now = Date.now()) {
  if (!data) return { healthy: false, reason: 'no heartbeat yet' };
  if (data.status === 'AUTH_REQUIRED') {
    return { healthy: false, reason: 'authorization required — reconnect the account in the web panel' };
  }
  // Waiting for first-run setup in the web panel: the container is doing its job.
  if (data.status === 'SETUP') return { healthy: true };
  if (data.status !== 'OK') return { healthy: false, reason: `status is ${data.status}` };
  // Manual-only mode (periodic sync off): staleness is meaningless.
  if (data.periodic === false) return { healthy: true };
  const lastOk = Date.parse(data.lastOkAt ?? '');
  if (!Number.isFinite(lastOk)) return { healthy: false, reason: 'no successful run recorded' };
  const maxAge = Math.max(2 * (data.nextDueMs ?? 0), MIN_STALE_MS);
  const age = now - lastOk;
  if (age > maxAge) {
    return { healthy: false, reason: `stale heartbeat: last success ${Math.round(age / 3600000)}h ago` };
  }
  return { healthy: true };
}
