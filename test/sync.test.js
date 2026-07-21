import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSyncEngine } from '../src/sync.js';
import { createStateStore } from '../src/state.js';
import { AuthRequiredError } from '../src/http.js';
import { silentLogger, tmpDir, baseConfig } from './helpers.js';

const mTrack = (id, over = {}) => ({
  id, isrc: `IS${id}`, title: `T${id}`, version: null, artists: ['A'],
  album: null, durationMs: 1000, isLocal: false, ...over,
});

/**
 * Stub world: `spotifyLists`/`tidalLists` are {id: {name, changeToken, items}}.
 * The default matcher maps track id X → `s-X` (spotify→tidal) / strips the
 * prefix (tidal→spotify) unless matcherMap overrides.
 */
function makeWorld({ pairs, mode = 'one-way', source = 'spotify', dryRun = false, spotifyLists = {}, tidalLists = {}, matcherMap = {} } = {}) {
  const config = { ...baseConfig, sync: { ...baseConfig.sync, mode, source: mode === 'two-way' ? null : source, pairs, dryRun } };
  const state = createStateStore(tmpDir());
  const calls = {
    itemReads: [], writes: [], created: [], adds: [], removes: [],
  };

  const makeAdapter = (platform, lists) => ({
    platform,
    listOwnPlaylists: async () => Object.entries(lists).map(([id, p]) => ({ id, name: p.name })),
    getPlaylistMeta: async (id) => {
      const p = lists[id];
      if (!p) throw new Error(`no playlist ${id} on ${platform}`);
      return { id, name: p.name, changeToken: p.changeToken };
    },
    getPlaylistItems: async (id) => {
      calls.itemReads.push(`${platform}:${id}`);
      return lists[id]?.items ?? [];
    },
    createPlaylist: async ({ name }) => {
      const id = `${platform}-of-${name}`;
      calls.created.push(id);
      lists[id] = { name, changeToken: 'fresh', items: [] };
      return { id };
    },
    setPlaylistItems: async (id, trackIds, currentItems) => {
      calls.writes.push({ platform, id, trackIds, currentLength: currentItems.length });
      return { dropped: 0 };
    },
    addTracks: async (id, trackIds) => {
      calls.adds.push({ platform, id, trackIds });
      return { absent: [] };
    },
    removeTracks: async (id, entries) => {
      calls.removes.push({ platform, id, entries });
    },
  });

  const adapters = {
    spotify: makeAdapter('spotify', spotifyLists),
    tidal: makeAdapter('tidal', tidalLists),
  };
  const matcher = {
    matchTrack: async (track, from) => matcherMap[track.id]
      ?? (from === 'spotify'
        ? { matchedId: `s-${track.id}`, matchedBy: 'isrc' }
        : { matchedId: track.id.replace(/^s-/, ''), matchedBy: 'isrc' }),
  };
  const engine = createSyncEngine({ config, adapters, state, matcher, logger: silentLogger });
  return { engine, state, calls, config, adapters };
}

// ------------------------------------------------------------------ one-way

test('one-way: creates mirror, syncs, persists pair state and lastResult', async () => {
  const { engine, state, calls } = makeWorld({
    pairs: [{ primaryId: 'm1', secondaryId: null }],
    spotifyLists: { m1: { name: 'Mix', changeToken: 'v1', items: [mTrack('a'), mTrack('b')] } },
  });
  const summary = await engine.runSync();
  assert.equal(summary.pairs[0].status, 'synced');
  assert.deepEqual(calls.created, ['tidal-of-Mix']);
  assert.deepEqual(calls.writes, [{ platform: 'tidal', id: 'tidal-of-Mix', trackIds: ['s-a', 's-b'], currentLength: 0 }]);
  const ps = state.data.pairs.m1;
  assert.equal(ps.spotifyPlaylistId, 'm1');
  assert.equal(ps.tidalPlaylistId, 'tidal-of-Mix');
  assert.equal(ps.spotifyChangeToken, 'v1');
  assert.equal(ps.unmatchedCount, 0);
  assert.equal(ps.name, 'Mix');
  assert.deepEqual({ ...ps.lastResult, at: undefined }, { status: 'synced', matched: 2, total: 2, unmatched: 0, at: undefined });
});

