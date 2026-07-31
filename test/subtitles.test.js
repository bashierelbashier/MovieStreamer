import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSubtitles, toVTT } from '../subtitles.js';

describe('parseSubtitles', () => {
  it('parses SRT blocks', () => {
    const srt = `1
00:00:01,000 --> 00:00:03,500
Hello world

2
00:00:04,000 --> 00:00:05,000
Second line
`;
    const cues = parseSubtitles(srt);
    assert.equal(cues.length, 2);
    assert.equal(cues[0].start, 1);
    assert.equal(cues[0].end, 3.5);
    assert.equal(cues[0].text, 'Hello world');
    assert.equal(cues[1].text, 'Second line');
  });

  it('parses WebVTT and strips the header', () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:02.000
Hi
`;
    const cues = parseSubtitles(vtt);
    assert.equal(cues.length, 1);
    assert.equal(cues[0].start, 1);
    assert.equal(cues[0].text, 'Hi');
  });
});

describe('toVTT', () => {
  it('emits WebVTT and applies offset, dropping past cues', () => {
    const cues = [
      { start: 1, end: 2, text: 'A' },
      { start: 5, end: 6, text: 'B' },
    ];
    const out = toVTT(cues, 3);
    assert.match(out, /^WEBVTT\n/);
    assert.doesNotMatch(out, /\bA\b/);
    assert.match(out, /00:00:02\.000 --> 00:00:03\.000/);
    assert.match(out, /\nB\n/);
  });
});
