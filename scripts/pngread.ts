import { inflateSync } from 'node:zlib';

/** Minimal PNG reader for the truecolour, non-interlaced file we generated. */
export function decodePng(bytes: Uint8Array): { width: number; height: number; rgba: Uint8ClampedArray } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 8;
  let width = 0;
  let height = 0;
  let channels = 3;
  const idat: Uint8Array[] = [];
  while (o + 8 <= bytes.length) {
    const len = view.getUint32(o, false);
    const type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
    const data = bytes.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      width = view.getUint32(o + 8, false);
      height = view.getUint32(o + 12, false);
      const colorType = bytes[o + 8 + 9];
      channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
    } else if (type === 'IDAT') {
      idat.push(new Uint8Array(data));
    } else if (type === 'IEND') break;
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat.map((c) => Buffer.from(c))));
  const stride = width * channels;
  const out = new Uint8ClampedArray(width * height * 4);
  const line = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    for (let i = 0; i < stride; i++) {
      const x = raw[p + i];
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v: number;
      switch (filter) {
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: {
          const pp = a + b - c;
          const pa = Math.abs(pp - a);
          const pb = Math.abs(pp - b);
          const pc = Math.abs(pp - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: v = x;
      }
      line[i] = v & 0xff;
    }
    p += stride;
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      out[d] = line[s];
      out[d + 1] = channels >= 3 ? line[s + 1] : line[s];
      out[d + 2] = channels >= 3 ? line[s + 2] : line[s];
      out[d + 3] = channels === 4 ? line[s + 3] : 255;
    }
    prev.set(line);
  }
  return { width, height, rgba: out };
}

