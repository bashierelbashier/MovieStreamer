// Pure broadcast-clock re-sync policy for the watch page.
// Extracted so it can be unit-tested without a browser.

/**
 * Ignore drift below this (seconds). Smaller than a frame bundle; avoids
 * constant micro-adjustments from measurement noise.
 */
export const SYNC_EPSILON_SEC = 0.12;

/**
 * Soft band: correct with playbackRate instead of seeking (smoother, and
 * keeps all viewers creeping toward the same clock without a jump).
 */
export const RATE_MAX_DRIFT_SEC = 2;

/**
 * Above this, prefer a hard snap when the buffer is healthy.
 * (Was 3s of pure ignore — that alone left viewers visibly apart.)
 */
export const SOFT_SEEK_SEC = 2;

/**
 * Minimum gap between forced seeks. Prevents seek thrash when the player
 * is still buffering after the previous snap-to-live.
 */
export const SEEK_COOLDOWN_MS = 5000;

/**
 * If the viewer is this far off and has *some* data, force a seek even while
 * mildly buffering — otherwise a stuck tab never recovers.
 */
export const HARD_DRIFT_SEC = 15;

/** Max/min playbackRate while nudging toward the broadcast clock. */
export const MAX_RATE = 1.12;
export const MIN_RATE = 0.88;

/** HTMLMediaElement.readyState: HAVE_FUTURE_DATA */
export const HAVE_FUTURE_DATA = 3;
/** HTMLMediaElement.readyState: HAVE_CURRENT_DATA */
export const HAVE_CURRENT_DATA = 2;

/** @deprecated use SOFT_SEEK_SEC — kept for older imports/tests */
export const DRIFT_TOLERANCE_SEC = SOFT_SEEK_SEC;

/**
 * Estimate true broadcast elapsed at the moment the client receives /status.
 *
 * The server's `elapsed` is already a few ms old when it hits the wire; by the
 * time we parse the body we're typically ~RTT/2 behind the real clock. Adding
 * that one-way delay aligns late joiners with viewers who polled earlier.
 *
 * @param {object} p
 * @param {number} p.elapsed
 * @param {boolean} [p.paused]
 * @param {number} [p.rttMs]  measured client round-trip for this request
 * @param {number} [p.serverTime]  Date.now() from the server payload
 * @param {number} [p.clientRecvWallMs]  Date.now() when the body was parsed
 */
export function estimateLiveElapsed(p) {
  const elapsed = Number(p.elapsed) || 0;
  if (p.paused) return elapsed;

  const rttMs = Math.max(0, Number(p.rttMs) || 0);
  // Default: half the measured RTT (classic one-way estimate).
  let oneWaySec = (rttMs / 2) / 1000;

  // If the server stamped the response, prefer that delay when it is
  // plausible (guards against large wall-clock skew between machines).
  if (p.serverTime != null && p.clientRecvWallMs != null) {
    const wallOneWay = (p.clientRecvWallMs - p.serverTime) / 1000;
    const rttSec = rttMs / 1000;
    if (wallOneWay >= 0 && wallOneWay <= rttSec + 0.05) {
      oneWaySec = wallOneWay;
    }
  }

  return elapsed + oneWaySec;
}

/**
 * Advance a previously sampled broadcast clock with a monotonic client timer.
 * Lets every viewer share the same extrapolated "now" between /status polls.
 */
export function extrapolateElapsed(baseElapsed, baseAtMs, nowMs, paused) {
  if (paused) return baseElapsed;
  return baseElapsed + Math.max(0, nowMs - baseAtMs) / 1000;
}

/**
 * Map drift (player − broadcast) onto a gentle playbackRate.
 * Negative drift (behind) → rate > 1; positive (ahead) → rate < 1.
 */
export function rateForDrift(drift) {
  const abs = Math.abs(drift);
  if (abs <= SYNC_EPSILON_SEC) return 1;
  // ~8% rate change per second of drift, clamped.
  const rate = 1 - Math.sign(drift) * Math.min(MAX_RATE - 1, abs * 0.08);
  return Math.min(MAX_RATE, Math.max(MIN_RATE, rate));
}

/**
 * Decide how to pin the player to the broadcast clock.
 *
 * @returns {{ action: 'none'|'rate'|'seek'|'defer', reason: string,
 *            drift?: number, target?: number, rate?: number }}
 */
export function decideResync(s) {
  if (!s.live || s.serverPaused) {
    return { action: 'none', reason: 'not-live-or-paused' };
  }
  if (s.readyState < 1) {
    return { action: 'none', reason: 'no-metadata' };
  }

  const drift = s.playerTime - s.broadcastElapsed;
  const absDrift = Math.abs(drift);
  const target = s.broadcastElapsed;

  if (absDrift <= SYNC_EPSILON_SEC) {
    return { action: 'rate', rate: 1, reason: 'synced', drift, target };
  }

  // Small/medium error: nudge rate (no seek → no hang, continuous A/V).
  // Works whenever we have current data and aren't mid-seek/buffer stall.
  if (
    absDrift <= RATE_MAX_DRIFT_SEC
    && !s.buffering
    && s.readyState >= HAVE_CURRENT_DATA
  ) {
    return {
      action: 'rate',
      rate: rateForDrift(drift),
      reason: 'rate-nudge',
      drift,
      target,
    };
  }

  const sinceSeek = s.nowMs - (s.lastSeekAtMs || 0);
  const coolingDown = sinceSeek < SEEK_COOLDOWN_MS;

  if (coolingDown && absDrift > RATE_MAX_DRIFT_SEC) {
    // Still try to close the gap with rate while seek is on cooldown.
    if (!s.buffering && s.readyState >= HAVE_CURRENT_DATA) {
      return {
        action: 'rate',
        rate: rateForDrift(Math.sign(drift) * RATE_MAX_DRIFT_SEC),
        reason: 'cooldown-rate',
        drift,
        target,
      };
    }
    return { action: 'defer', reason: 'cooldown', drift, target };
  }

  const healthy = !s.buffering && s.readyState >= HAVE_FUTURE_DATA;
  if (absDrift > RATE_MAX_DRIFT_SEC && healthy) {
    return { action: 'seek', reason: 'soft-resync', drift, target };
  }

  if (absDrift >= HARD_DRIFT_SEC && s.readyState >= HAVE_CURRENT_DATA) {
    return { action: 'seek', reason: 'hard-resync', drift, target };
  }

  // Buffering with medium drift: keep rate at 1 and wait.
  return {
    action: 'defer',
    reason: s.buffering ? 'buffering' : 'low-ready-state',
    drift,
    target,
  };
}
