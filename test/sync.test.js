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

function makeWorld({ pairs, dryRun = false, masterPlaylists = {}, slaveItems = {}, matcherMap = {} } = {}) {
  const config = { ...baseConfig, sync: { ...baseConfig.sync, pairs, dryRun } };
  const state = createStateStore(tmpDir());
  const calls = { masterItems: [], slaveWrites: [], created: [], slaveItemReads: [] };

  const master = {
    platform: 'spotify',
    listOwnPlaylists: async () => Object.entries(masterPlaylists).map(([id, p]) => ({ id, name: p.name })),
    getPlaylistMeta: async (id) => ({ id, name: masterPlaylists[id].name, changeToken: masterPlaylists[id].changeToken }),
    getPlaylistItems: async (id) => {
      calls.masterItems.push(id);
      return masterPlaylists[id].items;
    },
  };
  const slave = {
    platform: 'tidal',
    createPlaylist: async ({ name }) => {
      const id = `slave-of-${name}`;
      calls.created.push(id);
      slaveItems[id] ??= { items: [], changeToken: 'fresh' };
      return { id };
    },
    getPlaylistMeta: async (id) => ({ id, name: 'x', changeToken: slaveItems[id]?.changeToken ?? 'fresh' }),
    getPlaylistItems: async (id) => {
      calls.slaveItemReads.push(id);
      return slaveItems[id]?.items ?? [];
    },
    setPlaylistItems: async (id, trackIds, currentItems) => {
      calls.slaveWrites.push({ id, trackIds, currentLength: currentItems.length });
    },
  };
  const matcher = {
    matchTrack: async (platform, track) => matcherMap[track.id]
      ?? { slaveTrackId: `s-${track.id}`, matchedBy: 'isrc' },
  };
  const engine = createSyncEngine({ config, master, slave, state, matcher, logger: silentLogger });
  return { engine, state, calls, config };
}

test('creates slave playlist, syncs, persists pair state and change tokens', async () => {
  const { engine, state, calls } = makeWorld({
    pairs: [{ masterId: 'm1', slaveId: null }],
    masterPlaylists: { m1: { name: 'Mix', changeToken: 'v1', items: [mTrack('a'), mTrack('b')] } },
  });
  const summary = await engine.runSync();
  assert.equal(summary.pairs[0].status, 'synced');
  assert.deepEqual(calls.created, ['slave-of-Mix']);
  assert.deepEqual(calls.slaveWrites, [{ id: 'slave-of-Mix', trackIds: ['s-a', 's-b'], currentLength: 0 }]);
  const pairState = state.data.pairs.m1;
  assert.equal(pairState.slavePlaylistId, 'slave-of-Mix');
  assert.equal(pairState.masterChangeToken, 'v1');
  assert.equal(pairState.unmatchedCount, 0);
});

test('short-circuits when both change tokens are unchanged and no unmatched', async () => {
  const { engine, state, calls } = makeWorld({
    pairs: [{ masterId: 'm1', slaveId: 'sl1' }],
    masterPlaylists: { m1: { name: 'Mix', changeToken: 'v1', items: [mTrack('a')] } },
    slaveItems: { sl1: { items: [{ id: 's-a' }], changeToken: 'ct-1' } },
  });
  state.data.pairs.m1 = {
    slavePlaylistId: 'sl1', masterChangeToken: 'v1', slaveChangeToken: 'ct-1', unmatchedCount: 0,
  };
  const summary = await engine.runSync();
  assert.equal(summary.pairs[0].status, 'skipped');
  assert.equal(calls.masterItems.length, 0, 'items must not be fetched on skip');
  assert.equal(calls.slaveWrites.length, 0);
});

test('re-attempts unchanged pair while unmatched tracks remain', async () => {
  const { engine, state, calls } = makeWorld({
    pairs: [{ masterId: 'm1', slaveId: 'sl1' }],
    masterPlaylists: { m1: { name: 'Mix', changeToken: 'v1', items: [mTrack('a')] } },
    slaveItems: { sl1: { items: [], changeToken: 'ct-1' } },
    matcherMap: { a: { unmatched: true, reason: 'no-match-on-slave' } },
  });
  state.data.pairs.m1 = {
    slavePlaylistId: 'sl1', masterChangeToken: 'v1', slaveChangeToken: 'ct-1', unmatchedCount: 1,
  };
  const summary = await engine.runSync();
  assert.equal(summary.pairs[0].status, 'synced');
  assert.equal(summary.unmatchedTotal, 1);
  assert.equal(calls.masterItems.length, 1);
});

