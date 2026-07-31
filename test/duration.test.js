import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeDuration } from '../duration.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const movie = path.join(__dirname, '..', 'current_movie', 'testmovie.mp4');

describe('probeDuration', () => {
  it('reads duration from the sample MP4', async () => {
    const d = await probeDuration(movie);
    assert.ok(d && d > 0, 'expected positive duration');
    // File is ~6214s; allow a little probe tolerance.
    assert.ok(d > 6000 && d < 6500, `unexpected duration ${d}`);
  });

  it('returns null for missing files', async () => {
    await assert.rejects(() => probeDuration(path.join(__dirname, 'nope.mp4')));
  });
});
