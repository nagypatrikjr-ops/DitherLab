import { describe, expect, it } from 'vitest';
import {
  bufferFromRgba,
  bufferToRgba,
  createBuffer,
  resampleBox,
  resampleNearest,
  toColorSpace,
} from '../../src/core/buffer';
import { linearToSrgb, srgbToLab, srgbToLinear } from '../../src/core/color/space';
import { PaletteQuantizer } from '../../src/core/color/quantizer';
import { bayerRanks, voidAndClusterRanks } from '../../src/core/dither/ordered/matrices';
import { hilbertD2XY } from '../../src/core/dither/common/walk';
import { composite } from '../../src/core/blend';
import { paletteFromHex } from '../../src/core/palette/builtin';
import { parseGpl, parseHexPalette, paletteToGpl } from '../../src/core/palette/io';
import { Rng, hashString, temporalSeed } from '../../src/core/rng';
import { FLOYD_STEINBERG, JARVIS, STUCKI, ATKINSON, BURKES, SIERRA3, kernelFromMatrix } from '../../src/core/dither/errorDiffusion/kernels';

describe('colour space', () => {
  it('round-trips sRGB through linear', () => {
    for (const v of [0, 0.02, 0.04045, 0.5, 0.9, 1]) {
      expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 6);
    }
  });

  it('places pure white at L*=100 with neutral chroma', () => {
    const [l, a, b] = srgbToLab(1, 1, 1);
    expect(l).toBeCloseTo(100, 3);
    expect(a).toBeCloseTo(0, 3);
    expect(b).toBeCloseTo(0, 3);
  });

  it('places mid grey near L*=53.4', () => {
    const [l] = srgbToLab(0.5, 0.5, 0.5);
    expect(l).toBeGreaterThan(53);
    expect(l).toBeLessThan(54);
  });
});

describe('buffers', () => {
  it('round-trips 8-bit RGBA', () => {
    const rgba = new Uint8ClampedArray([0, 128, 255, 255, 10, 20, 30, 128]);
    const buf = bufferFromRgba(rgba, 2, 1);
    const back = bufferToRgba(buf);
    expect(Array.from(back)).toEqual(Array.from(rgba));
  });

  it('box-downscales a 2x2 to its average', () => {
    const buf = createBuffer(2, 2);
    buf.data.set([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1, 1, 1]);
    const small = resampleBox(buf, 1, 1);
    expect(small.data[0]).toBeCloseTo(0.5, 6);
    expect(small.data[1]).toBeCloseTo(0.5, 6);
    expect(small.data[2]).toBeCloseTo(0.5, 6);
  });

  it('nearest-upscales without inventing values', () => {
    const buf = createBuffer(2, 1);
    buf.data.set([1, 0, 0, 1, 0, 0, 1, 1]);
    const big = resampleNearest(buf, 4, 1);
    expect(Array.from(big.data.slice(0, 4))).toEqual([1, 0, 0, 1]);
    expect(Array.from(big.data.slice(4, 8))).toEqual([1, 0, 0, 1]);
    expect(Array.from(big.data.slice(8, 12))).toEqual([0, 0, 1, 1]);
  });

  it('converts colour spaces symmetrically', () => {
    const buf = createBuffer(1, 1);
    buf.data.set([0.2, 0.5, 0.8, 1]);
    const lin = toColorSpace(buf, 'linear');
    const back = toColorSpace(lin, 'srgb');
    expect(back.data[0]).toBeCloseTo(0.2, 6);
    expect(back.data[1]).toBeCloseTo(0.5, 6);
    expect(back.data[2]).toBeCloseTo(0.8, 6);
  });
});

