/**
 * PNG encoder, including true indexed (colour type 3) output.
 *
 * The browser can already give us an RGBA PNG through canvas, but not an
 * indexed one — and an indexed PNG is the point when the whole image only
 * contains the eight colours of a palette. Bit depth follows the palette size,
 * so a 1-bit dither exports as a genuine 1-bit file.
 */

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Valid zlib stream built from stored (uncompressed) deflate blocks. */
function storedZlib(data: Uint8Array<ArrayBuffer>): Uint8Array {
  const blocks = Math.max(1, Math.ceil(data.length / 65535));
  const out = new Uint8Array(2 + blocks * 5 + data.length + 4);
  let o = 0;
  out[o++] = 0x78;
  out[o++] = 0x01;
  for (let i = 0; i < blocks; i++) {
    const start = i * 65535;
    const len = Math.min(65535, data.length - start);
    out[o++] = i === blocks - 1 ? 1 : 0;
    out[o++] = len & 0xff;
    out[o++] = (len >>> 8) & 0xff;
    out[o++] = ~len & 0xff;
    out[o++] = (~len >>> 8) & 0xff;
    out.set(data.subarray(start, start + len), o);
    o += len;
  }
  const ad = adler32(data);
  out[o++] = (ad >>> 24) & 0xff;
  out[o++] = (ad >>> 16) & 0xff;
  out[o++] = (ad >>> 8) & 0xff;
  out[o++] = ad & 0xff;
  return out.subarray(0, o);
}

