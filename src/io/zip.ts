/**
 * Minimal ZIP writer (stored, no compression). Used to hand a print shop one
 * file instead of several: PNG and JPEG are already compressed, so deflate
 * would only cost time. File names are UTF-8 (general purpose flag bit 11).
 */

export interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array | string;
  readonly date?: Date;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function createZip(entries: readonly ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const files = entries.map((e) => {
    const data = typeof e.data === 'string' ? encoder.encode(e.data) : e.data;
    return { name: encoder.encode(e.name), data, crc: crc32(data), ...dosTime(e.date ?? new Date()) };
  });

  let localSize = 0;
  let centralSize = 0;
  for (const f of files) {
    localSize += 30 + f.name.length + f.data.length;
    centralSize += 46 + f.name.length;
  }
  const total = localSize + centralSize + 22;
  if (total > 0xffffffff || files.length > 0xffff) throw new Error('ZIP too large');

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let p = 0;
  const offsets: number[] = [];
  for (const f of files) {
    offsets.push(p);
    view.setUint32(p, 0x04034b50, true);
    view.setUint16(p + 4, 20, true);
    view.setUint16(p + 6, 0x0800, true);
    view.setUint16(p + 8, 0, true);
    view.setUint16(p + 10, f.time, true);
    view.setUint16(p + 12, f.date, true);
    view.setUint32(p + 14, f.crc, true);
    view.setUint32(p + 18, f.data.length, true);
    view.setUint32(p + 22, f.data.length, true);
    view.setUint16(p + 26, f.name.length, true);
    view.setUint16(p + 28, 0, true);
    out.set(f.name, p + 30);
    out.set(f.data, p + 30 + f.name.length);
    p += 30 + f.name.length + f.data.length;
  }
  const centralStart = p;
  files.forEach((f, i) => {
    view.setUint32(p, 0x02014b50, true);
    view.setUint16(p + 4, 20, true);
    view.setUint16(p + 6, 20, true);
    view.setUint16(p + 8, 0x0800, true);
    view.setUint16(p + 10, 0, true);
    view.setUint16(p + 12, f.time, true);
    view.setUint16(p + 14, f.date, true);
    view.setUint32(p + 16, f.crc, true);
    view.setUint32(p + 20, f.data.length, true);
    view.setUint32(p + 24, f.data.length, true);
    view.setUint16(p + 28, f.name.length, true);
    view.setUint16(p + 30, 0, true);
    view.setUint16(p + 32, 0, true);
    view.setUint16(p + 34, 0, true);
    view.setUint16(p + 36, 0, true);
    view.setUint32(p + 38, 0, true);
    view.setUint32(p + 42, offsets[i], true);
    out.set(f.name, p + 46);
    p += 46 + f.name.length;
  });
  view.setUint32(p, 0x06054b50, true);
  view.setUint16(p + 4, 0, true);
  view.setUint16(p + 6, 0, true);
  view.setUint16(p + 8, files.length, true);
  view.setUint16(p + 10, files.length, true);
  view.setUint32(p + 12, p - centralStart, true);
  view.setUint32(p + 16, centralStart, true);
  view.setUint16(p + 20, 0, true);
  return out;
}
