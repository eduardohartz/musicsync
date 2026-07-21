import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createWebServer } from '../src/web/server.js';
import { silentLogger, baseConfig } from './helpers.js';

function stubRuntime({ bypass = false, password = 'hunter2' } = {}) {
  const calls = { applied: [], synced: 0, exchanged: [], completedSetup: 0 };
  const config = {
    ...baseConfig,
    incomplete: [],
    panel: { enabled: true, port: 0, password: bypass ? null : password, bypassAuth: bypass, bind: '127.0.0.1' },
  };
  const adapters = {
    spotify: {
      buildAuthorizeUrl: ({ redirectUri, state }) => `https://accounts.spotify.com/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
      exchangeCode: async (args) => calls.exchanged.push(['spotify', args]),
      describeAuth: () => ({ authorized: true }),
      listOwnPlaylists: async () => [{ id: 'p1', name: 'One', count: 3 }],
    },
    tidal: {
      buildAuthorizeUrl: ({ state }) => `https://login.tidal.com/authorize?state=${state}`,
      exchangeCode: async (args) => calls.exchanged.push(['tidal', args]),
      describeAuth: () => ({ authorized: true }),
      listOwnPlaylists: async () => [],
    },
  };
  const runtime = {
    calls,
    config: () => config,
    adapters: () => adapters,
    overview: () => ({ phase: 'idle', pairs: [], needsSetup: false }),
    applySettings: async (patch) => {
      calls.applied.push(patch);
      if (patch.__bad) {
        const err = new Error('Invalid configuration');
        err.problems = ['SYNC_MODE bad'];
        throw err;
      }
      return config;
    },
    triggerSync: () => (calls.synced++ === 1 ? { busy: true } : { started: true }),
    completeSetup: async () => calls.completedSetup++,
    onConnected: () => {},
    unmatchedReport: () => ({ generatedAt: null, unmatched: [] }),
  };
  return runtime;
}

async function startServer(runtime) {
  const { app } = createWebServer({ runtime, logger: silentLogger });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base };
}

const servers = [];
after(() => servers.forEach((s) => s.close()));

async function setup(opts) {
  const runtime = stubRuntime(opts);
  const { server, base } = await startServer(runtime);
  servers.push(server);
  return { runtime, base };
}

test('api is locked without a session and login issues a cookie', async () => {
  const { base } = await setup();
  assert.equal((await fetch(`${base}/api/overview`)).status, 401);

  const bad = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'nope' }),
  });
  assert.equal(bad.status, 401);

  const good = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'hunter2' }),
  });
  assert.equal(good.status, 200);
  const cookie = good.headers.get('set-cookie');
  assert.match(cookie, /musicsync_session=/);
  assert.match(cookie, /HttpOnly/);

  const authed = await fetch(`${base}/api/overview`, { headers: { cookie } });
  assert.equal(authed.status, 200);
  assert.equal((await authed.json()).phase, 'idle');
});

test('bypass mode opens the api without login', async () => {
  const { base } = await setup({ bypass: true });
  const res = await fetch(`${base}/api/overview`);
  assert.equal(res.status, 200);
});

test('settings PUT applies patch and surfaces validation problems', async () => {
  const { runtime, base } = await setup({ bypass: true });
  const ok = await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sync: { mode: 'two-way' } }),
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(runtime.calls.applied[0], { sync: { mode: 'two-way' } });

  const bad = await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ __bad: true }),
  });
  assert.equal(bad.status, 400);
  assert.deepEqual((await bad.json()).problems, ['SYNC_MODE bad']);
});

test('sync trigger reports busy with 409', async () => {
  const { base } = await setup({ bypass: true });
  assert.equal((await fetch(`${base}/api/sync`, { method: 'POST' })).status, 200);
  assert.equal((await fetch(`${base}/api/sync`, { method: 'POST' })).status, 409);
});

test('oauth roundtrip: authorize redirect carries state, callback exchanges code', async () => {
  const { runtime, base } = await setup({ bypass: true });
  const authRes = await fetch(`${base}/auth/spotify`, { redirect: 'manual' });
  assert.equal(authRes.status, 302);
  const location = new URL(authRes.headers.get('location'));
  const state = location.searchParams.get('state');
  assert.ok(state);
  assert.match(decodeURIComponent(location.searchParams.get('redirect_uri')), /\/callback\/spotify$/);

  const badCb = await fetch(`${base}/callback/spotify?code=abc&state=WRONG`, { redirect: 'manual' });
  assert.match(badCb.headers.get('location'), /authError=/);
  assert.equal(runtime.calls.exchanged.length, 0);

  // state survives one failed attempt (bad state must not consume it)
  const goodCb = await fetch(`${base}/callback/spotify?code=abc&state=${state}`, { redirect: 'manual' });
  assert.match(goodCb.headers.get('location'), /connected=spotify/);
  assert.equal(runtime.calls.exchanged[0][0], 'spotify');
  assert.equal(runtime.calls.exchanged[0][1].code, 'abc');
});

test('manual auth accepts a pasted callback URL', async () => {
  const { runtime, base } = await setup({ bypass: true });
  const authRes = await fetch(`${base}/auth/tidal`, { redirect: 'manual' });
  const state = new URL(authRes.headers.get('location')).searchParams.get('state');
  const res = await fetch(`${base}/api/auth/manual`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: `http://127.0.0.1:8080/callback/tidal?code=tc&state=${state}` }),
  });
  assert.equal(res.status, 200);
  const tidalCall = runtime.calls.exchanged.find(([p]) => p === 'tidal');
  assert.equal(tidalCall[1].code, 'tc');
  assert.ok(tidalCall[1].verifier, 'PKCE verifier must reach the exchange');
});

test('playlists endpoint proxies the adapter', async () => {
  const { base } = await setup({ bypass: true });
  const res = await fetch(`${base}/api/playlists/spotify`);
  assert.deepEqual(await res.json(), { playlists: [{ id: 'p1', name: 'One', count: 3 }] });
});

test('redirect URIs follow panel.appUrl (reverse-proxy support)', async () => {
  const runtime = stubRuntime({ bypass: true });
  runtime.config().panel.appUrl = 'https://musicsync.example.com';
  const { server, base } = await startServer(runtime);
  servers.push(server);
  const authRes = await fetch(`${base}/auth/spotify`, { redirect: 'manual' });
  const location = new URL(authRes.headers.get('location'));
  assert.equal(
    decodeURIComponent(location.searchParams.get('redirect_uri')),
    'https://musicsync.example.com/callback/spotify',
  );
  const settings = await (await fetch(`${base}/api/settings`)).json();
  assert.equal(settings.redirectUris.tidal, 'https://musicsync.example.com/callback/tidal');
});

test('static assets are served with no-cache so deploys take effect immediately', async () => {
  const { base } = await setup({ bypass: true });
  for (const asset of ['/app.js', '/style.css', '/']) {
    const res = await fetch(`${base}${asset}`);
    assert.equal(res.status, 200, asset);
    assert.equal(res.headers.get('cache-control'), 'no-cache', asset);
    assert.ok(res.headers.get('etag'), `${asset} keeps ETag revalidation`);
  }
});