test('one-way: tidal as source mirrors into spotify', async () => {
  const { engine, calls, state } = makeWorld({
    source: 'tidal',
    pairs: [{ primaryId: 'tp1', secondaryId: null }],
    tidalLists: { tp1: { name: 'From Tidal', changeToken: 'v1', items: [mTrack('s-x')] } },
  });
  await engine.runSync();
  assert.deepEqual(calls.created, ['spotify-of-From Tidal']);
  assert.equal(calls.writes[0].platform, 'spotify');
  assert.deepEqual(calls.writes[0].trackIds, ['x']);
  assert.equal(state.data.pairs.tp1.tidalPlaylistId, 'tp1');
});

test('one-way: short-circuits when both change tokens unchanged and no unmatched', async () => {
  const { engine, state, calls } = makeWorld({
    pairs: [{ primaryId: 'm1', secondaryId: 'td1' }],
    spotifyLists: { m1: { name: 'Mix', changeToken: 'v1', items: [mTrack('a')] } },
    tidalLists: { td1: { name: 'Mix', changeToken: 'ct-1', items: [{ id: 's-a' }] } },
  });
  state.data.pairs.m1 = {
    spotifyPlaylistId: 'm1', tidalPlaylistId: 'td1',
    spotifyChangeToken: 'v1', tidalChangeToken: 'ct-1', unmatchedCount: 0,
  };
  const summary = await engine.runSync();
  assert.equal(summary.pairs[0].status, 'skipped');
  assert.equal(calls.itemReads.length, 0);
});

test('one-way: unmatched and local tracks excluded from target but reported', async () => {
  const { engine, calls } = makeWorld({
    pairs: [{ primaryId: 'm1', secondaryId: null }],
    spotifyLists: {
      m1: { name: 'Mix', changeToken: 'v1', items: [mTrack('a'), mTrack('loc', { isLocal: true }), mTrack('b')] },
    },
    matcherMap: { b: { unmatched: true, reason: 'no-match-on-target' } },
  });
  const summary = await engine.runSync();
  assert.deepEqual(calls.writes[0].trackIds, ['s-a']);
  assert.equal(summary.pairs[0].matched, 1);
  assert.equal(summary.pairs[0].unmatched, 1);
  assert.equal(summary.unmatchedTotal, 1);
});

test('one-way: partial write leaves change tokens stale', async () => {
  const { engine, state, adapters } = makeWorld({
    pairs: [{ primaryId: 'm1', secondaryId: 'td1' }],
    spotifyLists: { m1: { name: 'Mix', changeToken: 'v2', items: [mTrack('a')] } },
    tidalLists: { td1: { name: 'Mix', changeToken: 'ct', items: [] } },
  });
  adapters.tidal.setPlaylistItems = async () => ({ dropped: 1 });
  await engine.runSync();
  assert.equal(state.data.pairs.m1.spotifyChangeToken, undefined);
});

test('one-way: dry run computes diff but never writes or creates', async () => {
  const { engine, state, calls } = makeWorld({
    pairs: [{ primaryId: 'm1', secondaryId: null }],
    dryRun: true,
    spotifyLists: { m1: { name: 'New', changeToken: 'v1', items: [mTrack('a')] } },
  });
  const summary = await engine.runSync();
  assert.equal(calls.created.length, 0);
  assert.equal(calls.writes.length, 0);
  assert.equal(summary.pairs[0].status, 'dry-run');
  assert.equal(state.data.pairs.m1.spotifyChangeToken, undefined);
});

test('one failing pair does not stop the next and records failed lastResult', async () => {
  const { engine, state } = makeWorld({
    pairs: [{ primaryId: 'bad', secondaryId: null }, { primaryId: 'good', secondaryId: null }],
    spotifyLists: { good: { name: 'Good', changeToken: 'v', items: [mTrack('a')] } }, // 'bad' missing → throws
  });
  const summary = await engine.runSync();
  assert.equal(summary.pairs[0].status, 'failed');
  assert.equal(summary.pairs[1].status, 'synced');
  assert.equal(state.data.pairs.bad.lastResult.status, 'failed');
});

