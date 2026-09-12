import { describe, expect, it } from 'vitest';
import { collectPalette, encodePngIndexed, encodePngRgba, toIndexed } from '../../src/io/png';

function readChunks(png: Uint8Array): { type: string; length: number }[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out: { type: string; length: number }[] = [];
  let o = 8;
  while (o + 8 <= png.length) {
    const length = view.getUint32(o, false);
    const type = String.fromCharCode(png[o + 4], png[o + 5], png[o + 6], png[o + 7]);
    out.push({ type, length });
    o += 12 + length;
  }
  return out;
}

describe('png encoder', () => {
  it('writes a valid signature and chunk order for RGBA', async () => {
    const rgba = new Uint8ClampedArray(4 * 4 * 4).fill(128);
    const png = await encodePngRgba(rgba, 4, 4);
    expect(Array.from(png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const chunks = readChunks(png);
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(chunks[0].length).toBe(13);
  });

  it('writes an indexed PNG at 1 bit for a two-colour palette', async () => {
    const palette = new Float32Array([0, 0, 0, 1, 1, 1]);
    const indices = new Uint8Array(16 * 16);
    for (let i = 0; i < indices.length; i++) indices[i] = i % 2;
    const png = await encodePngIndexed({ indices, width: 16, height: 16, palette });
    const chunks = readChunks(png);
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'PLTE', 'IDAT', 'IEND']);
    // IHDR byte 8 is the bit depth, byte 9 the colour type.
    expect(png[8 + 8 + 8]).toBe(1);
    expect(png[8 + 8 + 9]).toBe(3);
    // PLTE holds 2^depth entries.
    expect(chunks[1].length).toBe(6);
  });

  it('picks 4-bit depth for a 16-colour palette', async () => {
    const palette = new Float32Array(16 * 3).map((_, i) => (i % 3) / 3);
    const png = await encodePngIndexed({
      indices: new Uint8Array(8 * 8), width: 8, height: 8, palette,
    });
    expect(png[8 + 8 + 8]).toBe(4);
  });

  it('round-trips an image through the indexer', () => {
    const palette = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const rgba = new Uint8ClampedArray([
      0, 0, 0, 255,
      255, 0, 0, 255,
      0, 255, 0, 255,
      2, 1, 0, 255,
    ]);
    const indexed = toIndexed(rgba, 4, 1, palette);
    expect(Array.from(indexed.indices)).toEqual([0, 1, 2, 0]);
  });

  it('collects distinct colours and gives up past the limit', () => {
    const rgba = new Uint8ClampedArray(64 * 4);
    for (let i = 0; i < 64; i++) {
      rgba[i * 4] = i * 4;
      rgba[i * 4 + 3] = 255;
    }
    expect(collectPalette(rgba, 256)?.length).toBe(64 * 3);
    expect(collectPalette(rgba, 10)).toBeNull();
  });
});
