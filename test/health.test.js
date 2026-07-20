import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHealth, writeHealth, readHealth } from '../src/health.js';
import { tmpDir } from './helpers.js';

const now = Date.parse('2026-07-20T12:00:00Z');

test('missing heartbeat is unhealthy', () => {
  assert.equal(evaluateHealth(null, now).healthy, false);
});

test('AUTH_REQUIRED is unhealthy with actionable reason', () => {
  const result = evaluateHealth({ status: 'AUTH_REQUIRED' }, now);
  assert.equal(result.healthy, false);
  assert.match(result.reason, /musicsync auth/);
});

test('fresh OK heartbeat is healthy', () => {
  const result = evaluateHealth({
    status: 'OK',
    lastOkAt: new Date(now - 3600_000).toISOString(),
    nextDueMs: 6 * 3600_000,
  }, now);
  assert.equal(result.healthy, true);
});

test('heartbeat older than 2x interval (with 26h floor) is stale', () => {
  const sixHours = 6 * 3600_000;
  const freshEnough = evaluateHealth({
    status: 'OK', lastOkAt: new Date(now - 25 * 3600_000).toISOString(), nextDueMs: sixHours,
  }, now);
  assert.equal(freshEnough.healthy, true, '25h old with 26h floor is still fine');
  const stale = evaluateHealth({
    status: 'OK', lastOkAt: new Date(now - 27 * 3600_000).toISOString(), nextDueMs: sixHours,
  }, now);
  assert.equal(stale.healthy, false);
  const longSchedule = evaluateHealth({
    status: 'OK', lastOkAt: new Date(now - 27 * 3600_000).toISOString(), nextDueMs: 24 * 3600_000,
  }, now);
  assert.equal(longSchedule.healthy, true, '2x a 24h schedule allows 48h');
});

test('writeHealth/readHealth round-trip', () => {
  const dir = tmpDir();
  writeHealth(dir, { status: 'OK', lastOkAt: 'x' });
  assert.deepEqual(readHealth(dir), { status: 'OK', lastOkAt: 'x' });
});
