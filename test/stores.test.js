import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readJson, writeJsonAtomic } from '../src/store.js';
import { createTokenStore } from '../src/tokens.js';
import { createStateStore } from '../src/state.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'musicsync-test-'));

test('writeJsonAtomic round-trips and leaves no temp files', () => {
  const dir = tmp();
  const file = path.join(dir, 'x.json');
  for (let i = 0; i < 20; i++) {
    writeJsonAtomic(file, { i });
    assert.deepEqual(readJson(file, null), { i });
  }
  assert.deepEqual(fs.readdirSync(dir), ['x.json']);
});

test('readJson falls back on missing file', () => {
  assert.deepEqual(readJson(path.join(tmp(), 'nope.json'), { a: 1 }), { a: 1 });
});

test('readJson backs up corrupt file and returns fallback', () => {
  const dir = tmp();
  const file = path.join(dir, 'bad.json');
  fs.writeFileSync(file, '{not json');
  const warned = [];
  const result = readJson(file, { fresh: true }, { warn: (m) => warned.push(m) });
  assert.deepEqual(result, { fresh: true });
  assert.equal(warned.length, 1);
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^bad\.json\.corrupt-/);
});

test('token store merges, persists 0600, clears', () => {
  const dir = tmp();
  const tokens = createTokenStore(dir);
  tokens.set('spotify', { accessToken: 'a', refreshToken: 'r', authorizedAt: 't0' });
  tokens.set('spotify', { accessToken: 'b' });
  assert.deepEqual(tokens.get('spotify'), { accessToken: 'b', refreshToken: 'r', authorizedAt: 't0' });
  assert.equal(tokens.get('tidal'), null);
  const mode = fs.statSync(path.join(dir, 'tokens.json')).mode & 0o777;
  assert.equal(mode, 0o600);
  tokens.clear('spotify');
  assert.equal(tokens.get('spotify'), null);
});

test('state store loads defaults, saves, reloads', () => {
  const dir = tmp();
  const state = createStateStore(dir);
  assert.equal(state.data.runCount, 0);
  state.data.runCount = 3;
  state.data.pairs.m1 = { slavePlaylistId: 's1' };
  state.save();
  const reloaded = createStateStore(dir);
  assert.equal(reloaded.data.runCount, 3);
  assert.deepEqual(reloaded.data.pairs.m1, { slavePlaylistId: 's1' });
});

test('unmatched report is written with entries', () => {
  const dir = tmp();
  const state = createStateStore(dir);
  state.writeUnmatchedReport([{ title: 'Lost Song', reason: 'no-isrc-match' }]);
  const report = readJson(path.join(dir, 'unmatched.json'), null);
  assert.equal(report.unmatched.length, 1);
  assert.ok(report.generatedAt);
});

test('settings store round-trips, merges sections, 0600', async () => {
  const { readSettings, writeSettings, updateSettings } = await import('../src/settings.js');
  const dir = tmp();
  assert.deepEqual(readSettings(dir), {});
  writeSettings(dir, { sync: { mode: 'two-way' } });
  updateSettings(dir, { sync: { periodic: false }, logLevel: 'debug' });
  assert.deepEqual(readSettings(dir), { sync: { mode: 'two-way', periodic: false }, logLevel: 'debug' });
  const mode = fs.statSync(path.join(dir, 'settings.json')).mode & 0o777;
  assert.equal(mode, 0o600);
});
