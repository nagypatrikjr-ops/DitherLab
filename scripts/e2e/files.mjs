// Checks that a saved file is what its name says it is — not merely that
// something with that name appeared.

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import path from 'node:path';

function fail(file, why) {
  throw new Error(`${path.basename(file)}: ${why}`);
}

/** PNG: signature, IHDR size, pHYs resolution if present, and a decodable IDAT stream. */
export function inspectPng(file) {
  const b = readFileSync(file);
  if (b.length < 45 || b.readUInt32BE(0) !== 0x89504e47) fail(file, 'not a PNG');
  let p = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let dpi = null;
  const idat = [];
  let sawEnd = false;
  while (p + 8 <= b.length) {
    const len = b.readUInt32BE(p);
    const type = b.toString('latin1', p + 4, p + 8);
    const body = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      colorType = body[9];
    } else if (type === 'pHYs' && body[8] === 1) {
      dpi = Math.round(body.readUInt32BE(0) * 0.0254);
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      sawEnd = true;
      break;
    }
    p += 12 + len;
  }
  if (!sawEnd) fail(file, 'truncated (no IEND)');
  if (width === 0 || height === 0) fail(file, 'no size');
  let raw;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch (e) {
    fail(file, `image data does not decompress: ${e.message}`);
  }
  if (raw.length === 0) fail(file, 'empty image data');
  return { width, height, colorType, dpi, bytes: b.length };
}

/** Alpha of an RGBA, non-interlaced, 8-bit PNG: the set of values used. */
export function pngAlphaValues(file) {
  const b = readFileSync(file);
  let p = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let bitDepth = 0;
  const idat = [];
  while (p + 8 <= b.length) {
    const len = b.readUInt32BE(p);
    const type = b.toString('latin1', p + 4, p + 8);
    const body = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (colorType !== 6 || bitDepth !== 8) return null;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const seen = new Set();
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? cur[i - 4] : 0;
      const up = prev[i];
      const c = i >= 4 ? prev[i - 4] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += up;
      else if (filter === 3) v += (a + up) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(up - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + up - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      cur[i] = v & 255;
    }
    for (let i = 3; i < stride; i += 4) seen.add(cur[i]);
    prev = cur;
  }
  return [...seen].sort((x, y) => x - y);
}

export function inspectJpeg(file) {
  const b = readFileSync(file);
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) fail(file, 'not a JPEG');
  if (b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) fail(file, 'truncated JPEG (no EOI)');
  return { bytes: b.length };
}

export function inspectWebp(file) {
  const b = readFileSync(file);
  if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') fail(file, 'not a WEBP');
  if (b.readUInt32LE(4) + 8 !== b.length) fail(file, 'RIFF size does not match the file');
  return { bytes: b.length };
}

export function inspectTiff(file) {
  const b = readFileSync(file);
  const order = b.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') fail(file, 'not a TIFF');
  const read16 = (o) => (order === 'II' ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const read32 = (o) => (order === 'II' ? b.readUInt32LE(o) : b.readUInt32BE(o));
  if (read16(2) !== 42) fail(file, 'bad TIFF magic');
  const ifd = read32(4);
  if (ifd >= b.length) fail(file, 'IFD outside the file');
  const entries = read16(ifd);
  let width = 0;
  let height = 0;
  for (let i = 0; i < entries; i++) {
    const e = ifd + 2 + i * 12;
    const tag = read16(e);
    const type = read16(e + 2);
    const value = type === 3 ? read16(e + 8) : read32(e + 8);
    if (tag === 256) width = value;
    if (tag === 257) height = value;
  }
  if (width === 0 || height === 0) fail(file, 'no size in TIFF');
  return { width, height, bytes: b.length };
}

export function inspectPdf(file) {
  const b = readFileSync(file);
  if (b.toString('latin1', 0, 5) !== '%PDF-') fail(file, 'not a PDF');
  if (!b.toString('latin1', Math.max(0, b.length - 32)).includes('%%EOF')) fail(file, 'truncated PDF');
  return { bytes: b.length };
}

export function inspectSvg(file) {
  const s = readFileSync(file, 'utf8');
  if (!/<svg[\s>]/.test(s) || !s.trimEnd().endsWith('</svg>')) fail(file, 'not a complete SVG');
  return { bytes: s.length, paths: (s.match(/<path/g) ?? []).length };
}

/** ZIP: walk the central directory and return the stored names. */
export function inspectZip(file) {
  const b = readFileSync(file);
  if (b.readUInt32LE(0) !== 0x04034b50) fail(file, 'not a ZIP');
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) fail(file, 'no end-of-central-directory record');
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    if (b.readUInt32LE(p) !== 0x02014b50) fail(file, 'broken central directory');
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    names.push(b.toString('utf8', p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { names, bytes: b.length };
}

export function readText(file) {
  return readFileSync(file, 'utf8');
}