describe('quantizer', () => {
  const pal = paletteFromHex('t', 'test', 'test', ['#000000', '#FF0000', '#00FF00', '#FFFFFF']);

  it('finds the exact nearest colour', () => {
    const q = new PaletteQuantizer(pal, 'rgb');
    expect(q.nearestExact(0.9, 0.05, 0.05)).toBe(1);
    expect(q.nearestExact(0.05, 0.9, 0.05)).toBe(2);
    expect(q.nearestExact(0.02, 0.02, 0.02)).toBe(0);
    expect(q.nearestExact(0.98, 0.98, 0.98)).toBe(3);
  });

  it('keeps ranking sane far outside the gamut, for every metric', () => {
    // Error diffusion overshoots hard on palettes whose entries are all
    // brighter than the image. The weighted-RGB coefficient (2 + rmean) hits
    // zero around r = -2, so an unclamped query silently picks nonsense.
    const riso = paletteFromHex('r', 'riso', 'p', ['#FFFFFF', '#FF48B0', '#0078BF', '#5C3B8E']);
    for (const metric of ['rgb', 'weightedRgb', 'cie76', 'ciede2000'] as const) {
      const q = new PaletteQuantizer(riso, metric);
      const darkest = q.nearestExact(0, 0, 0);
      for (const v of [-0.5, -2, -5, -50]) {
        expect(q.nearestExact(v, v, v), `${metric} @ ${v}`).toBe(darkest);
      }
      for (const v of [1.5, 4, 60]) {
        expect(q.nearestExact(v, v, v), `${metric} @ ${v}`).toBe(q.nearestExact(1, 1, 1));
      }
    }
  });

  it('clamps out-of-range input instead of failing', () => {
    const q = new PaletteQuantizer(pal, 'weightedRgb');
    expect(q.nearest(-2, -2, -2)).toBe(0);
    expect(q.nearest(4, 4, 4)).toBe(3);
  });

  it('matches the exhaustive search on the snapped query, for every metric', () => {
    const big = paletteFromHex('b', 'b', 'b', [
      '#000000', '#222222', '#444444', '#888888', '#CCCCCC', '#FFFFFF',
      '#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#00FFFF', '#FF00FF',
    ]);
    // The cube quantises the *query* to 6 bits per channel. The exact contract
    // is therefore: LUT(c) === exhaustive(snap(c)). Anything else would mean a
    // wrong cell, not an acceptable rounding.
    const snap = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 63) / 63;
    for (const metric of ['rgb', 'weightedRgb', 'cie76', 'ciede2000'] as const) {
      const q = new PaletteQuantizer(big, metric);
      const rng = new Rng(7);
      let mismatches = 0;
      for (let i = 0; i < 400; i++) {
        const r = rng.next();
        const g = rng.next();
        const b = rng.next();
        expect(q.nearest(r, g, b)).toBe(q.nearestExact(snap(r), snap(g), snap(b)));
        if (q.nearest(r, g, b) !== q.nearestExact(r, g, b)) mismatches++;
      }
      // Snapping should only change the answer for queries sitting on a
      // Voronoi boundary, which is a small minority.
      expect(mismatches / 400).toBeLessThan(0.05);
    }
  });
});

