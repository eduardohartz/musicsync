import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpotifyAdapter } from '../src/platforms/spotify.js';
import { AuthRequiredError } from '../src/http.js';
import { routedFetch, seededTokens, silentLogger, instantSleep, baseConfig } from './helpers.js';

function makeAdapter(handlers, { tokens = seededTokens() } = {}) {
  const fetch = routedFetch(handlers);
  const adapter = createSpotifyAdapter({
    config: baseConfig, tokens, logger: silentLogger, fetchImpl: fetch.impl, sleep: instantSleep,
  });
  return { adapter, fetch, tokens };
}

const spotifyTrack = (id, isrc = `ISRC${id}`) => ({
  id, name: `Track ${id}`, duration_ms: 200000,
  artists: [{ name: 'Artist' }], album: { name: 'Album' },
  external_ids: { isrc },
});

test('getPlaylistItems walks pagination, requests fields, reads item ?? track', async () => {
  const page2 = 'https://api.spotify.com/v1/playlists/p1/items?offset=50';
  const { adapter, fetch } = makeAdapter([
    {
      match: (u) => u.includes('/playlists/p1/items') && !u.includes('offset=50'),
      reply: { status: 200, body: { next: page2, items: [
        { is_local: false, item: spotifyTrack('a') },
        { is_local: true, item: spotifyTrack('local') },
      ] } },
    },
    {
      match: (u) => u === page2,
      reply: { status: 200, body: { next: null, items: [
        { is_local: false, track: spotifyTrack('b') }, // legacy key fallback
        { is_local: false, item: null },               // deleted/unavailable
      ] } },
    },
  ]);
  const items = await adapter.getPlaylistItems('p1');
  assert.deepEqual(items.map((t) => t.id), ['a', 'local', 'b']);
  assert.equal(items[0].isrc, 'ISRCa');
  assert.equal(items[0].album, 'Album');
  assert.equal(items[1].isLocal, true);
  const firstUrl = decodeURIComponent(fetch.calls[0].url);
  assert.match(firstUrl, /fields=next,items\(/);
  assert.match(firstUrl, /external_ids\(isrc\)/);
  assert.match(fetch.calls[0].opts.headers.Authorization, /^Bearer sp-access$/);
});

test('setPlaylistItems rewrite chunks: 250 tracks -> PUT 100 + POST 100 + POST 50', async () => {
  const writes = [];
  const { adapter } = makeAdapter([
    {
      match: (u, o) => u.endsWith('/playlists/p1/items') && ['PUT', 'POST'].includes(o.method),
      reply: (u, o) => {
        writes.push({ method: o.method, uris: JSON.parse(o.body).uris });
        return { status: 201, body: { snapshot_id: 's' } };
      },
    },
  ]);
  const target = Array.from({ length: 250 }, (_, i) => `t${i}`);
  await adapter.setPlaylistItems('p1', target, [{ id: 'other' }]);
  assert.deepEqual(writes.map((w) => [w.method, w.uris.length]), [['PUT', 100], ['POST', 100], ['POST', 50]]);
  assert.equal(writes[0].uris[0], 'spotify:track:t0');
  assert.equal(writes[2].uris[49], 'spotify:track:t249');
});

test('setPlaylistItems appends when current is a prefix', async () => {
  const writes = [];
  const { adapter } = makeAdapter([
    {
      match: (u, o) => u.endsWith('/playlists/p1/items') && o.method === 'POST',
      reply: (u, o) => {
        writes.push(JSON.parse(o.body).uris);
        return { status: 201, body: { snapshot_id: 's' } };
      },
    },
  ]);
  await adapter.setPlaylistItems('p1', ['a', 'b', 'c'], [{ id: 'a' }, { id: 'b' }]);
  assert.deepEqual(writes, [['spotify:track:c']]);
});

test('setPlaylistItems skips when identical', async () => {
  const { adapter, fetch } = makeAdapter([]);
  await adapter.setPlaylistItems('p1', ['a'], [{ id: 'a' }]);
  assert.equal(fetch.calls.length, 0);
});

test('expired access token triggers refresh and persists rotated refresh token', async () => {
  const tokens = seededTokens({ spotify: { expiresAt: new Date(Date.now() - 1000).toISOString() } });
  const { adapter } = makeAdapter([
    {
      match: (u, o) => u === 'https://accounts.spotify.com/api/token' && o.method === 'POST',
      reply: (u, o) => {
        const form = new URLSearchParams(o.body);
        assert.equal(form.get('grant_type'), 'refresh_token');
        assert.equal(form.get('refresh_token'), 'sp-refresh');
        assert.match(o.headers.Authorization, /^Basic /);
        return { status: 200, body: { access_token: 'new-access', expires_in: 3600, refresh_token: 'new-refresh' } };
      },
    },
    { match: (u) => u.endsWith('/me'), reply: { status: 200, body: { id: 'user1' } } },
  ], { tokens });
  const me = await adapter.getCurrentUser();
  assert.equal(me.id, 'user1');
  assert.equal(me.country, 'DE'); // market from ENV, not profile
  assert.equal(tokens.get('spotify').accessToken, 'new-access');
  assert.equal(tokens.get('spotify').refreshToken, 'new-refresh');
});

test('invalid_grant on refresh raises AuthRequiredError', async () => {
  const tokens = seededTokens({ spotify: { expiresAt: new Date(Date.now() - 1000).toISOString() } });
  const { adapter } = makeAdapter([
    {
      match: (u) => u === 'https://accounts.spotify.com/api/token',
      reply: { status: 400, body: { error: 'invalid_grant', error_description: 'Refresh token expired' } },
    },
  ], { tokens });
  await assert.rejects(() => adapter.getCurrentUser(), AuthRequiredError);
});

test('listOwnPlaylists filters to owned playlists', async () => {
  const { adapter } = makeAdapter([
    { match: (u) => u.endsWith('/me'), reply: { status: 200, body: { id: 'user1' } } },
    {
      match: (u) => u.includes('/me/playlists'),
      reply: { status: 200, body: { next: null, items: [
        { id: 'mine', name: 'Mine', owner: { id: 'user1' } },
        { id: 'followed', name: 'Followed', owner: { id: 'someone' } },
      ] } },
    },
  ]);
  assert.deepEqual(await adapter.listOwnPlaylists(), [{ id: 'mine', name: 'Mine' }]);
});

test('findTracksByIsrc searches with isrc filter, market, limit 10', async () => {
  const { adapter, fetch } = makeAdapter([
    {
      match: (u) => u.includes('/search'),
      reply: { status: 200, body: { tracks: { items: [spotifyTrack('x', 'QWERTY123')] } } },
    },
  ]);
  const results = await adapter.findTracksByIsrc('QWERTY123');
  assert.equal(results[0].id, 'x');
  const url = decodeURIComponent(fetch.calls[0].url);
  assert.match(url, /q=isrc:QWERTY123/);
  assert.match(url, /limit=10/);
  assert.match(url, /market=DE/);
});

test('describeAuth reports six-month countdown', async () => {
  const authorizedAt = new Date(Date.now() - (160 * 86_400_000 + 3_600_000)).toISOString();
  const tokens = seededTokens({ spotify: { authorizedAt } });
  const { adapter } = makeAdapter([], { tokens });
  const auth = adapter.describeAuth();
  assert.equal(auth.authorized, true);
  assert.equal(auth.daysLeft, 19);
  assert.equal(auth.warn, true);
});

test('buildAuthorizeUrl carries scopes, state and redirect', () => {
  const { adapter } = makeAdapter([]);
  const url = new URL(adapter.buildAuthorizeUrl({ redirectUri: 'http://127.0.0.1:8888/callback/spotify', state: 'st1' }));
  assert.equal(url.origin + url.pathname, 'https://accounts.spotify.com/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), 'st1');
  assert.match(url.searchParams.get('scope'), /playlist-modify-private/);
});
