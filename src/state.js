import path from 'node:path';
import { readJson, writeJsonAtomic } from './store.js';

const DEFAULT_STATE = {
  runCount: 0,
  pairs: {},     // masterPlaylistId -> {slavePlaylistId, masterChangeToken, slaveChangeToken, lastSyncedAt}
  mappings: {},  // `${masterPlatform}:${trackId}` -> {slaveTrackId, matchedBy, isrc}
  failures: {},  // `${masterPlatform}:${trackId}` -> {reason, failedAtRun, track: {title, artists}}
};

/** Persistent sync state plus the unmatched-tracks report. */
export function createStateStore(configDir, logger) {
  const file = path.join(configDir, 'state.json');
  const reportFile = path.join(configDir, 'unmatched.json');
  const store = {
    file,
    reportFile,
    data: null,
    load() {
      store.data = { ...structuredClone(DEFAULT_STATE), ...readJson(file, DEFAULT_STATE, logger) };
      return store.data;
    },
    save() {
      writeJsonAtomic(file, store.data);
    },
    writeUnmatchedReport(entries) {
      writeJsonAtomic(reportFile, { generatedAt: new Date().toISOString(), unmatched: entries });
    },
  };
  store.load();
  return store;
}