async function zlibCompress(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const Ctor = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream;
  if (!Ctor) return storedZlib(data);
  try {
    // 'deflate' emits a zlib-wrapped stream, which is exactly what IDAT wants.
    const stream = new Ctor('deflate');
    const writer = stream.writable.getWriter();
    void writer.write(data);
    void writer.close();
    const chunks: Uint8Array[] = [];
    const reader = stream.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  } catch {
    return storedZlib(data);
  }
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcInput = out.subarray(4, 8 + data.length);
  view.setUint32(8 + data.length, crc32(crcInput), false);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export interface PngMeta {
  /**
   * Physical resolution written to the pHYs chunk. A DTF RIP or print service
   * reads the print size from this; without it the file is assumed 72 DPI
   * and arrives four times too large.
   */
  dpi?: number;
  /** Tag the file as sRGB (sRGB + gAMA chunks) so colour management is exact. */
  srgb?: boolean;
}

/**
 * Ancillary chunks that must precede PLTE/IDAT: gAMA and sRGB describe the
 * colour space (the PNG spec asks writers of sRGB to add gAMA for older
 * decoders), pHYs the physical pixel size in pixels per metre.
 */
function metaChunks(meta: PngMeta | undefined): Uint8Array[] {
  const out: Uint8Array[] = [];
  if (!meta) return out;
  if (meta.srgb) {
    const gama = new Uint8Array(4);
    new DataView(gama.buffer).setUint32(0, 45455, false);
    out.push(chunk('gAMA', gama));
    out.push(chunk('sRGB', new Uint8Array([0]))); // rendering intent: perceptual
  }
  if (meta.dpi !== undefined && meta.dpi > 0) {
    const ppm = Math.round(meta.dpi / 0.0254);
    const phys = new Uint8Array(9);
    const v = new DataView(phys.buffer);
    v.setUint32(0, ppm, false);
    v.setUint32(4, ppm, false);
    phys[8] = 1; // unit: metre
    out.push(chunk('pHYs', phys));
  }
  return out;
}

/** Truecolour + alpha PNG from an RGBA byte array. */
export async function encodePngRgba(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  meta?: PngMeta,
): Promise<Uint8Array> {
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const o = y * (1 + width * 4);
    raw[o] = 0; // filter: none
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), o + 1);
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width, false);
  view.setUint32(4, height, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    ...metaChunks(meta),
    chunk('IDAT', await zlibCompress(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

export interface IndexedImage {
  indices: Uint8Array;
  width: number;
  height: number;
  /** Flat sRGB 0..1 triplets. */
  palette: Float32Array;
}

/** Indexed PNG. Bit depth is chosen from the palette size: 1, 2, 4 or 8. */
export async function encodePngIndexed(image: IndexedImage, meta?: PngMeta): Promise<Uint8Array> {
  const colors = image.palette.length / 3;
  const depth = colors <= 2 ? 1 : colors <= 4 ? 2 : colors <= 16 ? 4 : 8;
  const perByte = 8 / depth;
  const bytesPerRow = Math.ceil(image.width / perByte);

  const raw = new Uint8Array(image.height * (1 + bytesPerRow));
  for (let y = 0; y < image.height; y++) {
    const rowStart = y * (1 + bytesPerRow);
    raw[rowStart] = 0;
    for (let x = 0; x < image.width; x++) {
      const idx = image.indices[y * image.width + x] & ((1 << depth) - 1);
      if (depth === 8) {
        raw[rowStart + 1 + x] = idx;
      } else {
        const byteIndex = rowStart + 1 + Math.floor(x / perByte);
        const shift = 8 - depth - (x % perByte) * depth;
        raw[byteIndex] |= idx << shift;
      }
    }
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, image.width, false);
  view.setUint32(4, image.height, false);
  ihdr[8] = depth;
  ihdr[9] = 3; // colour type: indexed

  const plteSize = 1 << depth;
  const plte = new Uint8Array(plteSize * 3);
  for (let i = 0; i < plteSize; i++) {
    const has = i < colors;
    plte[i * 3] = has ? Math.round(Math.min(1, Math.max(0, image.palette[i * 3])) * 255) : 0;
    plte[i * 3 + 1] = has ? Math.round(Math.min(1, Math.max(0, image.palette[i * 3 + 1])) * 255) : 0;
    plte[i * 3 + 2] = has ? Math.round(Math.min(1, Math.max(0, image.palette[i * 3 + 2])) * 255) : 0;
  }

  return concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    ...metaChunks(meta),
    chunk('PLTE', plte),
    chunk('IDAT', await zlibCompress(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/**
 * Map a rendered buffer onto a palette, returning indices. Colours that are
 * not exactly in the palette snap to the nearest entry, so an image that went
 * through a palette dither indexes losslessly.
 */
export function toIndexed(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  palette: Float32Array,
): IndexedImage {
  const colors = palette.length / 3;
  const indices = new Uint8Array(width * height);
  const cache = new Map<number, number>();
  for (let p = 0; p < width * height; p++) {
    const r = rgba[p * 4];
    const g = rgba[p * 4 + 1];
    const b = rgba[p * 4 + 2];
    const key = (r << 16) | (g << 8) | b;
    const hit = cache.get(key);
    if (hit !== undefined) {
      indices[p] = hit;
      continue;
    }
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < colors; i++) {
      const dr = r - palette[i * 3] * 255;
      const dg = g - palette[i * 3 + 1] * 255;
      const db = b - palette[i * 3 + 2] * 255;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    cache.set(key, best);
    indices[p] = best;
  }
  return { indices, width, height, palette };
}

/** Collect every distinct colour, up to `limit`; null when there are more. */
export function collectPalette(
  rgba: Uint8ClampedArray,
  limit = 256,
): Float32Array | null {
  const seen = new Map<number, number>();
  for (let p = 0; p < rgba.length; p += 4) {
    const key = (rgba[p] << 16) | (rgba[p + 1] << 8) | rgba[p + 2];
    if (!seen.has(key)) {
      if (seen.size >= limit) return null;
      seen.set(key, seen.size);
    }
  }
  const out = new Float32Array(seen.size * 3);
  let i = 0;
  for (const key of seen.keys()) {
    out[i++] = ((key >> 16) & 255) / 255;
    out[i++] = ((key >> 8) & 255) / 255;
    out[i++] = (key & 255) / 255;
  }
  return out;
}