test('AuthRequiredError propagates out of the run', async () => {
  const world = makeWorld({ pairs: [{ primaryId: 'm1', secondaryId: null }] });
  world.adapters.spotify.getPlaylistMeta = async () => { throw new AuthRequiredError('spotify'); };
  await assert.rejects(() => world.engine.runSync(), AuthRequiredError);
});

test('pairs=all expands to primary-platform owned playlists', async () => {
  const { engine, calls } = makeWorld({
    pairs: 'all',
    spotifyLists: {
      p1: { name: 'One', changeToken: 'v', items: [mTrack('a')] },
      p2: { name: 'Two', changeToken: 'v', items: [mTrack('b')] },
    },
  });
  const summary = await engine.runSync();
  assert.equal(summary.pairs.length, 2);
  assert.deepEqual(calls.created.sort(), ['tidal-of-One', 'tidal-of-Two']);
});

// ------------------------------------------------------------------ two-way

test('two-way first run: merges both sides, no removals, baseline persisted', async () => {
  const { engine, state, calls } = makeWorld({
    mode: 'two-way',
    pairs: [{ primaryId: 'sp1', secondaryId: 'td1' }],
    spotifyLists: { sp1: { name: 'Linked', changeToken: 'v1', items: [mTrack('a'), mTrack('b')] } },
    tidalLists: { td1: { name: 'Linked', changeToken: 'w1', items: [mTrack('s-b'), mTrack('s-c')] } },
  });
  const summary = await engine.runSync();
  assert.equal(summary.pairs[0].status, 'synced');
  // a missing on tidal → added; c missing on spotify → added; b on both
  assert.deepEqual(calls.adds, [
    { platform: 'tidal', id: 'td1', trackIds: ['s-a'] },
    { platform: 'spotify', id: 'sp1', trackIds: ['c'] },
  ]);
  assert.equal(calls.removes.length, 0);
  const baseline = state.data.pairs.sp1.baseline;
  assert.deepEqual(
    [...baseline].sort((x, y) => x.spotify.localeCompare(y.spotify)),
    [{ spotify: 'a', tidal: 's-a' }, { spotify: 'b', tidal: 's-b' }, { spotify: 'c', tidal: 's-c' }],
  );
  assert.equal(state.data.pairs.sp1.lastResult.matched, 3);
});

test('two-way with baseline: removals propagate both directions', async () => {
  const { engine, state, calls } = makeWorld({
    mode: 'two-way',
    pairs: [{ primaryId: 'sp1', secondaryId: 'td1' }],
    // baseline had a,b,c; user removed b on spotify and c on tidal
    spotifyLists: { sp1: { name: 'L', changeToken: 'v2', items: [mTrack('a'), mTrack('c')] } },
    tidalLists: { td1: { name: 'L', changeToken: 'w2', items: [mTrack('s-a', { itemId: 'it-a' }), mTrack('s-b', { itemId: 'it-b' })] } },
  });
  state.data.pairs.sp1 = {
    spotifyPlaylistId: 'sp1', tidalPlaylistId: 'td1',
    spotifyChangeToken: 'old', tidalChangeToken: 'old', unmatchedCount: 0,
    baseline: [
      { spotify: 'a', tidal: 's-a' },
      { spotify: 'b', tidal: 's-b' },
      { spotify: 'c', tidal: 's-c' },
    ],
  };
  await engine.runSync();
  // b removed on spotify → remove s-b from tidal (with itemId); c removed on tidal → remove c from spotify
  assert.deepEqual(calls.removes, [
    { platform: 'spotify', id: 'sp1', entries: [{ id: 'c' }] },
    { platform: 'tidal', id: 'td1', entries: [{ id: 's-b', itemId: 'it-b' }] },
  ]);
  assert.equal(calls.adds.length, 0);
  assert.deepEqual(state.data.pairs.sp1.baseline, [{ spotify: 'a', tidal: 's-a' }]);
});

