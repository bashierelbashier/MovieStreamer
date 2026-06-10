// TV-style broadcaster. The movie file is served with HTTP range requests
// (smooth, browser-native buffering — same model as
// github.com/WittCode/code-a-video-streaming-app-with-node) while the server
// keeps the broadcast clock: it starts at /start-streaming, advances whether
// anyone is watching or not, and viewers are pinned to it by the watch page.

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseSubtitles, toVTT } from './subtitles.js';
import { probeDuration } from './duration.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOVIE_DIR = path.join(__dirname, 'current_movie');
const WATCH_PAGE = path.join(__dirname, 'public', 'watch.html');
const PORT = process.env.PORT || 3000;

// Containers browsers can play natively over range requests.
const MIME = {
  '.mp4':  'video/mp4',
  '.m4v':  'video/mp4',
  '.mov':  'video/mp4',
  '.webm': 'video/webm',
};
const SUBTITLE_EXTS = ['.srt', '.vtt'];

const CHUNK_SIZE = 1024 * 1024; // 1 MB per range response

const broadcast = {
  active: false,
  filename: null,
  fullPath: null,
  mimeType: null,
  size: 0,
  duration: 0,
  startedAt: null,
  paused: false,
  pausedAt: null,
  cues: null,
  endTimer: null,
};

function findFile(exts) {
  const files = fs.readdirSync(MOVIE_DIR).filter(f => !f.startsWith('.'));
  return files.find(f => exts.includes(path.extname(f).toLowerCase())) || null;
}

function loadSubtitleCues() {
  const name = findFile(SUBTITLE_EXTS);
  if (!name) return null;
  try {
    const cues = parseSubtitles(fs.readFileSync(path.join(MOVIE_DIR, name), 'utf8'));
    console.log(`[subtitles] loaded ${cues.length} cues from ${name}`);
    return cues.length ? cues : null;
  } catch (err) {
    console.error('[subtitles] failed to load:', err.message);
    return null;
  }
}

function elapsed() {
  if (!broadcast.startedAt) return 0;
  const now = broadcast.paused ? broadcast.pausedAt : Date.now();
  return Math.min((now - broadcast.startedAt) / 1000, broadcast.duration);
}

function pauseBroadcast() {
  broadcast.paused = true;
  broadcast.pausedAt = Date.now();
  clearTimeout(broadcast.endTimer);
  console.log(`[broadcast] paused at ${Math.round(elapsed())}s`);
}

function resumeBroadcast() {
  // Shift the clock forward by however long we were paused.
  broadcast.startedAt += Date.now() - broadcast.pausedAt;
  broadcast.paused = false;
  broadcast.pausedAt = null;
  broadcast.endTimer = setTimeout(stopBroadcast, (broadcast.duration - elapsed()) * 1000);
  console.log(`[broadcast] resumed at ${Math.round(elapsed())}s`);
}

async function startBroadcast(name) {
  const fullPath = path.join(MOVIE_DIR, name);
  const duration = await probeDuration(fullPath);
  if (!duration) return `Could not read duration from ${name}.`;

  broadcast.active = true;
  broadcast.filename = name;
  broadcast.fullPath = fullPath;
  broadcast.mimeType = MIME[path.extname(name).toLowerCase()];
  broadcast.size = fs.statSync(fullPath).size;
  broadcast.duration = duration;
  broadcast.startedAt = Date.now();
  broadcast.cues = loadSubtitleCues();

  // The broadcast ends when the movie does — by the clock, not by viewers.
  broadcast.endTimer = setTimeout(stopBroadcast, duration * 1000);

  console.log(`[broadcast] started — ${name} (${Math.round(duration)}s)`);
  return null;
}

function stopBroadcast() {
  clearTimeout(broadcast.endTimer);
  broadcast.active = false;
  broadcast.filename = null;
  broadcast.fullPath = null;
  broadcast.mimeType = null;
  broadcast.size = 0;
  broadcast.duration = 0;
  broadcast.startedAt = null;
  broadcast.paused = false;
  broadcast.pausedAt = null;
  broadcast.cues = null;
  broadcast.endTimer = null;
  console.log('[broadcast] ended');
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const url = new URL(req.url, 'http://x');

  // GET or POST /start-streaming  (GET so it works from the address bar)
  if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/start-streaming') {
    if (broadcast.active) return json(res, 409, { success: false, message: 'Already streaming.' });
    const name = findFile(Object.keys(MIME));
    if (!name) return json(res, 404, { success: false, message: 'No movie file found in current_movie/.' });
    const error = await startBroadcast(name);
    if (error) return json(res, 500, { success: false, message: error });
    return json(res, 200, { success: true, message: `Streaming started: ${name}` });
  }

  // GET or POST /pause-streaming  — toggles intermission: first call pauses the
  // broadcast clock for everyone, the next call resumes it.
  if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/pause-streaming') {
    if (!broadcast.active) return json(res, 409, { success: false, message: 'No active broadcast.' });
    if (broadcast.paused) {
      resumeBroadcast();
      return json(res, 200, { success: true, message: `Resumed at ${Math.round(elapsed())}s.` });
    }
    pauseBroadcast();
    return json(res, 200, { success: true, message: `Paused at ${Math.round(elapsed())}s. Hit /pause-streaming again to resume.` });
  }

  // GET or POST /end-streaming  — ends the broadcast for everyone, immediately.
  if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/end-streaming') {
    if (!broadcast.active) return json(res, 409, { success: false, message: 'No active broadcast.' });
    const at = Math.round(elapsed());
    stopBroadcast();
    return json(res, 200, { success: true, message: `Streaming ended at ${at}s.` });
  }

  // GET /watch
  if (req.method === 'GET' && url.pathname === '/watch') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(WATCH_PAGE, 'utf8'));
  }

  // GET /video  — the movie itself, served in 1 MB range-request chunks
  if (req.method === 'GET' && url.pathname === '/video') {
    if (!broadcast.active) return json(res, 503, { message: 'No active broadcast.' });

    const range = req.headers.range || 'bytes=0-';
    const start = Number(range.match(/\d+/)?.[0] ?? 0);
    if (start >= broadcast.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${broadcast.size}` });
      return res.end();
    }
    const end = Math.min(start + CHUNK_SIZE - 1, broadcast.size - 1);

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${broadcast.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': broadcast.mimeType,
    });
    return fs.createReadStream(broadcast.fullPath, { start, end }).pipe(res);
  }

  // GET /subtitles.vtt  — absolute movie times; viewers' currentTime is absolute too
  if (req.method === 'GET' && url.pathname === '/subtitles.vtt') {
    if (!broadcast.cues) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('No subtitles.');
    }
    res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(toVTT(broadcast.cues));
  }

  // GET /status  — the broadcast clock, polled by watch.html
  if (req.method === 'GET' && url.pathname === '/status') {
    return json(res, 200, {
      active: broadcast.active,
      paused: broadcast.paused,
      filename: broadcast.filename,
      hasSubtitles: Boolean(broadcast.cues),
      elapsed: elapsed(),
      duration: broadcast.duration,
    });
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\nMovieStreamer → http://localhost:${PORT}`);
  console.log(`  Watch:          GET  http://localhost:${PORT}/watch`);
  console.log(`  Start stream:   GET  http://localhost:${PORT}/start-streaming\n`);
});
