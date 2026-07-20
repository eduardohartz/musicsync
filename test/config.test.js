import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError } from '../src/config.js';

const VALID_ENV = {
  SPOTIFY_CLIENT_ID: 'sid',
  SPOTIFY_CLIENT_SECRET: 'ssecret',
  TIDAL_CLIENT_ID: 'tid',
  TIDAL_CLIENT_SECRET: 'tsecret',
  SYNC_SOURCE: 'spotify',
  SYNC_PLAYLISTS: '37i9dQZF1DXcBWIGoYBM5M,abc123:0f9f5a2b-1c1d-4e5f-a6b7-c8d9e0f1a2b3',
};

test('valid env parses with defaults and pair syntax', () => {
  const cfg = loadConfig(VALID_ENV);
  assert.equal(cfg.sync.mode, 'one-way');
  assert.equal(cfg.sync.source, 'spotify');
  assert.deepEqual(cfg.sync.pairs, [
    { primaryId: '37i9dQZF1DXcBWIGoYBM5M', secondaryId: null, name: null },
    { primaryId: 'abc123', secondaryId: '0f9f5a2b-1c1d-4e5f-a6b7-c8d9e0f1a2b3', name: null },
  ]);
  assert.equal(cfg.sync.cron, '0 */6 * * *');
  assert.equal(cfg.sync.periodic, true);
  assert.equal(cfg.sync.onStart, true);
  assert.equal(cfg.sync.dryRun, false);
  assert.equal(cfg.spotify.market, 'US');
  assert.equal(cfg.tidal.accessType, 'UNLISTED');
  assert.equal(cfg.configDir, '/config');
  assert.equal(cfg.authPort, 8888);
  assert.equal(cfg.authBind, '127.0.0.1');
  assert.equal(cfg.logLevel, 'info');
  assert.deepEqual(cfg.incomplete, []);
  assert.equal(cfg.panel.enabled, false);
  assert.equal(cfg.panel.port, 8080);
});

test('SYNC_PLAYLISTS=all passes through', () => {
  assert.equal(loadConfig({ ...VALID_ENV, SYNC_PLAYLISTS: 'all' }).sync.pairs, 'all');
});

test('two-way mode nulls source and does not require SYNC_SOURCE', () => {
  const cfg = loadConfig({ ...VALID_ENV, SYNC_MODE: 'two-way', SYNC_SOURCE: undefined });
  assert.equal(cfg.sync.mode, 'two-way');
  assert.equal(cfg.sync.source, null);
  assert.deepEqual(cfg.incomplete, []);
});

test('missing values are reported as incomplete, not thrown', () => {
  const cfg = loadConfig({});
  assert.ok(cfg.incomplete.length >= 5, cfg.incomplete.join(','));
  assert.ok(cfg.incomplete.some((i) => i.includes('Spotify client id')));
  assert.ok(cfg.incomplete.some((i) => i.includes('SYNC_SOURCE')));
  assert.ok(cfg.incomplete.some((i) => i.includes('playlist selection')));
});

test('malformed values still throw with every problem listed', () => {
  assert.throws(
    () => loadConfig({
      ...VALID_ENV,
      SYNC_SOURCE: 'deezer',
      SYNC_MODE: 'both-ways',
      LOG_LEVEL: 'verbose',
      TIDAL_ACCESS_TYPE: 'PRIVATE',
      SYNC_CRON: 'not a cron',
      PORT: 'abc',
      DRY_RUN: 'maybe',
    }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.problems.length, 7, err.message);
      return true;
    },
  );
});

test('empty-separator SYNC_PLAYLISTS is reported alongside unrelated problems', () => {
  assert.throws(
    () => loadConfig({ ...VALID_ENV, SYNC_CRON: 'bad cron', SYNC_PLAYLISTS: ', ,' }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /SYNC_CRON/);
      assert.match(err.message, /no valid entries/);
      return true;
    },
  );
});

test('bad playlist entries are rejected', () => {
  for (const bad of ['a:b:c', 'has space', 'x:', ':y']) {
    assert.throws(() => loadConfig({ ...VALID_ENV, SYNC_PLAYLISTS: bad }), ConfigError, `expected "${bad}" rejected`);
  }
});

test('settings.json overrides ENV for app settings', () => {
  const settings = {
    spotify: { clientId: 'panel-sid', market: 'SE' },
    sync: {
      mode: 'two-way',
      periodic: false,
      pairs: [{ primaryId: 'sp1', secondaryId: 'td1', name: 'Mix' }],
    },
    logLevel: 'debug',
  };
  const cfg = loadConfig(VALID_ENV, settings);
  assert.equal(cfg.spotify.clientId, 'panel-sid');
  assert.equal(cfg.spotify.clientSecret, 'ssecret', 'env fills what settings omit');
  assert.equal(cfg.spotify.market, 'SE');
  assert.equal(cfg.sync.mode, 'two-way');
  assert.equal(cfg.sync.periodic, false);
  assert.deepEqual(cfg.sync.pairs, [{ primaryId: 'sp1', secondaryId: 'td1', name: 'Mix' }]);
  assert.equal(cfg.logLevel, 'debug');
});

test('panel enablement follows password or bypass', () => {
  assert.equal(loadConfig(VALID_ENV).panel.enabled, false);
  const withPw = loadConfig({ ...VALID_ENV, WEB_PANEL_PASSWORD: 'hunter2', PORT: '9999' });
  assert.equal(withPw.panel.enabled, true);
  assert.equal(withPw.panel.password, 'hunter2');
  assert.equal(withPw.panel.port, 9999);
  const bypass = loadConfig({ ...VALID_ENV, WEB_PANEL_BYPASS_AUTH: 'true' });
  assert.equal(bypass.panel.enabled, true);
  assert.equal(bypass.panel.bypassAuth, true);
});

test('AUTH_BIND and PANEL_BIND default to loopback', () => {
  const cfg = loadConfig(VALID_ENV);
  assert.equal(cfg.authBind, '127.0.0.1');
  assert.equal(cfg.panel.bind, '127.0.0.1');
  assert.equal(loadConfig({ ...VALID_ENV, PANEL_BIND: '0.0.0.0' }).panel.bind, '0.0.0.0');
});