test('two-way with baseline: adds propagate both directions and extend baseline', async () => {
  const { engine, state, calls } = makeWorld({
    mode: 'two-way',
    pairs: [{ primaryId: 'sp1', secondaryId: 'td1' }],
    spotifyLists: { sp1: { name: 'L', changeToken: 'v2', items: [mTrack('a'), mTrack('new-sp')] } },
    tidalLists: { td1: { name: 'L', changeToken: 'w2', items: [mTrack('s-a'), mTrack('s-new-td')] } },
  });
  state.data.pairs.sp1 = {
    spotifyPlaylistId: 'sp1', tidalPlaylistId: 'td1',
    spotifyChangeToken: 'old', tidalChangeToken: 'old', unmatchedCount: 0,
    baseline: [{ spotify: 'a', tidal: 's-a' }],
  };
  await engine.runSync();
  assert.deepEqual(calls.adds, [
    { platform: 'tidal', id: 'td1', trackIds: ['s-new-sp'] },
    { platform: 'spotify', id: 'sp1', trackIds: ['new-td'] },
  ]);
  const baseline = state.data.pairs.sp1.baseline;
  assert.equal(baseline.length, 3);
  assert.ok(baseline.some((p) => p.spotify === 'new-sp' && p.tidal === 's-new-sp'));
  assert.ok(baseline.some((p) => p.spotify === 'new-td' && p.tidal === 's-new-td'));
});

test('two-way: same track added on both sides forms one pair, no writes', async () => {
  const { engine, state, calls } = makeWorld({
    mode: 'two-way',
    pairs: [{ primaryId: 'sp1', secondaryId: 'td1' }],
    spotifyLists: { sp1: { name: 'L', changeToken: 'v2', items: [mTrack('x')] } },
    tidalLists: { td1: { name: 'L', changeToken: 'w2', items: [mTrack('s-x')] } },
  });
  state.data.pairs.sp1 = {
    spotifyPlaylistId: 'sp1', tidalPlaylistId: 'td1',
    spotifyChangeToken: 'old', tidalChangeToken: 'old', unmatchedCount: 0, baseline: [],
  };
  await engine.runSync();
  assert.equal(calls.adds.length, 0);
  assert.equal(calls.removes.length, 0);
  assert.deepEqual(state.data.pairs.sp1.baseline, [{ spotify: 'x', tidal: 's-x' }]);
});

test('two-way: tidal add that fails to land is kept out of the baseline', async () => {
  const world = makeWorld({
    mode: 'two-way',
    pairs: [{ primaryId: 'sp1', secondaryId: 'td1' }],
    spotifyLists: { sp1: { name: 'L', changeToken: 'v2', items: [mTrack('a'), mTrack('p')] } },
    tidalLists: { td1: { name: 'L', changeToken: 'w2', items: [mTrack('s-a')] } },
  });
  world.state.data.pairs.sp1 = {
    spotifyPlaylistId: 'sp1', tidalPlaylistId: 'td1',
    spotifyChangeToken: 'old', tidalChangeToken: 'old', unmatchedCount: 0,
    baseline: [{ spotify: 'a', tidal: 's-a' }],
  };
  world.adapters.tidal.addTracks = async () => ({ absent: ['s-p'] });
  await world.engine.runSync();
  const baseline = world.state.data.pairs.sp1.baseline;
  assert.equal(baseline.length, 1, 'failed add must not enter baseline (would read as removal next run)');
});

test('two-way: unmatched tracks stay platform-local and are reported', async () => {
  const { engine, state, calls } = makeWorld({
    mode: 'two-way',
    pairs: [{ primaryId: 'sp1', secondaryId: 'td1' }],
    spotifyLists: { sp1: { name: 'L', changeToken: 'v1', items: [mTrack('a'), mTrack('rare')] } },
    tidalLists: { td1: { name: 'L', changeToken: 'w1', items: [] } },
    matcherMap: { rare: { unmatched: true, reason: 'no-match-on-target' } },
  });
  const summary = await engine.runSync();
  assert.deepEqual(calls.adds, [{ platform: 'tidal', id: 'td1', trackIds: ['s-a'] }]);
  assert.equal(summary.unmatchedTotal, 1);
  assert.equal(state.data.pairs.sp1.unmatchedCount, 1);
  assert.equal(state.data.pairs.sp1.lastResult.total, 2);
});

