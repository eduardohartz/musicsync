import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/logger.js';

function capture() {
  const lines = { out: [], err: [] };
  return {
    lines,
    streams: {
      out: { write: (s) => lines.out.push(s) },
      err: { write: (s) => lines.err.push(s) },
    },
  };
}

test('level gates output and warn/error go to stderr', () => {
  const { lines, streams } = capture();
  const log = createLogger('warn', streams).child('mod');
  log.debug('d');
  log.info('i');
  log.warn('w');
  log.error('e');
  assert.equal(lines.out.length, 0);
  assert.equal(lines.err.length, 2);
  assert.match(lines.err[0], /WARN {2}\[mod\] w/);
  assert.match(lines.err[1], /ERROR \[mod\] e/);
});

test('extra payload is JSON-serialized', () => {
  const { lines, streams } = capture();
  createLogger('info', streams).child('m').info('msg', { a: 1 });
  assert.match(lines.out[0], /msg \{"a":1\}/);
});

test('setLevel takes effect for already-created children', () => {
  const { lines, streams } = capture();
  const logger = createLogger('info', streams);
  const child = logger.child('m');
  child.debug('hidden');
  logger.setLevel('debug');
  child.debug('visible');
  assert.equal(lines.out.filter((l) => l.includes('hidden')).length, 0);
  assert.equal(lines.out.filter((l) => l.includes('visible')).length, 1);
});
