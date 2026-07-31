import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideResync,
  estimateLiveElapsed,
  extrapolateElapsed,
  rateForDrift,
  SOFT_SEEK_SEC,
  SEEK_COOLDOWN_MS,
  HARD_DRIFT_SEC,
  RATE_MAX_DRIFT_SEC,
  SYNC_EPSILON_SEC,
  HAVE_FUTURE_DATA,
  HAVE_CURRENT_DATA,
} from '../public/resync.js';

function base(over = {}) {
  return {
    playerTime: 100,
    broadcastElapsed: 100,
    buffering: false,
    readyState: HAVE_FUTURE_DATA,
    nowMs: 1_000_000,
    lastSeekAtMs: 0,
    serverPaused: false,
    live: true,
    ...over,
  };
}

describe('estimateLiveElapsed', () => {
  it('adds half-RTT when the broadcast is running', () => {
    const e = estimateLiveElapsed({ elapsed: 10, paused: false, rttMs: 200 });
    assert.ok(Math.abs(e - 10.1) < 1e-9);
  });

  it('does not advance while paused', () => {
    const e = estimateLiveElapsed({ elapsed: 10, paused: true, rttMs: 200 });
    assert.equal(e, 10);
  });

  it('prefers plausible serverTime one-way delay', () => {
    const e = estimateLiveElapsed({
      elapsed: 10,
      paused: false,
      rttMs: 200,
      serverTime: 1_000_000,
      clientRecvWallMs: 1_000_040, // 40ms one-way
    });
    assert.ok(Math.abs(e - 10.04) < 1e-9);
  });

  it('ignores absurd wall-clock skew and falls back to RTT/2', () => {
    const e = estimateLiveElapsed({
      elapsed: 10,
      paused: false,
      rttMs: 100,
      serverTime: 1_000_000,
      clientRecvWallMs: 1_005_000, // 5s "delay" = clock skew
    });
    assert.ok(Math.abs(e - 10.05) < 1e-9);
  });
});

describe('extrapolateElapsed', () => {
  it('advances with monotonic client time', () => {
    assert.equal(extrapolateElapsed(10, 1000, 2500, false), 11.5);
  });

  it('freezes while paused', () => {
    assert.equal(extrapolateElapsed(10, 1000, 2500, true), 10);
  });
});

describe('rateForDrift', () => {
  it('is 1 near zero drift', () => {
    assert.equal(rateForDrift(0), 1);
    assert.equal(rateForDrift(SYNC_EPSILON_SEC / 2), 1);
  });

  it('speeds up when behind and slows when ahead', () => {
    assert.ok(rateForDrift(-1) > 1); // behind
    assert.ok(rateForDrift(1) < 1);  // ahead
  });
});

describe('decideResync', () => {
  it('returns rate=1 when essentially synced', () => {
    const d = decideResync(base({ playerTime: 100.05, broadcastElapsed: 100 }));
    assert.equal(d.action, 'rate');
    assert.equal(d.rate, 1);
    assert.equal(d.reason, 'synced');
  });

  it('does nothing when not live or server paused', () => {
    assert.equal(decideResync(base({ live: false })).action, 'none');
    assert.equal(decideResync(base({ serverPaused: true, playerTime: 50 })).action, 'none');
  });

  it('nudges playbackRate for small/medium drift', () => {
    const d = decideResync(base({
      playerTime: 100,
      broadcastElapsed: 100.8, // 0.8s behind
      buffering: false,
      readyState: HAVE_CURRENT_DATA,
    }));
    assert.equal(d.action, 'rate');
    assert.equal(d.reason, 'rate-nudge');
    assert.ok(d.rate > 1);
  });

  it('soft-seeks when healthy and beyond rate band', () => {
    const d = decideResync(base({
      playerTime: 100,
      broadcastElapsed: 100 + RATE_MAX_DRIFT_SEC + 0.5,
      buffering: false,
      readyState: HAVE_FUTURE_DATA,
      lastSeekAtMs: 0,
    }));
    assert.equal(d.action, 'seek');
    assert.equal(d.reason, 'soft-resync');
  });

  it('defers while buffering for medium drift', () => {
    const d = decideResync(base({
      playerTime: 100,
      broadcastElapsed: 108,
      buffering: true,
      readyState: HAVE_CURRENT_DATA,
      lastSeekAtMs: 0,
    }));
    assert.equal(d.action, 'defer');
    assert.equal(d.reason, 'buffering');
  });

  it('hard-seeks on severe drift once some data is available', () => {
    const d = decideResync(base({
      playerTime: 100,
      broadcastElapsed: 100 + HARD_DRIFT_SEC,
      buffering: true,
      readyState: HAVE_CURRENT_DATA,
      lastSeekAtMs: 0,
    }));
    assert.equal(d.action, 'seek');
    assert.equal(d.reason, 'hard-resync');
  });

  it('uses rate during seek cooldown instead of thrashing', () => {
    const now = 50_000;
    const d = decideResync(base({
      playerTime: 100,
      broadcastElapsed: 120,
      buffering: false,
      readyState: HAVE_FUTURE_DATA,
      nowMs: now,
      lastSeekAtMs: now - (SEEK_COOLDOWN_MS - 100),
    }));
    assert.equal(d.action, 'rate');
    assert.equal(d.reason, 'cooldown-rate');
  });

  it('allows seek after cooldown elapses', () => {
    const now = 50_000;
    const d = decideResync(base({
      playerTime: 100,
      broadcastElapsed: 100 + SOFT_SEEK_SEC + 1,
      buffering: false,
      readyState: HAVE_FUTURE_DATA,
      nowMs: now,
      lastSeekAtMs: now - SEEK_COOLDOWN_MS - 1,
    }));
    assert.equal(d.action, 'seek');
  });
});
