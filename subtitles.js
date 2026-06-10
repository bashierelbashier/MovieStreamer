// Parse SRT or WebVTT into cues, and re-emit as WebVTT (optionally time-shifted
// for viewers who join the broadcast late).

// "00:01:23,456" or "00:01:23.456" or "01:23.456" → seconds (float)
function parseTime(str) {
  const m = str.trim().match(/(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})/);
  if (!m) return null;
  const [, h, mm, ss, ms] = m;
  return (Number(h || 0) * 3600) + (Number(mm) * 60) + Number(ss) + (Number(ms.padEnd(3, '0')) / 1000);
}

// seconds → "HH:MM:SS.mmm"
function formatTime(sec) {
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  const total = Math.floor(sec);
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}.${String(ms).padStart(3, '0')}`;
}

// Parse SRT or VTT text into [{ start, end, text }]
export function parseSubtitles(content) {
  const cues = [];
  // Normalize newlines, strip a leading WEBVTT header if present.
  const body = content.replace(/\r\n/g, '\n').replace(/^WEBVTT.*?(\n\n|$)/s, '');

  for (const block of body.split(/\n\s*\n/)) {
    const lines = block.split('\n').filter(l => l.trim() !== '');
    if (lines.length === 0) continue;

    // The timing line is the one containing "-->".
    const tIdx = lines.findIndex(l => l.includes('-->'));
    if (tIdx === -1) continue;

    const [rawStart, rawEnd] = lines[tIdx].split('-->');
    const start = parseTime(rawStart);
    const end = parseTime(rawEnd);
    if (start === null || end === null) continue;

    const text = lines.slice(tIdx + 1).join('\n').trim();
    if (text) cues.push({ start, end, text });
  }
  return cues;
}

// Emit WebVTT. `offset` (seconds) shifts every cue earlier — used so a late
// joiner, whose video starts at ~0, still sees subtitles in sync. Cues that
// have already finished by `offset` are dropped.
export function toVTT(cues, offset = 0) {
  const out = ['WEBVTT', ''];
  for (const cue of cues) {
    const start = cue.start - offset;
    const end = cue.end - offset;
    if (end <= 0) continue; // already passed
    out.push(`${formatTime(Math.max(0, start))} --> ${formatTime(end)}`);
    out.push(cue.text, '');
  }
  return out.join('\n');
}
