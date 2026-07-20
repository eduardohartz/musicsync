import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTidalAdapter, parseIsoDuration, generatePkce } from '../src/platforms/tidal.js';
import { routedFetch, seededTokens, silentLogger, instantSleep, baseConfig } from './helpers.js';

function makeAdapter(handlers, { tokens = seededTokens() } = {}) {
  const fetch = routedFetch(handlers);
  const adapter = createTidalAdapter({
    config: baseConfig, tokens, logger: silentLogger, fetchImpl: fetch.impl, sleep: instantSleep,
  });
  return { adapter, fetch, tokens };
}

const usersMe = {
  match: (u) => u.endsWith('/users/me'),
  reply: { status: 200, body: { data: { id: 'u1', type: 'users', attributes: { country: 'DE' } } } },
};

const tidalTrackResource = (id, { isrc = `ISRC${id}`, title = `Track ${id}`, version = null } = {}) => ({
  id, type: 'tracks',
  attributes: { title, version, isrc, duration: 'PT3M20S', explicit: false },
  relationships: { artists: { data: [{ id: 'art1', type: 'artists' }] }, albums: { data: [{ id: 'alb1', type: 'albums' }] } },
});
const artistResource = { id: 'art1', type: 'artists', attributes: { name: 'Artist' } };
const albumResource = { id: 'alb1', type: 'albums', attributes: { title: 'Album' } };

test('parseIsoDuration handles hours, minutes, seconds', () => {
  assert.equal(parseIsoDuration('PT1H2M3S'), 3723000);
  assert.equal(parseIsoDuration('PT45S'), 45000);
  assert.equal(parseIsoDuration('PT3M'), 180000);
  assert.equal(parseIsoDuration('PT3M20.5S'), 200500);
  assert.equal(parseIsoDuration('garbage'), null);
});

test('generatePkce produces base64url verifier and S256 challenge', () => {
  const { verifier, challenge } = generatePkce();
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(verifier, challenge);
});

test('getPlaylistItems walks links.next cursors and captures meta.itemId', async () => {
  const { adapter, fetch } = makeAdapter([
    usersMe,
    {
      match: (u) => u.includes('/playlists/pl1/relationships/items') && !u.includes('cursor=c2'),
      reply: {
        status: 200,
        body: {
          data: [
            { id: 'ta', type: 'tracks', meta: { itemId: 'item-1' } },
            { id: 'vid', type: 'videos', meta: { itemId: 'item-2' } },
          ],
          included: [tidalTrackResource('ta'), artistResource, albumResource],
          links: { next: '/playlists/pl1/relationships/items?page%5Bcursor%5D=c2&cursor=c2' },
        },
      },
    },
    {
      match: (u) => u.includes('cursor=c2'),
      reply: {
        status: 200,
        body: {
          data: [{ id: 'tb', type: 'tracks', meta: { itemId: 'item-3' } }],
          included: [tidalTrackResource('tb'), artistResource, albumResource],
          links: {},
        },
      },
    },
  ]);
  const items = await adapter.getPlaylistItems('pl1');
  // videos surface as pseudo-items (visible to the diff), tracks as themselves
  assert.deepEqual(items.map((t) => [t.id, t.itemId]), [['ta', 'item-1'], ['videos:vid', 'item-2'], ['tb', 'item-3']]);
  assert.equal(items[1].isVideo, true);
  assert.equal(items[0].durationMs, 200000);
  assert.deepEqual(items[0].artists, ['Artist']);
  assert.equal(items[0].album, 'Album');
  assert.equal(items[0].isrc, 'ISRCta');
  // second page URL resolved against API base
  assert.match(fetch.calls.at(-1).url, /^https:\/\/openapi\.tidal\.com\/v2\/playlists\/pl1/);
  // Accept header on reads
  assert.equal(fetch.calls.at(-1).opts.headers.Accept, 'application/vnd.api+json');
});

test('rewrite refetches item refs, deletes in 50-chunks with itemId, re-appends', async () => {
  const mutations = [];
  const refs = Array.from({ length: 60 }, (_, i) => ({ id: `t${i}`, type: 'tracks', meta: { itemId: `it${i}` } }));
  const { adapter } = makeAdapter([
    usersMe,
    {
      match: (u, o) => u.includes('/playlists/pl1/relationships/items') && (o.method ?? 'GET') === 'GET',
      reply: { status: 200, body: { data: refs, links: {} } },
    },
    {
      match: (u, o) => u.includes('/playlists/pl1/relationships/items') && ['POST', 'DELETE'].includes(o.method),
      reply: (u, o) => {
        mutations.push({ method: o.method, body: JSON.parse(o.body), idem: o.headers['Idempotency-Key'] });
        return { status: 204 };
      },
    },
  ]);
  const target = ['n1', 'n2'];
  await adapter.setPlaylistItems('pl1', target, [{ id: 'x' }]);

  assert.deepEqual(mutations.map((m) => m.method), ['DELETE', 'DELETE', 'POST']);
  assert.equal(mutations[0].body.data.length, 50);
  assert.deepEqual(mutations[0].body.data[0], { id: 't0', type: 'tracks', meta: { itemId: 'it0' } });
  assert.equal(mutations[1].body.data.length, 10);
  assert.deepEqual(mutations[2].body, { data: [{ id: 'n1', type: 'tracks' }, { id: 'n2', type: 'tracks' }] });
  const keys = mutations.map((m) => m.idem);
  assert.equal(new Set(keys).size, keys.length, 'idempotency keys must be unique per chunk');
  assert.ok(keys.every(Boolean));
});

