// Pure-Node media duration probing — no ffprobe required.
// Supports the containers browsers can actually play: MP4-family and WebM.

import fs from 'fs';

async function read(fh, position, length) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

// MP4/MOV/M4V: walk top-level boxes to `moov`, then its children to `mvhd`,
// which holds timescale + duration. Works with moov at the front or the back.
async function mp4Duration(fh, fileSize) {
  let pos = 0;
  while (pos + 8 <= fileSize) {
    const hdr = await read(fh, pos, 16);
    if (hdr.length < 8) return null;
    let size = hdr.readUInt32BE(0);
    const type = hdr.toString('latin1', 4, 8);
    let hdrSize = 8;
    if (size === 1) {
      if (hdr.length < 16) return null;
      size = Number(hdr.readBigUInt64BE(8));
      hdrSize = 16;
    } else if (size === 0) {
      size = fileSize - pos; // box extends to end of file
    }
    if (size < hdrSize) return null;

    if (type === 'moov') {
      let cpos = pos + hdrSize;
      const cend = pos + size;
      while (cpos + 8 <= cend) {
        const ch = await read(fh, cpos, 8);
        if (ch.length < 8) return null;
        const csize = ch.readUInt32BE(0);
        const ctype = ch.toString('latin1', 4, 8);
        if (ctype === 'mvhd') {
          const body = await read(fh, cpos + 8, 32);
          const version = body[0];
          if (version === 1) {
            const timescale = body.readUInt32BE(20);
            const duration = Number(body.readBigUInt64BE(24));
            return timescale ? duration / timescale : null;
          }
          const timescale = body.readUInt32BE(12);
          const duration = body.readUInt32BE(16);
          return timescale ? duration / timescale : null;
        }
        if (csize < 8) return null;
        cpos += csize;
      }
      return null;
    }
    pos += size;
  }
  return null;
}

// EBML variable-length integer at `pos`. Returns { value, length }.
// `keepMarker` keeps the length-marker bit (element IDs); otherwise it's cleared (sizes).
function readVint(buf, pos, keepMarker) {
  const first = buf[pos];
  if (first === undefined || first === 0) return null;
  let len = 1;
  let mask = 0x80;
  while (!(first & mask)) { mask >>= 1; len++; }
  if (pos + len > buf.length) return null;
  let value = keepMarker ? first : first & (mask - 1);
  for (let i = 1; i < len; i++) value = value * 256 + buf[pos + i];
  return { value, length: len };
}

// WebM/MKV: duration lives in Segment > Info as a float, scaled by
// TimecodeScale (ns per tick, default 1e6). The Info element sits in the
// header region, so parsing the first 512 KB is sufficient in practice.
async function webmDuration(fh) {
  const buf = await read(fh, 0, 512 * 1024);

  // Locate the Info element (ID 0x1549A966).
  const INFO_ID = Buffer.from([0x15, 0x49, 0xa9, 0x66]);
  const infoAt = buf.indexOf(INFO_ID);
  if (infoAt === -1) return null;

  let pos = infoAt + 4;
  const infoSize = readVint(buf, pos, false);
  if (!infoSize) return null;
  pos += infoSize.length;
  const end = Math.min(pos + infoSize.value, buf.length);

  let timecodeScale = 1_000_000;
  let durationTicks = null;

  while (pos < end) {
    const id = readVint(buf, pos, true);
    if (!id) break;
    pos += id.length;
    const size = readVint(buf, pos, false);
    if (!size) break;
    pos += size.length;

    if (id.value === 0x2ad7b1) { // TimecodeScale (uint)
      timecodeScale = 0;
      for (let i = 0; i < size.value; i++) timecodeScale = timecodeScale * 256 + buf[pos + i];
    } else if (id.value === 0x4489) { // Duration (float32 or float64)
      durationTicks = size.value === 4 ? buf.readFloatBE(pos) : buf.readDoubleBE(pos);
    }
    pos += size.value;
  }

  if (durationTicks === null) return null;
  return durationTicks * timecodeScale / 1e9;
}

// Returns duration in seconds, or null if it can't be determined.
export async function probeDuration(filePath) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const { size } = await fh.stat();
    const head = await read(fh, 0, 4);
    if (head.length < 4) return null;

    // EBML magic → WebM/MKV; otherwise assume an MP4-family box structure.
    if (head.readUInt32BE(0) === 0x1a45dfa3) return await webmDuration(fh);
    return await mp4Duration(fh, size);
  } finally {
    await fh.close();
  }
}