test('two-way: dry run plans but never writes', async () => {
  const { engine, state, calls } = makeWorld({
    mode: 'two-way',
    dryRun: true,
    pairs: [{ primaryId: 'sp1', secondaryId: 'td1' }],
    spotifyLists: { sp1: { name: 'L', changeToken: 'v1', items: [mTrack('a')] } },
    tidalLists: { td1: { name: 'L', changeToken: 'w1', items: [] } },
  });
  const summary = await engine.runSync();
  assert.equal(calls.adds.length + calls.removes.length + calls.writes.length, 0);
  assert.equal(summary.pairs[0].status, 'dry-run');
  assert.equal(state.data.pairs.sp1.baseline, undefined);
});

test('two-way: auto-creates the tidal side from a bare spotify id', async () => {
  const { engine, state, calls } = makeWorld({
    mode: 'two-way',
    pairs: [{ primaryId: 'sp1', secondaryId: null }],
    spotifyLists: { sp1: { name: 'Solo', changeToken: 'v1', items: [mTrack('a')] } },
  });
  await engine.runSync();
  assert.deepEqual(calls.created, ['tidal-of-Solo']);
  assert.equal(state.data.pairs.sp1.tidalPlaylistId, 'tidal-of-Solo');
  assert.deepEqual(state.data.pairs.sp1.baseline, [{ spotify: 'a', tidal: 's-a' }]);
});

test('two-way: shared-ISRC duplicate removal does not cascade-delete (removal rescue)', async () => {
  // S1 and S2 both map to T1. Baseline knows only {S1,T1}. User deletes S1.
  const { engine, state, calls } = makeWorld({
    mode: 'two-way',
    pairs: [{ primaryId: 'sp1', secondaryId: 'td1' }],
    spotifyLists: { sp1: { name: 'L', changeToken: 'v2', items: [mTrack('S2')] } },
    tidalLists: { td1: { name: 'L', changeToken: 'w2', items: [mTrack('T1', { itemId: 'it1' })] } },
    matcherMap: { S2: { matchedId: 'T1', matchedBy: 'isrc' } },
  });
  state.data.pairs.sp1 = {
    spotifyPlaylistId: 'sp1', tidalPlaylistId: 'td1',
    spotifyChangeToken: 'old', tidalChangeToken: 'old', unmatchedCount: 0,
    baseline: [{ spotify: 'S1', tidal: 'T1' }],
  };
  await engine.runSync();
  assert.equal(calls.removes.length, 0, 'T1 must be rescued — S2 still maps to it');
  assert.deepEqual(state.data.pairs.sp1.baseline, [{ spotify: 'S2', tidal: 'T1' }]);
});

test('two-way: one id never enters two baseline pairs (covered on both sides)', async () => {
  // S1 (new on spotify) matches T5; T9 (new on tidal) also matches S1.
  const { engine, state } = makeWorld({
    mode: 'two-way',
    pairs: [{ primaryId: 'sp1', secondaryId: 'td1' }],
    spotifyLists: { sp1: { name: 'L', changeToken: 'v2', items: [mTrack('S1')] } },
    tidalLists: { td1: { name: 'L', changeToken: 'w2', items: [mTrack('T9', { itemId: 'it9' })] } },
    matcherMap: {
      S1: { matchedId: 'T5', matchedBy: 'isrc' },
      T9: { matchedId: 'S1', matchedBy: 'isrc' },
    },
  });
  state.data.pairs.sp1 = {
    spotifyPlaylistId: 'sp1', tidalPlaylistId: 'td1',
    spotifyChangeToken: 'old', tidalChangeToken: 'old', unmatchedCount: 0, baseline: [],
  };
  await engine.runSync();
  const baseline = state.data.pairs.sp1.baseline;
  const spotifyIds = baseline.map((p) => p.spotify);
  assert.equal(new Set(spotifyIds).size, spotifyIds.length, `duplicate spotify id in baseline: ${JSON.stringify(baseline)}`);
  const tidalIds = baseline.map((p) => p.tidal);
  assert.equal(new Set(tidalIds).size, tidalIds.length, 'duplicate tidal id in baseline');
});