describe('ordered matrices', () => {
  it('generates the canonical Bayer 4x4', () => {
    expect(Array.from(bayerRanks(4))).toEqual([
      0, 8, 2, 10,
      12, 4, 14, 6,
      3, 11, 1, 9,
      15, 7, 13, 5,
    ]);
  });

  it('generates the canonical Bayer 2x2', () => {
    expect(Array.from(bayerRanks(2))).toEqual([0, 2, 3, 1]);
  });

  it('rejects non-power-of-two sizes', () => {
    expect(() => bayerRanks(6)).toThrow();
  });

  it('void-and-cluster produces a complete permutation', () => {
    const ranks = voidAndClusterRanks(16, 1.5, 3);
    const seen = new Set(Array.from(ranks));
    expect(seen.size).toBe(256);
    expect(Math.min(...ranks)).toBe(0);
    expect(Math.max(...ranks)).toBe(255);
  });

  it('void-and-cluster is deterministic for a given seed', () => {
    const a = voidAndClusterRanks(16, 1.5, 11);
    const b = voidAndClusterRanks(16, 1.5, 11);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

describe('hilbert curve', () => {
  it('visits every cell of a 4x4 grid exactly once', () => {
    const seen = new Set<string>();
    for (let d = 0; d < 16; d++) {
      const [x, y] = hilbertD2XY(2, d);
      seen.add(`${x},${y}`);
    }
    expect(seen.size).toBe(16);
  });

  it('moves only to orthogonal neighbours', () => {
    let [px, py] = hilbertD2XY(3, 0);
    for (let d = 1; d < 64; d++) {
      const [x, y] = hilbertD2XY(3, d);
      expect(Math.abs(x - px) + Math.abs(y - py)).toBe(1);
      px = x;
      py = y;
    }
  });
});

describe('error diffusion kernels', () => {
  it('has weights that sum to the divisor, except Atkinson', () => {
    for (const k of [FLOYD_STEINBERG, JARVIS, STUCKI, BURKES, SIERRA3]) {
      const sum = k.entries.reduce((a, e) => a + e.w, 0);
      expect(sum).toBe(k.divisor);
    }
    const atk = ATKINSON.entries.reduce((a, e) => a + e.w, 0);
    expect(atk).toBe(6);
    expect(ATKINSON.divisor).toBe(8);
  });

  it('only diffuses forward', () => {
    for (const k of [FLOYD_STEINBERG, JARVIS, STUCKI, ATKINSON, BURKES, SIERRA3]) {
      for (const e of k.entries) {
        expect(e.dy >= 0).toBe(true);
        if (e.dy === 0) expect(e.dx).toBeGreaterThan(0);
      }
    }
  });

  it('builds a Floyd-Steinberg-equivalent kernel from a matrix', () => {
    const k = kernelFromMatrix([0, 0, 0, 7, 0, 0, 3, 5, 1, 0, 0, 0, 0, 0, 0], 5, 3);
    expect(k.divisor).toBe(16);
    const sorted = [...k.entries].sort((a, b) => a.dy - b.dy || a.dx - b.dx);
    expect(sorted).toEqual([
      { dx: 1, dy: 0, w: 7 },
      { dx: -1, dy: 1, w: 3 },
      { dx: 0, dy: 1, w: 5 },
      { dx: 1, dy: 1, w: 1 },
    ]);
  });
});

describe('blend modes', () => {
  const mk = (r: number, g: number, b: number) => {
    const buf = createBuffer(1, 1);
    buf.data.set([r, g, b, 1]);
    return buf;
  };

  it('multiply darkens', () => {
    const out = composite(mk(0.5, 0.5, 0.5), mk(0.5, 0.5, 0.5), 'multiply', 1);
    expect(out.data[0]).toBeCloseTo(0.25, 6);
  });

  it('screen lightens', () => {
    const out = composite(mk(0.5, 0.5, 0.5), mk(0.5, 0.5, 0.5), 'screen', 1);
    expect(out.data[0]).toBeCloseTo(0.75, 6);
  });

  it('difference of equal colours is black', () => {
    const out = composite(mk(0.3, 0.6, 0.9), mk(0.3, 0.6, 0.9), 'difference', 1);
    expect(out.data[0]).toBeCloseTo(0, 6);
    expect(out.data[1]).toBeCloseTo(0, 6);
  });

  it('opacity 0 leaves the base untouched', () => {
    const out = composite(mk(0.3, 0.6, 0.9), mk(1, 0, 0), 'multiply', 0);
    expect(out.data[0]).toBeCloseTo(0.3, 6);
    expect(out.data[1]).toBeCloseTo(0.6, 6);
  });
});

describe('palette io', () => {
  it('parses hex lists and ignores comments', () => {
    const p = parseHexPalette('; comment\n#FF0000\n00ff00\n\n0000FF\n');
    expect(p.colors.length).toBe(9);
    expect(p.colors[0]).toBeCloseTo(1, 5);
    expect(p.colors[4]).toBeCloseTo(1, 5);
    expect(p.colors[8]).toBeCloseTo(1, 5);
  });

  it('round-trips through the GIMP format', () => {
    const src = paletteFromHex('x', 'Teszt', 'c', ['#102030', '#A0B0C0']);
    const parsed = parseGpl(paletteToGpl(src));
    expect(parsed.name).toBe('Teszt');
    expect(parsed.colors.length).toBe(6);
    expect(parsed.colors[0] * 255).toBeCloseTo(0x10, 0);
    expect(parsed.colors[5] * 255).toBeCloseTo(0xc0, 0);
  });
});

describe('rng', () => {
  it('is reproducible for a seed', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 50; i++) expect(a.next()).toBe(b.next());
  });

  it('decorrelates neighbouring seeds', () => {
    const a = new Rng(1).next();
    const b = new Rng(2).next();
    expect(Math.abs(a - b)).toBeGreaterThan(0.001);
  });

  it('stays inside [0,1)', () => {
    const r = new Rng(9);
    for (let i = 0; i < 5000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('honours the temporal stability modes', () => {
    const base = hashString('doc');
    expect(temporalSeed(base, 'l', 0, 'static', 8)).toBe(temporalSeed(base, 'l', 5, 'static', 8));
    expect(temporalSeed(base, 'l', 0, 'perFrame', 8)).not.toBe(
      temporalSeed(base, 'l', 1, 'perFrame', 8),
    );
    expect(temporalSeed(base, 'l', 0, 'cycling', 8)).toBe(
      temporalSeed(base, 'l', 8, 'cycling', 8),
    );
    expect(temporalSeed(base, 'l', 0, 'cycling', 8)).not.toBe(
      temporalSeed(base, 'l', 3, 'cycling', 8),
    );
  });
});