test('append-only writes use POST chunks of 50 without delete', async () => {
  const mutations = [];
  const { adapter } = makeAdapter([
    usersMe,
    {
      match: (u, o) => u.includes('/relationships/items') && o.method === 'POST',
      reply: (u, o) => {
        mutations.push(JSON.parse(o.body).data.length);
        return { status: 204 };
      },
    },
  ]);
  const current = [{ id: 'a' }];
  const target = ['a', ...Array.from({ length: 70 }, (_, i) => `n${i}`)];
  await adapter.setPlaylistItems('pl1', target, current);
  assert.deepEqual(mutations, [50, 20]);
});

test('createPlaylist sends JSON:API body with accessType', async () => {
  let sent;
  const { adapter } = makeAdapter([
    usersMe,
    {
      match: (u, o) => u.endsWith('/playlists') && o.method === 'POST',
      reply: (u, o) => {
        sent = { body: JSON.parse(o.body), contentType: o.headers['Content-Type'] };
        return { status: 201, body: { data: { id: 'new-pl', type: 'playlists' } } };
      },
    },
  ]);
  const created = await adapter.createPlaylist({ name: 'My List', description: 'synced' });
  assert.equal(created.id, 'new-pl');
  assert.deepEqual(sent.body, {
    data: { type: 'playlists', attributes: { name: 'My List', description: 'synced', accessType: 'UNLISTED' } },
  });
  assert.equal(sent.contentType, 'application/vnd.api+json');
});

test('catalog lookups use client-credentials token, playlist ops use user token', async () => {
  const authByUrl = [];
  const { adapter } = makeAdapter([
    usersMe,
    {
      match: (u, o) => {
        authByUrl.push({ url: u, auth: o.headers?.Authorization });
        return u.includes('/tracks?') || u.includes('/playlists/pl1');
      },
      reply: (u) => (u.includes('/tracks?')
        ? { status: 200, body: { data: [tidalTrackResource('t1')], included: [artistResource, albumResource] } }
        : { status: 200, body: { data: { id: 'pl1', type: 'playlists', attributes: { name: 'x', lastModifiedAt: 'L', numberOfItems: 2 } } } }),
    },
  ]);
  const found = await adapter.findTracksByIsrc('DEABC12345');
  assert.equal(found[0].id, 't1');
  const meta = await adapter.getPlaylistMeta('pl1');
  assert.equal(meta.changeToken, 'L|2');

  const isrcCall = authByUrl.find((c) => c.url.includes('/tracks?'));
  const metaCall = authByUrl.find((c) => c.url.includes('/playlists/pl1'));
  assert.equal(isrcCall.auth, 'Bearer td-cc-access');
  assert.equal(metaCall.auth, 'Bearer td-access');
  assert.match(decodeURIComponent(isrcCall.url), /filter\[isrc\]=DEABC12345/);
  assert.match(isrcCall.url, /countryCode=DE/);
});

test('client-credentials token fetched with Basic auth when missing', async () => {
  const tokens = seededTokens({ tidalCc: false });
  let ccRequest;
  const { adapter } = makeAdapter([
    usersMe,
    {
      match: (u, o) => u.endsWith('/oauth2/token') && o.method === 'POST',
      reply: (u, o) => {
        ccRequest = { form: new URLSearchParams(o.body), auth: o.headers.Authorization };
        return { status: 200, body: { access_token: 'fresh-cc', expires_in: 86400 } };
      },
    },
    {
      match: (u) => u.includes('/tracks?'),
      reply: { status: 200, body: { data: [], included: [] } },
    },
  ], { tokens });
  await adapter.findTracksByIsrc('X');
  assert.equal(ccRequest.form.get('grant_type'), 'client_credentials');
  assert.match(ccRequest.auth, /^Basic /);
  assert.equal(tokens.get('tidal-cc').accessToken, 'fresh-cc');
});

