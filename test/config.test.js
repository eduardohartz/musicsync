import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError } from '../src/config.js';

const VALID_ENV = {
  SPOTIFY_CLIENT_ID: 'sid',
  SPOTIFY_CLIENT_SECRET: 'ssecret',
  TIDAL_CLIENT_ID: 'tid',
  TIDAL_CLIENT_SECRET: 'tsecret',
  SYNC_MASTER: 'spotify',
  SYNC_PLAYLISTS: '37i9dQZF1DXcBWIGoYBM5M,abc123:0f9f5a2b-1c1d-4e5f-a6b7-c8d9e0f1a2b3',
};

test('valid env parses with defaults and pair syntax', () => {
  const cfg = loadConfig(VALID_ENV);
  assert.equal(cfg.sync.master, 'spotify');
  assert.equal(cfg.sync.slave, 'tidal');
  assert.deepEqual(cfg.sync.pairs, [
    { masterId: '37i9dQZF1DXcBWIGoYBM5M', slaveId: null },
    { masterId: 'abc123', slaveId: '0f9f5a2b-1c1d-4e5f-a6b7-c8d9e0f1a2b3' },
  ]);
  assert.equal(cfg.sync.cron, '0 */6 * * *');
  assert.equal(cfg.sync.onStart, true);
  assert.equal(cfg.sync.dryRun, false);
  assert.equal(cfg.sync.matchRetryRuns, 10);
  assert.equal(cfg.spotify.market, 'US');
  assert.equal(cfg.spotify.playlistPublic, false);
  assert.equal(cfg.tidal.accessType, 'UNLISTED');
  assert.equal(cfg.configDir, '/config');
  assert.equal(cfg.authPort, 8888);
  assert.equal(cfg.logLevel, 'info');
});

test('SYNC_PLAYLISTS=all passes through', () => {
  const cfg = loadConfig({ ...VALID_ENV, SYNC_PLAYLISTS: 'all' });
  assert.equal(cfg.sync.pairs, 'all');
});

test('tidal master flips slave', () => {
  const cfg = loadConfig({ ...VALID_ENV, SYNC_MASTER: 'tidal' });
  assert.equal(cfg.sync.slave, 'spotify');
});

test('missing env reports every problem at once', () => {
  assert.throws(
    () => loadConfig({}),
    (err) => {
      assert.ok(err instanceof ConfigError);
      for (const name of [
        'SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'TIDAL_CLIENT_ID',
        'TIDAL_CLIENT_SECRET', 'SYNC_MASTER', 'SYNC_PLAYLISTS',
      ]) {
        assert.match(err.message, new RegExp(name), `expected ${name} in error`);
      }
      return true;
    },
  );
});

test('enum violations are each reported', () => {
  assert.throws(
    () => loadConfig({
      ...VALID_ENV,
      SYNC_MASTER: 'deezer',
      LOG_LEVEL: 'verbose',
      TIDAL_ACCESS_TYPE: 'PRIVATE',
      SYNC_CRON: 'not a cron',
      AUTH_PORT: 'abc',
      DRY_RUN: 'maybe',
    }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.problems.length, 6, err.message);
      return true;
    },
  );
});

test('bad playlist entries are rejected', () => {
  for (const bad of ['a:b:c', 'has space', 'x:', ':y']) {
    assert.throws(
      () => loadConfig({ ...VALID_ENV, SYNC_PLAYLISTS: bad }),
      ConfigError,
      `expected "${bad}" to be rejected`,
    );
  }
});
