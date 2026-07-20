import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTwoWayOps } from '../src/twoway.js';

const baseline = [
  { spotify: 'a', tidal: 'ta' },
  { spotify: 'b', tidal: 'tb' },
  { spotify: 'c', tidal: 'tc' },
];

test('unchanged sides keep everything', () => {
  const ops = computeTwoWayOps({ baseline, spotifyIds: ['a', 'b', 'c'], tidalIds: ['ta', 'tb', 'tc'] });
  assert.deepEqual(ops.keep, baseline);
  assert.equal(ops.removeFromSpotify.length + ops.removeFromTidal.length, 0);
  assert.deepEqual(ops.newOnSpotify, []);
  assert.deepEqual(ops.newOnTidal, []);
});

test('removal on one side propagates to the other', () => {
  const ops = computeTwoWayOps({ baseline, spotifyIds: ['a', 'c'], tidalIds: ['ta', 'tb', 'tc'] });
  // b removed on spotify → still on tidal → remove from tidal
  assert.deepEqual(ops.removeFromTidal, [{ spotify: 'b', tidal: 'tb' }]);
  assert.deepEqual(ops.removeFromSpotify, []);
  assert.equal(ops.keep.length, 2);
});

test('removed on both sides is dropped silently', () => {
  const ops = computeTwoWayOps({ baseline, spotifyIds: ['a', 'b'], tidalIds: ['ta', 'tb'] });
  assert.equal(ops.keep.length, 2);
  assert.equal(ops.removeFromSpotify.length + ops.removeFromTidal.length, 0);
});

test('new tracks are reported per side, duplicates collapsed', () => {
  const ops = computeTwoWayOps({
    baseline,
    spotifyIds: ['a', 'b', 'c', 'x', 'x'],
    tidalIds: ['ta', 'tb', 'tc', 'ty'],
  });
  assert.deepEqual(ops.newOnSpotify, ['x']);
  assert.deepEqual(ops.newOnTidal, ['ty']);
});

test('empty baseline treats everything as new', () => {
  const ops = computeTwoWayOps({ baseline: [], spotifyIds: ['a'], tidalIds: ['tb'] });
  assert.deepEqual(ops.newOnSpotify, ['a']);
  assert.deepEqual(ops.newOnTidal, ['tb']);
  assert.equal(ops.keep.length, 0);
});