test('searchTracks reads search relationship refs from included resources', async () => {
  const { adapter, fetch } = makeAdapter([
    usersMe,
    {
      match: (u) => u.includes('/searchResults/'),
      reply: {
        status: 200,
        body: {
          data: { id: 'q', type: 'searchResults', relationships: { tracks: { data: [{ id: 'ta', type: 'tracks' }] } } },
          included: [tidalTrackResource('ta'), artistResource, albumResource],
        },
      },
    },
  ]);
  const results = await adapter.searchTracks({ title: 'Song', artist: 'Artist' });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'ta');
  assert.match(fetch.calls.at(-1).url, /searchResults\/Song%20Artist/);
});

test('buildAuthorizeUrl carries PKCE challenge and scopes', () => {
  const { adapter } = makeAdapter([]);
  const url = new URL(adapter.buildAuthorizeUrl({
    redirectUri: 'http://127.0.0.1:8888/callback/tidal', state: 'st', challenge: 'chal',
  }));
  assert.equal(url.origin, 'https://login.tidal.com');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), 'chal');
  assert.match(url.searchParams.get('scope'), /playlists\.write/);
});

test('duplicate track ids are collapsed before writing (TIDAL rejects duplicates)', async () => {
  const bodies = [];
  const { adapter } = makeAdapter([
    usersMe,
    {
      match: (u, o) => u.includes('/relationships/items') && o.method === 'POST',
      reply: (u, o) => { bodies.push(JSON.parse(o.body).data.map((d) => d.id)); return { status: 204 }; },
    },
  ]);
  const result = await adapter.setPlaylistItems('pl1', ['a', 'b', 'a', 'c', 'b'], []);
  assert.deepEqual(bodies, [['a', 'b', 'c']]);
  assert.deepEqual(result, { dropped: 0 });
});

test('422 chunk rejection falls back to per-item appends and reports drops', async () => {
  const attempts = [];
  const { adapter } = makeAdapter([
    usersMe,
    {
      match: (u, o) => u.includes('/relationships/items') && o.method === 'POST',
      reply: (u, o) => {
        const ids = JSON.parse(o.body).data.map((d) => d.id);
        attempts.push(ids);
        if (ids.length > 1) {
          return { status: 422, body: { errors: [{ code: 'DUPLICATE_ITEMS_IN_COLLECTION' }] } };
        }
        return ids[0] === 'poison'
          ? { status: 422, body: { errors: [{ code: 'DUPLICATE_ITEMS_IN_COLLECTION' }] } }
          : { status: 204 };
      },
    },
  ]);
  const result = await adapter.setPlaylistItems('pl1', ['x', 'poison', 'y'], []);
  assert.deepEqual(result, { dropped: 1 });
  assert.deepEqual(attempts, [['x', 'poison', 'y'], ['x'], ['poison'], ['y']]);
});

test('409 in-progress replays the SAME idempotency key', async () => {
  const keys = [];
  let first = true;
  const { adapter } = makeAdapter([
    usersMe,
    {
      match: (u, o) => u.includes('/relationships/items') && o.method === 'POST',
      reply: (u, o) => {
        keys.push(o.headers['Idempotency-Key']);
        if (first) { first = false; return { status: 409, body: { errors: [{ code: 'IDEMPOTENT_REQUEST_IN_PROGRESS' }] } }; }
        return { status: 204 };
      },
    },
  ]);
  await adapter.setPlaylistItems('pl1', ['a'], []);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1], '409 retry must reuse the original Idempotency-Key');
});

test('findTracksByIsrc walks pagination', async () => {
  const { adapter } = makeAdapter([
    usersMe,
    {
      match: (u) => u.includes('/tracks?') && !u.includes('cursor=p2'),
      reply: {
        status: 200,
        body: {
          data: [tidalTrackResource('t1')], included: [artistResource, albumResource],
          links: { next: '/tracks?filter[isrc]=X&cursor=p2' },
        },
      },
    },
    {
      match: (u) => u.includes('cursor=p2'),
      reply: { status: 200, body: { data: [tidalTrackResource('t2')], included: [artistResource, albumResource], links: {} } },
    },
  ]);
  const found = await adapter.findTracksByIsrc('X');
  assert.deepEqual(found.map((t) => t.id), ['t1', 't2']);
});

test('videos appear as pseudo-items so the diff can see them', async () => {
  const { adapter } = makeAdapter([
    usersMe,
    {
      match: (u, o) => u.includes('/playlists/pl1/relationships/items') && (o.method ?? 'GET') === 'GET',
      reply: {
        status: 200,
        body: {
          data: [
            { id: 'ta', type: 'tracks', meta: { itemId: 'i1' } },
            { id: 'v1', type: 'videos', meta: { itemId: 'i2' } },
          ],
          included: [tidalTrackResource('ta'), artistResource, albumResource],
          links: {},
        },
      },
    },
  ]);
  const items = await adapter.getPlaylistItems('pl1');
  assert.deepEqual(items.map((t) => t.id), ['ta', 'videos:v1']);
  assert.equal(items[1].isVideo, true);
  assert.equal(items[1].itemId, 'i2');
});
