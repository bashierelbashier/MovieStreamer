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
export const DEFAULT_MOVIE_DIR = path.join(__dirname, 'current_movie');
export const DEFAULT_WATCH_PAGE = path.join(__dirname, 'public', 'watch.html');
export const DEFAULT_PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_PORT = process.env.PORT || 3000;

// Containers browsers can play natively over range requests.
const MIME = {
  '.mp4':  'video/mp4',
  '.m4v':  'video/mp4',
  '.mov':  'video/mp4',
  '.webm': 'video/webm',
};
const SUBTITLE_EXTS = ['.srt', '.vtt'];
const PUBLIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.json': 'application/json',
};

export const CHUNK_SIZE = 1024 * 1024; // 1 MB per open-ended range response

// ── Logging ───────────────────────────────────────────────────────────────

export function createLogger(sink = console) {
  return function log(level, message, meta) {
    const ts = new Date().toISOString();
    const extra = meta === undefined ? '' : ` ${JSON.stringify(meta)}`;
    const line = `[${ts}] [${level}] ${message}${extra}`;
    if (level === 'error' || level === 'warn') {
      (sink.error || sink.log).call(sink, line);
    } else {
      (sink.log || sink.error).call(sink, line);
    }
  };
}

// ── Range parsing (pure, unit-tested) ─────────────────────────────────────

/**
 * Parse an HTTP Range header against a file size.
 * @returns {null} for no/invalid-but-ignored header handling by caller
 * @returns {{ unsatisfiable: true }} for 416
 * @returns {{ start: number, end: number }} for a satisfiable range
 */
export function parseByteRange(rangeHeader, fileSize, chunkSize = CHUNK_SIZE) {
  if (!rangeHeader) return null;

  const m = String(rangeHeader).match(/^bytes=(\d*)-(\d*)$/i);
  if (!m) {
    return { unsatisfiable: true, reason: 'malformed-range' };
  }

  let start;
  let end;

  if (m[1] === '' && m[2] !== '') {
    // suffix range: bytes=-N → final N bytes
    const suffix = Number(m[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) {
      return { unsatisfiable: true, reason: 'bad-suffix' };
    }
    start = Math.max(0, fileSize - suffix);
    end = fileSize - 1;
  } else {
    start = m[1] === '' ? 0 : Number(m[1]);
    if (!Number.isFinite(start) || start < 0) {
      return { unsatisfiable: true, reason: 'bad-start' };
    }
    end = m[2] !== ''
      ? Math.min(Number(m[2]), fileSize - 1) // explicit end: honor it
      : Math.min(start + chunkSize - 1, fileSize - 1); // open-ended: cap
    if (!Number.isFinite(end)) {
      return { unsatisfiable: true, reason: 'bad-end' };
    }
  }

  if (fileSize <= 0 || start >= fileSize || start > end) {
    return { unsatisfiable: true, reason: 'out-of-bounds' };
  }

  return { start, end };
}

// ── Stream piping with cleanup (avoids FD / buffer leaks on abort) ────────

/**
 * Pipe a file (or file slice) to an HTTP response and tear the stream down
 * when the client disconnects or an error occurs.
 * @returns {fs.ReadStream}
 */
export function pipeFileToResponse(req, res, fullPath, opts, log) {
  const stream = fs.createReadStream(fullPath, opts);
  let cleaned = false;

  const cleanup = (why, level = 'info') => {
    if (cleaned) return;
    cleaned = true;
    if (!stream.destroyed) {
      stream.destroy();
      // Abort mid-transfer is common during seeks; only elevate real IO errors.
      if (why && log && level !== 'debug') {
        log(level, 'video stream closed early', { why, path: path.basename(fullPath) });
      }
    }
  };

  stream.on('error', (err) => {
    // ECONNRESET / aborted after client leave is noise, not a server fault.
    const benign = err.code === 'ERR_STREAM_PREMATURE_CLOSE'
      || err.code === 'ECONNRESET'
      || err.code === 'EPIPE';
    if (log && !benign) {
      log('error', 'video read stream error', { message: err.message, code: err.code });
    }
    cleanup('stream-error', benign ? 'debug' : 'error');
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Stream error');
    } else if (!res.writableEnded) {
      res.destroy(err);
    }
  });

  // Client went away mid-transfer (seek thrash, tab close, network drop).
  // Tear down quietly — this is normal browser behavior, not a fault.
  req.on('close', () => {
    if (!res.writableEnded) cleanup('client-abort', 'debug');
  });
  res.on('close', () => {
    if (!stream.destroyed && !stream.readableEnded) cleanup('response-close', 'debug');
  });

  stream.pipe(res);
  return stream;
}

// ── App factory ───────────────────────────────────────────────────────────

/**
 * Create an isolated MovieStreamer HTTP server (no listen yet).
 * Useful for tests and for production startup via index.js.
 */