test('two-way: re-pointing the pair to another playlist resets baseline (no mass delete)', async () => {
  const { engine, state, calls } = makeWorld({
    mode: 'two-way',
    pairs: [{ primaryId: 'sp1', secondaryId: 'tdB' }],
    spotifyLists: { sp1: { name: 'L', changeToken: 'v9', items: [mTrack('a'), mTrack('b')] } },
    tidalLists: { tdB: { name: 'Other', changeToken: 'w1', items: [] } },
  });
  state.data.pairs.sp1 = {
    spotifyPlaylistId: 'sp1', tidalPlaylistId: 'tdA',
    spotifyChangeToken: 'v9', tidalChangeToken: 'stale', unmatchedCount: 0,
    baseline: [{ spotify: 'x1', tidal: 'y1' }, { spotify: 'x2', tidal: 'y2' }],
  };
  await engine.runSync();
  assert.equal(calls.removes.length, 0, 're-pointed pair must merge, never remove');
  assert.equal(state.data.pairs.sp1.tidalPlaylistId, 'tdB');
  assert.deepEqual(calls.adds[0], { platform: 'tidal', id: 'tdB', trackIds: ['s-a', 's-b'] });
});

test('two-way: dropped tidal adds leave the tidal change token stale for retry', async () => {
  const world = makeWorld({
    mode: 'two-way',
    pairs: [{ primaryId: 'sp1', secondaryId: 'td1' }],
    spotifyLists: { sp1: { name: 'L', changeToken: 'v2', items: [mTrack('a'), mTrack('p')] } },
    tidalLists: { td1: { name: 'L', changeToken: 'w2', items: [mTrack('s-a')] } },
  });
  world.state.data.pairs.sp1 = {
    spotifyPlaylistId: 'sp1', tidalPlaylistId: 'td1',
    spotifyChangeToken: 'old', tidalChangeToken: 'old', unmatchedCount: 0,
    baseline: [{ spotify: 'a', tidal: 's-a' }],
  };
  world.adapters.tidal.addTracks = async () => ({ absent: ['s-p'] });
  await world.engine.runSync();
  const ps = world.state.data.pairs.sp1;
  assert.equal(ps.tidalChangeToken, undefined, 'token must stay stale so the drop is retried');
  assert.equal(ps.spotifyChangeToken, 'v2', 'untouched platform keeps its pre-read token');
});

test('two-way: written platforms leave tokens stale; untouched platforms persist pre-read tokens', async () => {
  const { engine, state } = makeWorld({
    mode: 'two-way',
    pairs: [{ primaryId: 'sp1', secondaryId: 'td1' }],
    spotifyLists: { sp1: { name: 'L', changeToken: 'v2', items: [mTrack('a'), mTrack('new')] } },
    tidalLists: { td1: { name: 'L', changeToken: 'w2', items: [mTrack('s-a')] } },
  });
  state.data.pairs.sp1 = {
    spotifyPlaylistId: 'sp1', tidalPlaylistId: 'td1',
    spotifyChangeToken: 'old', tidalChangeToken: 'old', unmatchedCount: 0,
    baseline: [{ spotify: 'a', tidal: 's-a' }],
  };
  await engine.runSync();
  const ps = state.data.pairs.sp1;
  assert.equal(ps.spotifyChangeToken, 'v2', 'spotify untouched — pre-read token persisted');
  assert.equal(ps.tidalChangeToken, undefined, 'tidal was written — token left stale');
});

test('two-way: spotify removals carry the snapshot guard from the pre-read meta', async () => {
  const removeArgs = [];
  const world = makeWorld({
    mode: 'two-way',
    pairs: [{ primaryId: 'sp1', secondaryId: 'td1' }],
    spotifyLists: { sp1: { name: 'L', changeToken: 'snap-42', items: [mTrack('a'), mTrack('gone')] } },
    tidalLists: { td1: { name: 'L', changeToken: 'w2', items: [mTrack('s-a')] } },
  });
  world.adapters.spotify.removeTracks = async (id, entries, opts) => removeArgs.push({ id, entries, opts });
  world.state.data.pairs.sp1 = {
    spotifyPlaylistId: 'sp1', tidalPlaylistId: 'td1',
    spotifyChangeToken: 'old', tidalChangeToken: 'old', unmatchedCount: 0,
    baseline: [{ spotify: 'a', tidal: 's-a' }, { spotify: 'gone', tidal: 's-gone' }],
  };
  await world.engine.runSync();
  assert.equal(removeArgs.length, 1);
  assert.deepEqual(removeArgs[0].opts, { snapshotId: 'snap-42' });
});
