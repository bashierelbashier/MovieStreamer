import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMovieStreamer } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function silentLog() {
  /* swallow logs in tests unless debugging */
}

describe('MovieStreamer HTTP API', () => {
  let app;
  let port;
  let base;

  before(async () => {
    app = createMovieStreamer({
      movieDir: path.join(root, 'current_movie'),
      watchPage: path.join(root, 'public', 'watch.html'),
      publicDir: path.join(root, 'public'),
      log: silentLog,
    });
    port = await app.listen(0);
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await app.close();
  });

  async function json(pathname, init) {
    const res = await fetch(`${base}${pathname}`, init);
    const body = await res.json().catch(() => null);
    return { res, body };
  }

  it('GET /health reports ok', async () => {
    const { res, body } = await json('/health');
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.active, false);
    assert.equal(body.openStreams, 0);
  });

  it('GET /status when idle', async () => {
    const { res, body } = await json('/status');
    assert.equal(res.status, 200);
    assert.equal(body.active, false);
  });

  it('GET /video when idle is 503', async () => {
    const { res, body } = await json('/video');
    assert.equal(res.status, 503);
    assert.match(body.message, /No active broadcast/);
  });

  it('starts, serves ranges, pauses, resumes, and ends', async () => {
    // Start
    let r = await json('/start-streaming');
    assert.equal(r.res.status, 200);
    assert.equal(r.body.success, true);

    // Already streaming → 409
    r = await json('/start-streaming');
    assert.equal(r.res.status, 409);

    // Status active with duration + serverTime for client clock sync
    r = await json('/status');
    assert.equal(r.res.status, 200);
    assert.equal(r.body.active, true);
    assert.ok(r.body.duration > 0);
    assert.ok(r.body.elapsed >= 0);
    assert.equal(typeof r.body.hasSubtitles, 'boolean');
    assert.equal(typeof r.body.serverTime, 'number');
    assert.ok(Math.abs(r.body.serverTime - Date.now()) < 5000);

    // Safari probe range
    let res = await fetch(`${base}/video`, { headers: { Range: 'bytes=0-1' } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-length'), '2');
    assert.match(res.headers.get('content-range'), /^bytes 0-1\//);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.length, 2);

    // Open-ended range is capped (≤ 1 MB)
    res = await fetch(`${base}/video`, { headers: { Range: 'bytes=0-' } });
    assert.equal(res.status, 206);
    const len = Number(res.headers.get('content-length'));
    assert.ok(len > 0 && len <= 1024 * 1024);
    await res.arrayBuffer(); // drain

    // Full file (no range) — stream a small prefix then abort to test cleanup
    res = await fetch(`${base}/video`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('accept-ranges'));
    // Don't download entire 25MB; cancel after headers.
    await res.body.cancel();

    // Give the server a tick to process abort cleanup
    await new Promise((r) => setTimeout(r, 50));
    const health = await json('/health');
    assert.equal(health.body.ok, true);
    // Streams should drain; allow a brief race but not grow unbounded
    assert.ok(health.body.openStreams <= 2, `openStreams leaked: ${health.body.openStreams}`);

    // Subtitles if present
    res = await fetch(`${base}/subtitles.vtt`);
    if (res.status === 200) {
      const text = await res.text();
      assert.match(text, /^WEBVTT/);
    } else {
      assert.equal(res.status, 404);
    }

    // Watch page + resync module
    res = await fetch(`${base}/watch`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /type="module"/);
    assert.match(html, /resync\.js/);

    res = await fetch(`${base}/resync.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /javascript/);
    const js = await res.text();
    assert.match(js, /decideResync/);

    // Pause / resume
    r = await json('/pause-streaming');
    assert.equal(r.res.status, 200);
    r = await json('/status');
    assert.equal(r.body.paused, true);
    const pausedElapsed = r.body.elapsed;
    await new Promise((r) => setTimeout(r, 200));
    r = await json('/status');
    assert.ok(Math.abs(r.body.elapsed - pausedElapsed) < 0.05, 'clock should freeze while paused');

    r = await json('/pause-streaming');
    assert.equal(r.res.status, 200);
    r = await json('/status');
    assert.equal(r.body.paused, false);

    // End
    r = await json('/end-streaming');
    assert.equal(r.res.status, 200);
    r = await json('/status');
    assert.equal(r.body.active, false);
  });

  it('supports ?at= offset start', async () => {
    // Ensure clean
    await json('/end-streaming').catch(() => {});

    const r = await json('/start-streaming?at=120');
    assert.equal(r.res.status, 200);
    assert.equal(r.body.success, true);

    const { body } = await json('/status');
    assert.equal(body.active, true);
    // Should be near 120s (allow a couple seconds of test overhead)
    assert.ok(body.elapsed >= 118 && body.elapsed <= 130, `elapsed=${body.elapsed}`);

    await json('/end-streaming');
  });

  it('rejects invalid at=', async () => {
    await json('/end-streaming').catch(() => {});
    const r = await json('/start-streaming?at=-5');
    assert.equal(r.res.status, 400);
  });

  it('destroys stream on client abort without hanging the process', async () => {
    await json('/end-streaming').catch(() => {});
    await json('/start-streaming');

    // Pull one chunk then cancel the body — mirrors a seek/tab-close mid-transfer.
    const res = await fetch(`${base}/video`, {
      headers: { Range: 'bytes=0-5000000' },
    });
    assert.equal(res.status, 206);
    const reader = res.body.getReader();
    await reader.read();
    await reader.cancel();

    await new Promise((r) => setTimeout(r, 100));
    const { body } = await json('/health');
    assert.ok(body.openStreams <= 1, `openStreams after abort: ${body.openStreams}`);

    await json('/end-streaming');
  });
});