export function createMovieStreamer(options = {}) {
  const movieDir = options.movieDir || DEFAULT_MOVIE_DIR;
  const watchPage = options.watchPage || DEFAULT_WATCH_PAGE;
  const publicDir = options.publicDir || DEFAULT_PUBLIC_DIR;
  const log = options.log || createLogger();

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
    openStreams: 0,
  };

  function findFile(exts) {
    let files;
    try {
      files = fs.readdirSync(movieDir).filter(f => !f.startsWith('.'));
    } catch (err) {
      log('error', 'cannot read movie dir', { movieDir, message: err.message });
      return null;
    }
    return files.find(f => exts.includes(path.extname(f).toLowerCase())) || null;
  }

  function loadSubtitleCues() {
    const name = findFile(SUBTITLE_EXTS);
    if (!name) return null;
    try {
      const cues = parseSubtitles(fs.readFileSync(path.join(movieDir, name), 'utf8'));
      log('info', 'subtitles loaded', { file: name, cues: cues.length });
      return cues.length ? cues : null;
    } catch (err) {
      log('error', 'subtitles failed to load', { file: name, message: err.message });
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
    log('info', 'broadcast paused', { at: Math.round(elapsed()) });
  }

  function resumeBroadcast() {
    broadcast.startedAt += Date.now() - broadcast.pausedAt;
    broadcast.paused = false;
    broadcast.pausedAt = null;
    broadcast.endTimer = setTimeout(stopBroadcast, (broadcast.duration - elapsed()) * 1000);
    log('info', 'broadcast resumed', { at: Math.round(elapsed()) });
  }

  async function startBroadcast(name, startAt = 0) {
    const fullPath = path.join(movieDir, name);
    let duration;
    try {
      duration = await probeDuration(fullPath);
    } catch (err) {
      log('error', 'duration probe failed', { file: name, message: err.message });
      return `Could not read duration from ${name}.`;
    }
    if (!duration) {
      log('error', 'duration probe returned empty', { file: name });
      return `Could not read duration from ${name}.`;
    }

    const at = Math.min(Math.max(startAt, 0), duration);

    broadcast.active = true;
    broadcast.filename = name;
    broadcast.fullPath = fullPath;
    broadcast.mimeType = MIME[path.extname(name).toLowerCase()];
    broadcast.size = fs.statSync(fullPath).size;
    broadcast.duration = duration;
    broadcast.startedAt = Date.now() - at * 1000;
    broadcast.paused = false;
    broadcast.pausedAt = null;
    broadcast.cues = loadSubtitleCues();
    broadcast.endTimer = setTimeout(stopBroadcast, (duration - at) * 1000);

    log('info', 'broadcast started', {
      file: name,
      durationSec: Math.round(duration),
      startAt: Math.round(at),
      size: broadcast.size,
    });
    return null;
  }

  function stopBroadcast() {
    clearTimeout(broadcast.endTimer);
    const wasActive = broadcast.active;
    const at = wasActive ? Math.round(elapsed()) : 0;
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
    if (wasActive) log('info', 'broadcast ended', { at, openStreams: broadcast.openStreams });
  }

  function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  function servePublic(req, res, urlPath) {
    // Only allow simple public assets (no directory traversal).
    const safe = path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, '');
    if (safe.includes('..') || path.isAbsolute(safe)) {
      log('warn', 'blocked public path traversal', { urlPath });
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('Forbidden');
    }
    const full = path.join(publicDir, safe);
    if (!full.startsWith(publicDir)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('Forbidden');
    }
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(full).toLowerCase();
    const type = PUBLIC_MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    return pipeFileToResponse(req, res, full, {}, log);
  }

  function trackStream(req, res, fullPath, opts) {
    broadcast.openStreams += 1;
    const stream = pipeFileToResponse(req, res, fullPath, opts, log);
    const done = () => {
      broadcast.openStreams = Math.max(0, broadcast.openStreams - 1);
      stream.removeListener('close', done);
      stream.removeListener('end', done);
      stream.removeListener('error', done);
    };
    stream.on('close', done);
    stream.on('end', done);
    stream.on('error', done);
    return stream;
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    let url;
    try {
      url = new URL(req.url, 'http://x');
    } catch {
      log('warn', 'malformed request URL', { url: req.url });
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('Bad request');
    }

    try {
      // GET or POST /start-streaming
      if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/start-streaming') {
        if (broadcast.active) {
          log('warn', 'start-streaming rejected: already active');
          return json(res, 409, { success: false, message: 'Already streaming.' });
        }
        const name = findFile(Object.keys(MIME));
        if (!name) {
          log('error', 'start-streaming: no movie file', { movieDir });
          return json(res, 404, { success: false, message: 'No movie file found in current_movie/.' });
        }
        let startAt = 0;
        if (url.searchParams.has('at')) {
          startAt = Number(url.searchParams.get('at'));
          if (!Number.isFinite(startAt) || startAt < 0) {
            log('warn', 'start-streaming invalid at=', { raw: url.searchParams.get('at') });
            return json(res, 400, { success: false, message: 'Invalid "at": expected a non-negative number of seconds.' });
          }
        }
        const error = await startBroadcast(name, startAt);
        if (error) return json(res, 500, { success: false, message: error });
        const started = Math.round(elapsed());
        return json(res, 200, { success: true, message: `Streaming started: ${name}${started ? ` at ${started}s` : ''}` });
      }

      // GET or POST /pause-streaming
      if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/pause-streaming') {
        if (!broadcast.active) {
          log('warn', 'pause-streaming with no active broadcast');
          return json(res, 409, { success: false, message: 'No active broadcast.' });
        }
        if (broadcast.paused) {
          resumeBroadcast();
          return json(res, 200, { success: true, message: `Resumed at ${Math.round(elapsed())}s.` });
        }
        pauseBroadcast();
        return json(res, 200, { success: true, message: `Paused at ${Math.round(elapsed())}s. Hit /pause-streaming again to resume.` });
      }

      // GET or POST /end-streaming
      if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/end-streaming') {
        if (!broadcast.active) {
          log('warn', 'end-streaming with no active broadcast');
          return json(res, 409, { success: false, message: 'No active broadcast.' });
        }
        const at = Math.round(elapsed());
        stopBroadcast();
        return json(res, 200, { success: true, message: `Streaming ended at ${at}s.` });
      }

      // GET /watch
      if (req.method === 'GET' && url.pathname === '/watch') {
        try {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
          return res.end(fs.readFileSync(watchPage, 'utf8'));
        } catch (err) {
          log('error', 'failed to read watch page', { message: err.message });
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          return res.end('Watch page missing');
        }
      }

      // Public assets (resync policy module, etc.)
      if (req.method === 'GET' && url.pathname === '/resync.js') {
        return servePublic(req, res, 'resync.js');
      }

      // GET /video
      if (req.method === 'GET' && url.pathname === '/video') {
        if (!broadcast.active) {
          log('warn', 'video requested with no active broadcast');
          return json(res, 503, { message: 'No active broadcast.' });
        }

        const range = req.headers.range;
        if (!range) {
          log('info', 'video full-file request (no Range)', { size: broadcast.size });
          res.writeHead(200, {
            'Content-Length': broadcast.size,
            'Content-Type': broadcast.mimeType,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store',
          });
          return trackStream(req, res, broadcast.fullPath, {});
        }

        const parsed = parseByteRange(range, broadcast.size);
        if (!parsed || parsed.unsatisfiable) {
          log('warn', 'unsatisfiable range', { range, size: broadcast.size, reason: parsed?.reason });
          res.writeHead(416, { 'Content-Range': `bytes */${broadcast.size}` });
          return res.end();
        }

        const { start, end } = parsed;
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${broadcast.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
          'Content-Type': broadcast.mimeType,
          'Cache-Control': 'no-store',
        });
        return trackStream(req, res, broadcast.fullPath, { start, end });
      }

      // GET /subtitles.vtt
      if (req.method === 'GET' && url.pathname === '/subtitles.vtt') {
        if (!broadcast.cues) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          return res.end('No subtitles.');
        }
        res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-cache' });
        return res.end(toVTT(broadcast.cues));
      }

      // GET /status
      // serverTime lets clients estimate one-way delay and extrapolate the
      // broadcast clock between polls so late joiners match early ones.
      if (req.method === 'GET' && url.pathname === '/status') {
        return json(res, 200, {
          active: broadcast.active,
          paused: broadcast.paused,
          filename: broadcast.filename,
          hasSubtitles: Boolean(broadcast.cues),
          elapsed: elapsed(),
          duration: broadcast.duration,
          serverTime: Date.now(),
        });
      }

      // GET /health — lightweight diagnostics for ops / tests
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, {
          ok: true,
          active: broadcast.active,
          openStreams: broadcast.openStreams,
          uptimeSec: Math.round(process.uptime()),
        });
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    } catch (err) {
      log('error', 'unhandled request error', {
        path: url.pathname,
        message: err.message,
        stack: err.stack,
      });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal error');
      } else {
        res.destroy(err);
      }
    }
  });

  server.on('clientError', (err, socket) => {
    log('warn', 'clientError', { message: err.message });
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  function listen(port = DEFAULT_PORT) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, () => {
        server.removeListener('error', reject);
        const addr = server.address();
        const p = typeof addr === 'object' && addr ? addr.port : port;
        log('info', 'MovieStreamer listening', { port: p });
        resolve(p);
      });
    });
  }

  function close() {
    stopBroadcast();
    return new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  return {
    server,
    listen,
    close,
    /** @internal test/inspection helpers */
    getBroadcast: () => broadcast,
    elapsed,
    startBroadcast,
    stopBroadcast,
    pauseBroadcast,
    resumeBroadcast,
  };
}

// When run directly (node server.js), start the default instance.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const app = createMovieStreamer();
  const port = Number(process.env.PORT) || 3000;
  app.listen(port).then((p) => {
    console.log(`\nMovieStreamer → http://localhost:${p}`);
    console.log(`  Watch:          GET  http://localhost:${p}/watch`);
    console.log(`  Start stream:   GET  http://localhost:${p}/start-streaming\n`);
  }).catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
  });
}
