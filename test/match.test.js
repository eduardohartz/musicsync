import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTitle, simpleTitle, isLatinScript, versionConflict,
  fallbackMatches, pickCandidate, createMatcher,
} from '../src/match.js';
import { createStateStore } from '../src/state.js';
import { silentLogger, tmpDir } from './helpers.js';

const track = (over = {}) => ({
  id: 'm1', isrc: 'USRC17607839', title: 'Song Title', version: null,
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
  const tidal = {
    findTracksByIsrc: async () => { calls.isrc++; return isrcResults; },
    searchTracks: async () => { calls.search++; return searchResults; },
  };
  return { matcher: createMatcher({ adapters: { tidal }, state, overrides, logger: silentLogger, retryRuns }), state, calls };
}

test('override wins before cache and lookups', async () => {
  const { matcher, calls } = makeMatcher({ overrides: { 'spotify:m1': 'forced-id' } });
  const result = await matcher.matchTrack(track(), 'spotify', 'tidal');
  assert.deepEqual(result, { matchedId: 'forced-id', matchedBy: 'manual' });
  assert.equal(calls.isrc + calls.search, 0);
});

test('isrc match is cached; second call skips the API', async () => {
  const { matcher, calls, state } = makeMatcher({ isrcResults: [{ id: 's9', title: 'Song Title', durationMs: 200000 }] });
  const first = await matcher.matchTrack(track(), 'spotify', 'tidal');
  assert.deepEqual(first, { matchedId: 's9', matchedBy: 'isrc' });
  const second = await matcher.matchTrack(track(), 'spotify', 'tidal');
  assert.deepEqual(second, { matchedId: 's9', matchedBy: 'isrc' });
  assert.equal(calls.isrc, 1);
  assert.equal(state.data.mappings['spotify:m1'].isrc, 'USRC17607839');
});

test('falls back to metadata search when isrc misses', async () => {
  const { matcher } = makeMatcher({
    isrcResults: [],
    searchResults: [
      { id: 'bad', title: 'Song Title', artists: ['Some Artist'], durationMs: 250000 },
      { id: 'good', title: 'Song Title', artists: ['Some Artist'], durationMs: 200500 },
    ],
  });
  assert.deepEqual(await matcher.matchTrack(track(), 'spotify', 'tidal'), { matchedId: 'good', matchedBy: 'fallback' });
});

test('unmatched goes to failure cache and is not retried until retryRuns elapse', async () => {
  const { matcher, calls, state } = makeMatcher({ retryRuns: 3 });
  const first = await matcher.matchTrack(track(), 'spotify', 'tidal');
  assert.equal(first.unmatched, true);
  assert.equal(first.reason, 'no-match-on-target');
  const cachedMiss = await matcher.matchTrack(track(), 'spotify', 'tidal');
  assert.equal(cachedMiss.fromFailureCache, true);
  assert.equal(calls.isrc, 1, 'no second lookup while cached');
  state.data.runCount += 3;
  await matcher.matchTrack(track(), 'spotify', 'tidal');
  assert.equal(calls.isrc, 2, 'retried after retryRuns runs');
});

test('single ISRC candidate is authoritative even with one-sided version label', async () => {
  const { matcher } = makeMatcher({
    isrcResults: [{ id: 'remix-id', title: 'Song', version: 'Remix', durationMs: 200000 }],
  });
  assert.deepEqual(await matcher.matchTrack(track({ title: 'Song' }), 'spotify', 'tidal'),
    { matchedId: 'remix-id', matchedBy: 'isrc' });
});

test('multiple all-conflicting ISRC candidates fall back to closest duration', async () => {
  const { matcher } = makeMatcher({
    isrcResults: [
      { id: 'far', title: 'Song (Remix)', durationMs: 190000 },
      { id: 'near', title: 'Song (Remix)', durationMs: 200100 },
    ],
  });
  assert.deepEqual(await matcher.matchTrack(track({ title: 'Song' }), 'spotify', 'tidal'),
    { matchedId: 'near', matchedBy: 'isrc' });
});

test('successful match records the reverse mapping for two-way cache hits', async () => {
  const { matcher, state } = makeMatcher({ isrcResults: [{ id: 't42', title: 'Song Title', isrc: 'ISRC1', durationMs: 200000 }] });
  await matcher.matchTrack(track(), 'spotify', 'tidal');
  assert.equal(state.data.mappings['spotify:m1'].matchedId, 't42');
  assert.equal(state.data.mappings['tidal:t42'].matchedId, 'm1');
});

test('normalizeIsrc uppercases, strips separators, rejects malformed', async () => {
  const { normalizeIsrc } = await import('../src/match.js');
  assert.equal(normalizeIsrc('uscgh2229370'), 'USCGH2229370');
  assert.equal(normalizeIsrc('US-CGH-22-29370'), 'USCGH2229370');
  assert.equal(normalizeIsrc('bxg6r1900639'), 'BXG6R1900639');
  assert.equal(normalizeIsrc('too-short'), null);
  assert.equal(normalizeIsrc(''), null);
  assert.equal(normalizeIsrc(null), null);
});

test('lowercase source ISRC is normalized before the lookup call', async () => {
  const state = createStateStore(tmpDir());
  const seen = [];
  const tidal = {
    findTracksByIsrc: async (isrc) => { seen.push(isrc); return [{ id: 't1', title: 'Song Title', isrc, durationMs: 200000 }]; },
    searchTracks: async () => [],
  };
  const matcher = createMatcher({ adapters: { tidal }, state, logger: silentLogger, retryRuns: 10 });
  const result = await matcher.matchTrack(track({ isrc: 'uscgh2229370' }), 'spotify', 'tidal');
  assert.deepEqual(seen, ['USCGH2229370']);
  assert.equal(result.matchedId, 't1');
  assert.equal(state.data.mappings['spotify:m1'].isrc, 'USCGH2229370');
});

test('ISRC lookup error falls back to search instead of failing the pair', async () => {
  const state = createStateStore(tmpDir());
  const tidal = {
    findTracksByIsrc: async () => { const e = new Error('tidal API error 400 (GENERIC_REQUEST_ERROR)'); throw e; },
    searchTracks: async () => [{ id: 'via-search', title: 'Song Title', artists: ['Some Artist'], durationMs: 200000 }],
  };
  const matcher = createMatcher({ adapters: { tidal }, state, logger: silentLogger, retryRuns: 10 });
  const result = await matcher.matchTrack(track(), 'spotify', 'tidal');
  assert.deepEqual(result, { matchedId: 'via-search', matchedBy: 'fallback' });
});

test('total lookup failure is transient: reported unmatched but NOT failure-cached', async () => {
  const state = createStateStore(tmpDir());
  let calls = 0;
  const tidal = {
    findTracksByIsrc: async () => { calls++; throw new Error('400'); },
    searchTracks: async () => { throw new Error('400'); },
  };
  const matcher = createMatcher({ adapters: { tidal }, state, logger: silentLogger, retryRuns: 10 });
  const first = await matcher.matchTrack(track(), 'spotify', 'tidal');
  assert.equal(first.unmatched, true);
  assert.equal(first.reason, 'lookup-failed');
  assert.equal(first.transient, true);
  assert.deepEqual(state.data.failures, {}, 'transient errors must not poison the retry cache');
  await matcher.matchTrack(track(), 'spotify', 'tidal');
  assert.equal(calls, 2, 'retried immediately on the next attempt, no cache cooldown');
});

test('AuthRequiredError still propagates out of lookups', async () => {
  const { AuthRequiredError } = await import('../src/http.js');
  const state = createStateStore(tmpDir());
  const tidal = { findTracksByIsrc: async () => { throw new AuthRequiredError('tidal'); }, searchTracks: async () => [] };
  const matcher = createMatcher({ adapters: { tidal }, state, logger: silentLogger, retryRuns: 10 });
  await assert.rejects(() => matcher.matchTrack(track(), 'spotify', 'tidal'), AuthRequiredError);
});
