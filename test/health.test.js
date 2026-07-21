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
  assert.match(result.reason, /web panel/);
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

test('SETUP phase and manual-only mode are healthy', () => {
  assert.equal(evaluateHealth({ status: 'SETUP' }, now).healthy, true);
  assert.equal(evaluateHealth({
    status: 'OK', periodic: false, lastOkAt: new Date(now - 90 * 24 * 3600_000).toISOString(),
  }, now).healthy, true, 'staleness is meaningless without periodic sync');
});

test('READY is healthy; FAIL is unhealthy with the error surfaced', () => {
  assert.equal(evaluateHealth({ status: 'READY' }, now).healthy, true);
  const fail = evaluateHealth({ status: 'FAIL', error: 'tidal 502' }, now);
  assert.equal(fail.healthy, false);
  assert.match(fail.reason, /tidal 502/);
});
