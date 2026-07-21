import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../src/logger.js';
import { createTokenStore } from '../src/tokens.js';

export const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'musicsync-test-'));

export const silentLogger = createLogger('error', { out: { write() {} }, err: { write() {} } });

/**
 * Route-based fetch mock. Handlers: [{match: (url, opts) => bool, reply: (url, opts) => ({status, body, headers?})}].
 * Records every call as {url, opts}. Unmatched URLs throw.
 */
export function routedFetch(handlers) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url, opts });
    const handler = handlers.find((h) => h.match(url, opts));
    if (!handler) throw new Error(`unmocked fetch: ${opts.method ?? 'GET'} ${url}`);
    const res = typeof handler.reply === 'function' ? handler.reply(url, opts) : handler.reply;
    return {
      ok: res.status < 400,
      status: res.status,
      headers: { get: (h) => res.headers?.[h] ?? null },
      text: async () => (res.body === undefined ? '' : JSON.stringify(res.body)),
    };
  };
  return { impl, calls };
}

export function seededTokens({ spotify, tidal, tidalCc } = {}) {
  const dir = tmpDir();
  const tokens = createTokenStore(dir);
  const future = new Date(Date.now() + 3600_000).toISOString();
  if (spotify !== false) {
    tokens.set('spotify', {
      accessToken: 'sp-access', expiresAt: future, refreshToken: 'sp-refresh',
      authorizedAt: new Date().toISOString(), ...spotify,
    });
  }
  if (tidal !== false) {
    tokens.set('tidal', {
      accessToken: 'td-access', expiresAt: future, refreshToken: 'td-refresh',
      authorizedAt: new Date().toISOString(), ...tidal,
    });
  }
  if (tidalCc !== false) {
    tokens.set('tidal-cc', { accessToken: 'td-cc-access', expiresAt: future, ...tidalCc });
  }
  return tokens;
}

export const instantSleep = async () => {};

export const baseConfig = {
  spotify: { clientId: 'scid', clientSecret: 'ssec', market: 'DE', playlistPublic: false },
  tidal: { clientId: 'tcid', clientSecret: 'tsec', accessType: 'UNLISTED' },
  sync: {
    mode: 'one-way', source: 'spotify', pairs: [], periodic: true, cron: '0 */6 * * *',
    onStart: true, tz: undefined, dryRun: false, matchRetryRuns: 10,
  },
  panel: { enabled: false, port: 8080, password: null, bypassAuth: false, bind: '127.0.0.1', appUrl: 'http://127.0.0.1:8080' },
  configDir: '/tmp/unused',
  logLevel: 'error',
  incomplete: [],
};
