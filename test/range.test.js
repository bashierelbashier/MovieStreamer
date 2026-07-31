import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseByteRange, CHUNK_SIZE } from '../server.js';

describe('parseByteRange', () => {
  const size = 10_000;

  it('returns null when no range header', () => {
    assert.equal(parseByteRange(undefined, size), null);
    assert.equal(parseByteRange(null, size), null);
  });

  it('honors explicit Safari probe range bytes=0-1', () => {
    const r = parseByteRange('bytes=0-1', size);
    assert.deepEqual(r, { start: 0, end: 1 });
  });

  it('caps open-ended ranges at CHUNK_SIZE on large files', () => {
    const large = 50 * 1024 * 1024;
    const r = parseByteRange('bytes=100-', large);
    assert.equal(r.start, 100);
    assert.equal(r.end, 100 + CHUNK_SIZE - 1);
  });

  it('clamps open-ended ranges to EOF', () => {
    const r = parseByteRange('bytes=9500-', size);
    assert.deepEqual(r, { start: 9500, end: 9999 });
  });

  it('handles suffix ranges bytes=-N', () => {
    const r = parseByteRange('bytes=-500', size);
    assert.deepEqual(r, { start: 9500, end: 9999 });
  });

  it('marks out-of-bounds as unsatisfiable', () => {
    const r = parseByteRange('bytes=20000-20010', size);
    assert.equal(r.unsatisfiable, true);
  });

  it('marks malformed ranges as unsatisfiable', () => {
    const r = parseByteRange('bytes=abc', size);
    assert.equal(r.unsatisfiable, true);
  });
});
