import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { parseCallbackUrl, servicesNeedingAuth, runAuthBootstrap } from '../src/auth/bootstrap.js';
import { seededTokens, silentLogger, baseConfig } from './helpers.js';

const pending = { spotify: { state: 'st-s' }, tidal: { state: 'st-t', verifier: 'v' } };

test('parseCallbackUrl extracts service and code from path or full URL', () => {
  assert.deepEqual(
    parseCallbackUrl('/callback/spotify?code=abc&state=st-s', pending),
    { service: 'spotify', code: 'abc' },
  );
  assert.deepEqual(
    parseCallbackUrl('http://127.0.0.1:8888/callback/tidal?code=xyz&state=st-t', pending),
    { service: 'tidal', code: 'xyz' },
  );
});

test('parseCallbackUrl rejects bad input', () => {
  assert.match(parseCallbackUrl('/callback/spotify?code=abc&state=WRONG', pending).error, /state mismatch/);
  assert.match(parseCallbackUrl('/callback/deezer?code=a&state=s', pending).error, /unexpected callback path/);
  assert.match(parseCallbackUrl('/callback/spotify?error=access_denied&state=st-s', pending).error, /denied/);
  assert.match(parseCallbackUrl('/callback/spotify?state=st-s', pending).error, /missing the code/);
  assert.match(parseCallbackUrl('/callback/spotify?code=a&state=st-s', { tidal: pending.tidal }).error, /no authorization pending/);
});

test('servicesNeedingAuth honors stored tokens and --force', () => {
  const both = seededTokens();
  assert.deepEqual(servicesNeedingAuth(both), []);
  assert.deepEqual(servicesNeedingAuth(both, { force: true }), ['spotify', 'tidal']);
  const onlySpotify = seededTokens({ tidal: false });
  assert.deepEqual(servicesNeedingAuth(onlySpotify), ['tidal']);
});

test('manual mode exchanges pasted URLs and skips junk lines', async () => {
  const tokens = seededTokens({ spotify: false, tidal: false, tidalCc: false });
  const exchanged = [];
  const urls = {};
  const adapters = {
    spotify: {
      buildAuthorizeUrl: ({ redirectUri, state }) => {
        urls.spotify = { redirectUri, state };
        return 'https://accounts.spotify.com/authorize?...';
      },
      exchangeCode: async ({ code, redirectUri }) => exchanged.push(['spotify', code, redirectUri]),
    },
    tidal: {
      buildAuthorizeUrl: ({ redirectUri, state, challenge }) => {
        urls.tidal = { redirectUri, state, challenge };
        return 'https://login.tidal.com/authorize?...';
      },
      exchangeCode: async ({ code, verifier }) => exchanged.push(['tidal', code, verifier]),
    },
  };

  // We need the generated states to build valid paste lines; capture via buildAuthorizeUrl.
  let stdinPush;
  const stdin = new Readable({ read() { stdinPush = (s) => this.push(s); } });
  const out = [];
  const run = runAuthBootstrap({
    config: baseConfig, tokens, adapters, logger: silentLogger,
    manual: true, stdin, stdout: { write: (s) => out.push(s) },
  });
  await new Promise((r) => setTimeout(r, 10));
  stdin.push('garbage line\n');
  stdin.push(`http://127.0.0.1:8888/callback/spotify?code=sc&state=${urls.spotify.state}\n`);
  stdin.push(`http://127.0.0.1:8888/callback/tidal?code=tc&state=${urls.tidal.state}\n`);
  stdin.push(null);

  const completed = await run;
  assert.deepEqual(completed.sort(), ['spotify', 'tidal']);
  assert.equal(exchanged.find(([s]) => s === 'spotify')[1], 'sc');
  const tidalCall = exchanged.find(([s]) => s === 'tidal');
  assert.equal(tidalCall[1], 'tc');
  assert.ok(tidalCall[2], 'tidal exchange must receive the PKCE verifier');
  assert.equal(urls.spotify.redirectUri, 'http://127.0.0.1:8888/callback/spotify');
  assert.ok(urls.tidal.challenge);
  assert.ok(out.some((s) => s.includes('✖')), 'junk line reported');
});

test('nothing to do when already authorized', async () => {
  const out = [];
  const completed = await runAuthBootstrap({
    config: baseConfig, tokens: seededTokens(), adapters: {}, logger: silentLogger,
    stdout: { write: (s) => out.push(s) },
  });
  assert.deepEqual(completed, []);
  assert.ok(out[0].includes('already authorized'));
});
