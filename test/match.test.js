import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTitle, simpleTitle, isLatinScript, versionConflict,
  fallbackMatches, pickCandidate, createMatcher,
} from '../src/match.js';
import { createStateStore } from '../src/state.js';
import { silentLogger, tmpDir } from './helpers.js';

const track = (over = {}) => ({
  id: 'm1', isrc: 'ISRC1', title: 'Song Title', version: null,
  artists: ['Some Artist'], album: 'The Album', durationMs: 200000, isLocal: false, ...over,
});

test('normalizeTitle folds accents for Latin but preserves CJK', () => {
  assert.equal(normalizeTitle('Beyoncé — Déjà Vu'), 'beyonce — deja vu');
  assert.equal(normalizeTitle('残酷な天使のテーゼ'), '残酷な天使のテーゼ'); // regression: NFD strip must not delete CJK
  assert.equal(isLatinScript('Déjà'), true);
  assert.equal(isLatinScript('テーゼ'), false);
});

test('simpleTitle strips version suffixes', () => {
  assert.equal(simpleTitle('Song (Remastered 2011)'), 'song');
  assert.equal(simpleTitle('Song [Live]'), 'song');
  assert.equal(simpleTitle('Song - 2004 Remaster'), 'song');
  assert.equal(simpleTitle('T-Shirt'), 't-shirt'); // hyphen without spaces survives
});

test('versionConflict fires on one-sided markers, checks TIDAL version field', () => {
  assert.equal(versionConflict(track({ title: 'Song' }), { title: 'Song (Remix)' }), true);
  assert.equal(versionConflict(track({ title: 'Song (Remix)' }), { title: 'Song', version: 'Remix' }), false);
  assert.equal(versionConflict(track({ title: 'Song' }), { title: 'Song', version: 'Instrumental' }), true);
  assert.equal(versionConflict(track({ title: 'Song Remix' }), { title: 'Song Remix' }), false);
});

test('fallbackMatches enforces duration, title inclusion, artist overlap', () => {
  const master = track();
  assert.equal(fallbackMatches(master, { title: 'Song Title', artists: ['Some Artist'], durationMs: 201999 }), true);
  assert.equal(fallbackMatches(master, { title: 'Song Title', artists: ['Some Artist'], durationMs: 202000 }), false);
  assert.equal(fallbackMatches(master, { title: 'Song Title (Deluxe)', artists: ['Some Artist'], durationMs: 200000 }), true);
  assert.equal(fallbackMatches(master, { title: 'Entirely Different', artists: ['Some Artist'], durationMs: 200000 }), false);
  assert.equal(fallbackMatches(master, { title: 'Song Title', artists: ['Nobody'], durationMs: 200000 }), false);
  assert.equal(fallbackMatches(master, { title: 'Song Title (Remix)', artists: ['Some Artist'], durationMs: 200000 }), false);
});

test('pickCandidate is deterministic regardless of input order', () => {
  const master = track();
  const a = { id: 'aaa', title: 'Song Title', durationMs: 200100 };
  const b = { id: 'bbb', title: 'Song Title', durationMs: 200100 };
  const c = { id: 'ccc', title: 'Song Title', durationMs: 205000 };
  assert.equal(pickCandidate(master, [c, b, a]).id, 'aaa');
  assert.equal(pickCandidate(master, [a, c, b]).id, 'aaa');
  assert.equal(pickCandidate(master, [{ id: 'r', title: 'Song (Remix)', durationMs: 200000 }]), null);
});

function makeMatcher({ overrides = {}, retryRuns = 10, isrcResults = [], searchResults = [] } = {}) {
  const state = createStateStore(tmpDir());
  const calls = { isrc: 0, search: 0 };
  const slave = {
    findTracksByIsrc: async () => { calls.isrc++; return isrcResults; },
    searchTracks: async () => { calls.search++; return searchResults; },
  };
  return { matcher: createMatcher({ slave, state, overrides, logger: silentLogger, retryRuns }), state, calls };
}

test('override wins before cache and lookups', async () => {
  const { matcher, calls } = makeMatcher({ overrides: { 'spotify:m1': 'forced-id' } });
  const result = await matcher.matchTrack('spotify', track());
  assert.deepEqual(result, { slaveTrackId: 'forced-id', matchedBy: 'manual' });
  assert.equal(calls.isrc + calls.search, 0);
});

test('isrc match is cached; second call skips the API', async () => {
  const { matcher, calls, state } = makeMatcher({ isrcResults: [{ id: 's9', title: 'Song Title', durationMs: 200000 }] });
  const first = await matcher.matchTrack('spotify', track());
  assert.deepEqual(first, { slaveTrackId: 's9', matchedBy: 'isrc' });
  const second = await matcher.matchTrack('spotify', track());
  assert.deepEqual(second, { slaveTrackId: 's9', matchedBy: 'isrc' });
  assert.equal(calls.isrc, 1);
  assert.equal(state.data.mappings['spotify:m1'].isrc, 'ISRC1');
});

test('falls back to metadata search when isrc misses', async () => {
  const { matcher } = makeMatcher({
    isrcResults: [],
    searchResults: [
      { id: 'bad', title: 'Song Title', artists: ['Some Artist'], durationMs: 250000 },
      { id: 'good', title: 'Song Title', artists: ['Some Artist'], durationMs: 200500 },
    ],
  });
  assert.deepEqual(await matcher.matchTrack('spotify', track()), { slaveTrackId: 'good', matchedBy: 'fallback' });
});

test('unmatched goes to failure cache and is not retried until retryRuns elapse', async () => {
  const { matcher, calls, state } = makeMatcher({ retryRuns: 3 });
  const first = await matcher.matchTrack('spotify', track());
  assert.equal(first.unmatched, true);
  assert.equal(first.reason, 'no-match-on-slave');
  const cachedMiss = await matcher.matchTrack('spotify', track());
  assert.equal(cachedMiss.fromFailureCache, true);
  assert.equal(calls.isrc, 1, 'no second lookup while cached');
  state.data.runCount += 3;
  await matcher.matchTrack('spotify', track());
  assert.equal(calls.isrc, 2, 'retried after retryRuns runs');
});

test('single ISRC candidate is authoritative even with one-sided version label', async () => {
  const { matcher } = makeMatcher({
    isrcResults: [{ id: 'remix-id', title: 'Song', version: 'Remix', durationMs: 200000 }],
  });
  assert.deepEqual(await matcher.matchTrack('spotify', track({ title: 'Song' })),
    { slaveTrackId: 'remix-id', matchedBy: 'isrc' });
});

test('multiple all-conflicting ISRC candidates fall back to closest duration', async () => {
  const { matcher } = makeMatcher({
    isrcResults: [
      { id: 'far', title: 'Song (Remix)', durationMs: 190000 },
      { id: 'near', title: 'Song (Remix)', durationMs: 200100 },
    ],
  });
  assert.deepEqual(await matcher.matchTrack('spotify', track({ title: 'Song' })),
    { slaveTrackId: 'near', matchedBy: 'isrc' });
});