test('unmatched and local tracks are excluded from target but reported', async () => {
  const { engine, calls } = makeWorld({
    pairs: [{ masterId: 'm1', slaveId: null }],
    masterPlaylists: {
      m1: { name: 'Mix', changeToken: 'v1', items: [mTrack('a'), mTrack('loc', { isLocal: true }), mTrack('b')] },
    },
    matcherMap: { b: { unmatched: true, reason: 'no-match-on-slave' } },
  });
  const summary = await engine.runSync();
  assert.deepEqual(calls.slaveWrites[0].trackIds, ['s-a']);
  assert.equal(summary.pairs[0].matched, 1);
  assert.equal(summary.pairs[0].unmatched, 1);
  assert.equal(summary.unmatchedTotal, 1);
});

test('one failing pair does not stop the next; failure is reported', async () => {
  const world = makeWorld({
    pairs: [{ masterId: 'bad', slaveId: null }, { masterId: 'good', slaveId: null }],
    masterPlaylists: {
      bad: { name: 'Bad', changeToken: 'v', items: [] },
      good: { name: 'Good', changeToken: 'v', items: [mTrack('a')] },
    },
  });
  world.engine = createSyncEngine({
    config: world.config,
    master: {
      ...{
        listOwnPlaylists: async () => [],
        getPlaylistMeta: async (id) => {
          if (id === 'bad') throw new Error('boom');
          return { id, name: 'Good', changeToken: 'v' };
        },
        getPlaylistItems: async () => [mTrack('a')],
      },
    },
    slave: {
      createPlaylist: async ({ name }) => ({ id: `slave-of-${name}` }),
      getPlaylistMeta: async (id) => ({ id, changeToken: 'c' }),
      getPlaylistItems: async () => [],
      setPlaylistItems: async () => {},
    },
    state: world.state,
    matcher: { matchTrack: async (p, t) => ({ slaveTrackId: `s-${t.id}`, matchedBy: 'isrc' }) },
    logger: silentLogger,
  });
  const summary = await world.engine.runSync();
  assert.equal(summary.pairs[0].status, 'failed');
  assert.match(summary.pairs[0].error, /boom/);
  assert.equal(summary.pairs[1].status, 'synced');
});

test('AuthRequiredError propagates out of the run', async () => {
  const { engine } = makeWorld({ pairs: [{ masterId: 'm1', slaveId: null }], masterPlaylists: { m1: { name: 'M', changeToken: 'v', items: [] } } });
  const broken = createSyncEngine({
    config: { ...baseConfig, sync: { ...baseConfig.sync, pairs: [{ masterId: 'm1', slaveId: null }] } },
    master: { getPlaylistMeta: async () => { throw new AuthRequiredError('spotify'); } },
    slave: {},
    state: createStateStore(tmpDir()),
    matcher: {},
    logger: silentLogger,
  });
  await assert.rejects(() => broken.runSync(), AuthRequiredError);
  void engine;
});

test('dry run computes diff but never writes or creates', async () => {
  const { engine, state, calls } = makeWorld({
    pairs: [{ masterId: 'm1', slaveId: null }, { masterId: 'm2', slaveId: 'sl2' }],
    dryRun: true,
    masterPlaylists: {
      m1: { name: 'New', changeToken: 'v1', items: [mTrack('a')] },
      m2: { name: 'Existing', changeToken: 'v2', items: [mTrack('b')] },
    },
    slaveItems: { sl2: { items: [{ id: 'stale' }], changeToken: 'ct' } },
  });
  const summary = await engine.runSync();
  assert.equal(calls.created.length, 0);
  assert.equal(calls.slaveWrites.length, 0);
  assert.equal(summary.pairs[0].status, 'dry-run');
  assert.equal(summary.pairs[1].status, 'dry-run');
  assert.equal(state.data.pairs.m2.masterChangeToken, undefined, 'tokens not persisted in dry run');
});

test('pairs=all expands to every master-owned playlist', async () => {
  const { engine, calls } = makeWorld({
    pairs: 'all',
    masterPlaylists: {
      p1: { name: 'One', changeToken: 'v', items: [mTrack('a')] },
      p2: { name: 'Two', changeToken: 'v', items: [mTrack('b')] },
    },
  });
  const summary = await engine.runSync();
  assert.equal(summary.pairs.length, 2);
  assert.deepEqual(calls.created.sort(), ['slave-of-One', 'slave-of-Two']);
});
