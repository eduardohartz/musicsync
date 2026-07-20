import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeWriteStrategy, chunk } from '../src/diff.js';

test('identical sequences skip', () => {
  assert.deepEqual(computeWriteStrategy(['a', 'b'], ['a', 'b']), { type: 'skip' });
  assert.deepEqual(computeWriteStrategy([], []), { type: 'skip' });
});

test('strict prefix appends the tail', () => {
  assert.deepEqual(computeWriteStrategy(['a', 'b', 'c'], ['a']), { type: 'append', toAppend: ['b', 'c'] });
  assert.deepEqual(computeWriteStrategy(['a'], []), { type: 'append', toAppend: ['a'] });
});

test('reorder, removal, replacement, and duplicates rewrite', () => {
  assert.equal(computeWriteStrategy(['b', 'a'], ['a', 'b']).type, 'rewrite');
  assert.equal(computeWriteStrategy(['a'], ['a', 'b']).type, 'rewrite');
  assert.equal(computeWriteStrategy(['a', 'x'], ['a', 'b']).type, 'rewrite');
  assert.equal(computeWriteStrategy(['a', 'a'], ['a']).type, 'append');
  assert.equal(computeWriteStrategy([], ['a']).type, 'rewrite');
});

test('chunk splits with remainder', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 50), []);
});
