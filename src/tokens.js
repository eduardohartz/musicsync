import path from 'node:path';
import { readJson, writeJsonAtomic } from './store.js';

/**
 * Persistent OAuth token store: one JSON file (chmod 600) holding tokens per
 * service key ('spotify' | 'tidal' | 'tidal-cc').
 * Token shape: {accessToken, expiresAt, refreshToken, authorizedAt}.
 */
export function createTokenStore(configDir, logger) {
  const file = path.join(configDir, 'tokens.json');

  function readAll() {
    return readJson(file, {}, logger);
  }

  return {
    file,
    get(service) {
      return readAll()[service] ?? null;
    },
    set(service, tokens) {
      const all = readAll();
      all[service] = { ...all[service], ...tokens };
      writeJsonAtomic(file, all, { mode: 0o600 });
      return all[service];
    },
    clear(service) {
      const all = readAll();
      delete all[service];
      writeJsonAtomic(file, all, { mode: 0o600 });
    },
  };
}
