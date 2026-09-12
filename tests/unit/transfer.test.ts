import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { createBuffer } from '../../src/core/buffer';
import { srgbToLinear } from '../../src/core/color/space';
import type { PixelBuffer, RGB } from '../../src/core/types';
import {
  DEFAULT_TRANSFER,
  MAX_PRINT_MM,
  PLACEMENTS,
  analyzeComponents,
  analyzeTransfer,
  effectiveMinDotMm,
  erodeDisk,
  fillSmallHoles,
  mirrorRgba,
  mitchell,
  mmToPx,
  openDisk,
  removeSmallInk,
  renderTransfer,
  squaredDistance,
  StreamResampler,
  transferSize,
  unsupportedInk,
  type TransferSettings,
} from '../../src/core/transfer';
import { encodePngRgba } from '../../src/io/png';
import { fillHoleColors } from '../../src/core/transfer/engine';
import { encodeTiff } from '../../src/io/image';

const BLACK: RGB = DEFAULT_TRANSFER.garment;
const WHITE: RGB = { r: 1, g: 1, b: 1 };

function settings(over: Partial<TransferSettings> = {}): TransferSettings {
  return {
    ...DEFAULT_TRANSFER,
    ...over,
    knockout: { ...DEFAULT_TRANSFER.knockout, ...(over.knockout ?? {}) },
    screen: { ...DEFAULT_TRANSFER.screen, ...(over.screen ?? {}) },
    edgeFade: { ...DEFAULT_TRANSFER.edgeFade, ...(over.edgeFade ?? {}) },
    adjust: { ...DEFAULT_TRANSFER.adjust, ...(over.adjust ?? {}) },
  };
}

function flat(color: RGB, w: number, h: number, alpha = 1): PixelBuffer {
  const b = createBuffer(w, h);
  for (let i = 0; i < b.data.length; i += 4) {
    b.data[i] = color.r;
    b.data[i + 1] = color.g;
    b.data[i + 2] = color.b;
    b.data[i + 3] = alpha;
  }
  return b;
}

function inkFraction(rgba: Uint8ClampedArray): number {
  let on = 0;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 0) on++;
  return on / (rgba.length / 4);
}

/** Linear-light average of what the eye sees: ink colour where printed, shirt elsewhere. */
function perceivedLinear(rgba: Uint8ClampedArray, garment: RGB): [number, number, number] {
  const t = [srgbToLinear(garment.r), srgbToLinear(garment.g), srgbToLinear(garment.b)];
  const acc = [0, 0, 0];
  const n = rgba.length / 4;
  for (let p = 0; p < n; p++) {
    for (let c = 0; c < 3; c++) {
      acc[c] += rgba[p * 4 + 3] !== 0 ? srgbToLinear(rgba[p * 4 + c] / 255) : t[c];
    }
  }
  return [acc[0] / n, acc[1] / n, acc[2] / n];
}

// A 40 mm wide print keeps every test fast while staying at a real 300 DPI.
const SMALL: Partial<TransferSettings> = { widthMm: 40 };

describe('knockout', () => {
  it('prints nothing where the artwork matches the shirt', () => {
    const r = renderTransfer(flat(BLACK, 60, 40), settings(SMALL));
    expect(inkFraction(r.rgba)).toBe(0);
  });

  it('prints pure white solid', () => {
    const r = renderTransfer(flat(WHITE, 60, 40), settings(SMALL));
    expect(inkFraction(r.rgba)).toBe(1);
    expect(r.rgba[0]).toBe(255);
    expect(r.rgba[1]).toBe(255);
  });

  it('keeps colours above the solid point solid and true to the original', () => {
    const red: RGB = { r: 0.9, g: 0.1, b: 0.15 };
    const r = renderTransfer(flat(red, 60, 40), settings(SMALL));
    expect(inkFraction(r.rgba)).toBe(1);
    expect(Math.abs(r.rgba[0] - 0.9 * 255)).toBeLessThanOrEqual(2);
    expect(Math.abs(r.rgba[1] - 0.1 * 255)).toBeLessThanOrEqual(2);
  });

  it('reproduces a dark tone with dots whose average matches the original', () => {
    // The physics check: dots of ink colour C over bare shirt must average,
    // in linear light, to the colour the artwork asked for.
    const dark: RGB = { r: 0.45, g: 0.06, b: 0.1 };
    const r = renderTransfer(flat(dark, 120, 80), settings({ widthMm: 60 }));
    const f = inkFraction(r.rgba);
    expect(f).toBeGreaterThan(0.2);
    expect(f).toBeLessThan(0.95);
    const seen = perceivedLinear(r.rgba, BLACK);
    expect(Math.abs(seen[0] - srgbToLinear(dark.r))).toBeLessThan(0.02);
    expect(Math.abs(seen[1] - srgbToLinear(dark.g))).toBeLessThan(0.01);
  });

  it('knocks out a non-black garment colour exactly', () => {
    const navy: RGB = { r: 0.09, g: 0.12, b: 0.22 };
    const r = renderTransfer(flat(navy, 60, 40), settings({ ...SMALL, garment: navy }));
    expect(inkFraction(r.rgba)).toBe(0);
  });

  it('prints garment-coloured areas when the knockout is off, and says so', () => {
    const s = settings({ ...SMALL, knockout: { ...DEFAULT_TRANSFER.knockout, enabled: false } });
    const r = renderTransfer(flat(BLACK, 60, 40), s);
    expect(inkFraction(r.rgba)).toBe(1);
    const a = analyzeTransfer(r, s);
    expect(a.checks.find((c) => c.id === 'knockout')?.level).toBe('warn');
  });

  it('treats source transparency as the shirt showing through', () => {
    const r0 = renderTransfer(flat(WHITE, 60, 40, 0), settings(SMALL));
    expect(inkFraction(r0.rgba)).toBe(0);

    const off = settings({ widthMm: 60, knockout: { ...DEFAULT_TRANSFER.knockout, enabled: false } });
    const half = renderTransfer(flat(WHITE, 120, 80, 0.5), off);
    expect(Math.abs(inkFraction(half.rgba) - 0.5)).toBeLessThan(0.04);
  });
});

describe('output invariants', () => {
  function busy(w: number, h: number): PixelBuffer {
    const b = createBuffer(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const n = ((x * 7919 + y * 104729) % 97) / 97;
        b.data[i] = (x / w) * 0.8 + n * 0.2;
        b.data[i + 1] = (y / h) * 0.6;
        b.data[i + 2] = 0.5 * n;
        b.data[i + 3] = x < w * 0.1 ? 0 : x < w * 0.2 ? 0.5 : 1;
      }
    }
    return b;
  }

  it('never writes a semi-transparent pixel', () => {
    for (const kind of ['am', 'fm'] as const) {
      const r = renderTransfer(busy(90, 60), settings({ widthMm: 50, screen: { ...DEFAULT_TRANSFER.screen, kind } }));
      for (let i = 3; i < r.rgba.length; i += 4) {
        if (r.rgba[i] !== 0 && r.rgba[i] !== 255) throw new Error(`alpha ${r.rgba[i]} at ${i}`);
      }
      expect(analyzeTransfer(r, settings()).stats.semiTransparent).toBe(0);
    }
  });

  it('is deterministic', () => {
    const s = settings({ widthMm: 50 });
    const a = renderTransfer(busy(90, 60), s);
    const b = renderTransfer(busy(90, 60), s);
    expect(Buffer.from(a.rgba).equals(Buffer.from(b.rgba))).toBe(true);
  });
});

describe('screening', () => {
  // Coverage straight from source alpha, knockout off: a clean tone ramp.
  const off = (kind: 'am' | 'fm') =>
    settings({
      widthMm: 80,
      knockout: { ...DEFAULT_TRANSFER.knockout, enabled: false },
      screen: { ...DEFAULT_TRANSFER.screen, kind },
    });

  for (const kind of ['am', 'fm'] as const) {
    it(`${kind.toUpperCase()}: ink coverage follows the requested tone`, () => {
      for (const a of [0.05, 0.1, 0.2, 0.35, 0.5, 0.65, 0.8]) {
        const r = renderTransfer(flat(WHITE, 160, 120, a), off(kind));
        expect(Math.abs(inkFraction(r.rgba) - a), `${kind} @ ${a}`).toBeLessThan(0.035);
      }
    });

    it(`${kind.toUpperCase()}: shadows never print lighter than asked`, () => {
      for (const a of [0.88, 0.94]) {
        const r = renderTransfer(flat(WHITE, 160, 120, a), off(kind));
        expect(inkFraction(r.rgba), `${kind} @ ${a}`).toBeGreaterThan(a - 0.03);
      }
    });

    it(`${kind.toUpperCase()}: every dot is at least the printable minimum`, () => {
      const s = off(kind);
      for (const a of [0.04, 0.12, 0.25]) {
        const r = renderTransfer(flat(WHITE, 160, 120, a), s);
        const minArea = (Math.PI / 4) * r.minDotPx * r.minDotPx;
        const mask = new Uint8Array(r.width * r.height);
        for (let p = 0; p < mask.length; p++) mask[p] = r.rgba[p * 4 + 3] !== 0 ? 1 : 0;
        const info = analyzeComponents(mask, r.width, r.height, 1, 8);
        for (let run = 0; run < info.runCount; run++) {
          const root = info.rootOfRun[run];
          if (root !== run || info.touchesBorder[root] === 1) continue;
          expect(info.area[root], `${kind} @ ${a}`).toBeGreaterThanOrEqual(minArea * 0.8);
        }
      }
    });
  }

  it('raises the minimum dot when the choke would strip its white', () => {
    const s = settings({ chokeMm: 0.3 });
    // Twice the choke plus a three-pixel white core at the file's resolution.
    expect(effectiveMinDotMm(s)).toBeCloseTo(0.6 + (3 * 25.4) / 300, 6);
    const r = renderTransfer(flat(WHITE, 120, 80, 0.1), {
      ...s,
      widthMm: 60,
      knockout: { ...s.knockout, enabled: false },
    });
    const a = analyzeTransfer(r, s);
    expect(a.stats.unsupportedCount).toBe(0);
  });
});

describe('edges', () => {
  function square(): PixelBuffer {
    const w = 80;
    const h = 60;
    const b = flat(BLACK, w, h);
    for (let y = 20; y < 40; y++) {
      for (let x = 25; x < 55; x++) {
        const i = (y * w + x) * 4;
        b.data[i] = 1;
        b.data[i + 1] = 1;
        b.data[i + 2] = 1;
      }
    }
    return b;
  }

  it('keeps a hard edge crisp, with no specks from resampling ringing', () => {
    // 80 source pixels printed 80 mm wide: an 11.8x enlargement, where a
    // naive resample would smear the edge over ~24 output pixels of dots.
    const s = settings({ widthMm: 80 });
    const r = renderTransfer(square(), s);
    const sx = r.width / 80;
    const sy = r.height / 60;
    // Inside is solid.
    for (let y = Math.ceil(22 * sy); y < Math.floor(38 * sy); y++) {
      for (let x = Math.ceil(27 * sx); x < Math.floor(53 * sx); x++) {
        expect(r.rgba[(y * r.width + x) * 4 + 3]).toBe(255);
      }
    }
    // Nothing beyond two output pixels outside the square.
    for (let y = 0; y < r.height; y++) {
      for (let x = 0; x < r.width; x++) {
        const inside =
          x >= 25 * sx - 2 && x < 55 * sx + 2 && y >= 20 * sy - 2 && y < 40 * sy + 2;
        if (!inside && r.rgba[(y * r.width + x) * 4 + 3] !== 0) {
          throw new Error(`stray ink at ${x},${y}`);
        }
      }
    }
  });

  it('puts the enlarged edge exactly where the source edge is', () => {
    const s = settings({ widthMm: 80 });
    const r = renderTransfer(square(), s);
    const sx = r.width / 80;
    const sy = r.height / 60;
    let ink = 0;
    for (let i = 3; i < r.rgba.length; i += 4) if (r.rgba[i] !== 0) ink++;
    const ideal = 30 * sx * (20 * sy);
    // No growth or shrinkage beyond one output pixel around the perimeter.
    const perimeter = 2 * (30 * sx + 20 * sy);
    expect(Math.abs(ink - ideal)).toBeLessThan(perimeter);
  });

  it('keeps the colour of an edge equal to the shape it belongs to', () => {
    const s = settings({ widthMm: 80 });
    const r = renderTransfer(square(), s);
    for (let p = 0; p < r.width * r.height; p++) {
      if (r.rgba[p * 4 + 3] === 0) continue;
      if (r.rgba[p * 4] < 250) throw new Error(`grey edge pixel ${r.rgba[p * 4]} at ${p}`);
    }
  });

  it('fades the outer edge into dots', () => {
    const s = settings({ widthMm: 80, edgeFade: { shape: 'rect', widthMm: 15 } });
    const r = renderTransfer(flat(WHITE, 100, 100), s);
    const rowInk = (y: number): number => {
      let on = 0;
      for (let x = 0; x < r.width; x++) if (r.rgba[(y * r.width + x) * 4 + 3] !== 0) on++;
      return on / r.width;
    };
    expect(rowInk(0)).toBeLessThan(0.02);
    expect(rowInk(Math.floor(r.height / 2))).toBeGreaterThan(0.6);
    expect(rowInk(Math.floor(r.height * 0.05))).toBeLessThan(rowInk(Math.floor(r.height * 0.12)));
  });
});

describe('cleanup', () => {
  function grainy(w: number, h: number): PixelBuffer {
    // Black shirt-coloured field with isolated bright grain pixels and pairs.
    const b = flat(BLACK, w, h);
    let seed = 99;
    for (let i = 0; i < w * h; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      if (seed % 53 === 0) {
        b.data[i * 4] = 0.9;
        b.data[i * 4 + 1] = 0.9;
        b.data[i * 4 + 2] = 0.9;
        if (i + 1 < w * h && (seed >> 8) % 2 === 0) {
          b.data[(i + 1) * 4] = 0.9;
          b.data[(i + 1) * 4 + 1] = 0.9;
          b.data[(i + 1) * 4 + 2] = 0.9;
        }
      }
    }
    return b;
  }

  it('leaves no element without white under it', () => {
    const s = settings({ widthMm: 120 });
    const r = renderTransfer(grainy(200, 150), s);
    expect(analyzeTransfer(r, s).stats.unsupportedCount).toBe(0);
  });

  it('never deletes a long thin line from the design — it flags it instead', () => {
    const w = 200;
    const src = flat(BLACK, w, 100);
    for (let x = 20; x < 180; x++) {
      const i = (50 * w + x) * 4;
      src.data[i] = 1;
      src.data[i + 1] = 1;
      src.data[i + 2] = 1;
    }
    const s = settings({ widthMm: 40 }); // one source pixel is 0.2 mm here
    const r = renderTransfer(src, s);
    const y = Math.round((50.5 / 100) * r.height);
    let onRow = 0;
    for (let x = 0; x < r.width; x++) if (r.rgba[(y * r.width + x) * 4 + 3] !== 0) onRow++;
    expect(onRow).toBeGreaterThan(r.width * 0.7);
    expect(analyzeTransfer(r, s).stats.thinCount).toBeGreaterThanOrEqual(1);
  });

  it('keeps shadow holes that are large enough to print', () => {
    const s = settings({ widthMm: 80, knockout: { ...DEFAULT_TRANSFER.knockout, enabled: false } });
    const r = renderTransfer(flat(WHITE, 160, 120, 0.78), s);
    expect(inkFraction(r.rgba)).toBeLessThan(0.83);
  });
});

describe('grain and anti-aliasing', () => {
  it('screens grainy tone into whole dots at the right coverage', () => {
    // Source alpha 0.3 with heavy per-pixel grain: the screen must reproduce
    // the average tone with clean dots, not a spray of fragments.
    const w = 160;
    const h = 120;
    const src = flat(WHITE, w, h);
    let seed = 5;
    for (let p = 0; p < w * h; p++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      src.data[p * 4 + 3] = 0.3 + ((seed / 4294967296) - 0.5) * 0.3;
    }
    const s = settings({ widthMm: 80, knockout: { ...DEFAULT_TRANSFER.knockout, enabled: false } });
    const r = renderTransfer(src, s);
    expect(Math.abs(inkFraction(r.rgba) - 0.3)).toBeLessThan(0.04);
    const minArea = (Math.PI / 4) * r.minDotPx * r.minDotPx;
    const mask = new Uint8Array(r.width * r.height);
    for (let p = 0; p < mask.length; p++) mask[p] = r.rgba[p * 4 + 3] !== 0 ? 1 : 0;
    const info = analyzeComponents(mask, r.width, r.height, 1, 8);
    for (let run = 0; run < info.runCount; run++) {
      const root = info.rootOfRun[run];
      if (root !== run || info.touchesBorder[root] === 1) continue;
      expect(info.area[root]).toBeGreaterThanOrEqual(minArea * 0.8);
    }
  });

  it('draws anti-aliased edges as a clean contour, not dots', () => {
    const w = 80;
    const h = 60;
    const src = flat(BLACK, w, h);
    for (let y = 19; y <= 40; y++) {
      for (let x = 24; x <= 55; x++) {
        // 1-pixel anti-aliased rim around a solid white block.
        const rim = y === 19 || y === 40 || x === 24 || x === 55;
        const v = rim ? 0.5 : 1;
        const i = (y * w + x) * 4;
        src.data[i] = v;
        src.data[i + 1] = v;
        src.data[i + 2] = v;
      }
    }
    const s = settings({ widthMm: 80 });
    const r = renderTransfer(src, s);
    const sx = r.width / 80;
    const sy = r.height / 60;
    for (let y = 0; y < r.height; y++) {
      for (let x = 0; x < r.width; x++) {
        const near =
          x >= 24 * sx - 3 && x < 56 * sx + 3 && y >= 19 * sy - 3 && y < 41 * sy + 3;
        if (!near && r.rgba[(y * r.width + x) * 4 + 3] !== 0) throw new Error(`dot outside the edge at ${x},${y}`);
      }
    }
    for (let y = Math.ceil(21 * sy); y < Math.floor(39 * sy); y++) {
      for (let x = Math.ceil(26 * sx); x < Math.floor(54 * sx); x++) {
        expect(r.rgba[(y * r.width + x) * 4 + 3]).toBe(255);
      }
    }
  });

  it('fills a pinhole with the colour of its own shape, never a distant one', () => {
    const w = 10;
    const h = 3;
    const before = new Uint8Array(w * h);
    const ink = new Uint8Array(w * h);
    const cmap = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        const red = x <= 2;
        const white = x >= 5;
        if (red || white) {
          before[p] = 1;
          ink[p] = 1;
          cmap.set(red ? [255, 0, 0] : [255, 255, 255], p * 3);
        }
      }
    }
    // A pinhole inside the white shape, and the red shape far to its left.
    const hole = 1 * w + 7;
    before[hole] = 0;
    cmap.set([0, 0, 0], hole * 3);
    fillHoleColors(ink, before, cmap, w, h);
    expect(Array.from(cmap.subarray(hole * 3, hole * 3 + 3))).toEqual([255, 255, 255]);
  });
});

describe('geometry', () => {
  it('sizes the file from millimetres and DPI', () => {
    expect(transferSize(settings({ widthMm: 254 }), 1).width).toBe(3000);
    expect(transferSize(settings({ widthMm: 254 }), 2).height).toBe(1500);
    expect(transferSize(settings({ widthMm: 9999 }), 1).width).toBe(
      Math.round(mmToPx(MAX_PRINT_MM, 300)),
    );
  });

  it('scales the preview while keeping the physical ruling', () => {
    const r = renderTransfer(flat(WHITE, 200, 100), settings({ widthMm: 280 }), { maxDimension: 800 });
    expect(Math.max(r.frameWidth, r.frameHeight)).toBeLessThanOrEqual(800);
    expect(r.cellPx).toBeCloseTo(r.dpi / DEFAULT_TRANSFER.screen.lpi, 6);
    expect(r.widthMm).toBe(280);
  });

  it('renders a crop identical to the same region of the full file', () => {
    const src = createBuffer(120, 90);
    for (let y = 0; y < 90; y++) {
      for (let x = 0; x < 120; x++) {
        const i = (y * 120 + x) * 4;
        src.data[i] = 0.5 + 0.5 * Math.sin(x / 9);
        src.data[i + 1] = 0.3 * (y / 90);
        src.data[i + 2] = 0.4;
        src.data[i + 3] = 1;
      }
    }
    const s = settings({ widthMm: 60 });
    const full = renderTransfer(src, s);
    const crop = { x: 200, y: 150, width: 180, height: 140 };
    const part = renderTransfer(src, s, { crop });
    expect(part.width).toBe(180);
    expect(part.height).toBe(140);
    let diff = 0;
    for (let y = 0; y < part.height; y++) {
      for (let x = 0; x < part.width; x++) {
        const a = ((y + crop.y) * full.width + (x + crop.x)) * 4;
        const b = (y * part.width + x) * 4;
        for (let c = 0; c < 4; c++) if (full.rgba[a + c] !== part.rgba[b + c]) diff++;
      }
    }
    expect(diff).toBe(0);
  });

  it('mirrors horizontally', () => {
    const rgba = new Uint8ClampedArray([1, 2, 3, 255, 9, 9, 9, 0]);
    expect(Array.from(mirrorRgba(rgba, 2, 1))).toEqual([9, 9, 9, 0, 1, 2, 3, 255]);
  });
});

describe('components', () => {
  it('removes specks, keeps real shapes, and treats diagonals as connected', () => {
    const w = 10;
    const m = new Uint8Array(w * w);
    m[0] = 1; // isolated speck in a corner
    for (let y = 4; y < 7; y++) for (let x = 4; x < 7; x++) m[y * w + x] = 1; // 3x3 block
    m[7 * w + 7] = 1; // diagonal neighbour of the block
    expect(removeSmallInk(m, w, w, 5)).toBe(1);
    expect(m[0]).toBe(0);
    expect(m[5 * w + 5]).toBe(1);
    expect(m[7 * w + 7]).toBe(1);
  });

  it('fills enclosed pinholes but never the open background', () => {
    const w = 7;
    const m = new Uint8Array(w * w);
    for (let y = 1; y < 6; y++) for (let x = 1; x < 6; x++) m[y * w + x] = 1;
    m[3 * w + 3] = 0; // pinhole
    expect(fillSmallHoles(m, w, w, 4)).toBe(1);
    expect(m[3 * w + 3]).toBe(1);
    expect(m[0]).toBe(0);
  });

  it('finds ink with no support underneath', () => {
    const w = 8;
    const ink = new Uint8Array(w * w);
    const sup = new Uint8Array(w * w);
    ink[1 * w + 1] = 1;
    for (let y = 4; y < 7; y++) for (let x = 4; x < 7; x++) ink[y * w + x] = 1;
    sup[5 * w + 5] = 1;
    const u = unsupportedInk(ink, sup, w, w);
    expect(u.count).toBe(1);
    expect(u.mask[1 * w + 1]).toBe(1);
    expect(u.mask[5 * w + 5]).toBe(0);
  });
});

describe('morphology', () => {
  it('computes exact squared Euclidean distances', () => {
    const w = 23;
    const h = 17;
    const m = new Uint8Array(w * h);
    let seed = 7;
    for (let i = 0; i < m.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      m[i] = seed % 11 === 0 ? 1 : 0;
    }
    const d = squaredDistance(m, w, h, 1, false);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let best = Infinity;
        for (let yy = 0; yy < h; yy++) {
          for (let xx = 0; xx < w; xx++) {
            if (m[yy * w + xx] === 1) best = Math.min(best, (x - xx) ** 2 + (y - yy) ** 2);
          }
        }
        if (best !== Infinity) expect(d[y * w + x]).toBe(best);
      }
    }
  });

  it('opens away thin lines but keeps thick ones, in every direction', () => {
    const w = 60;
    const m = new Uint8Array(w * w);
    const line = (dist: (x: number, y: number) => number, half: number): void => {
      for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) if (dist(x, y) <= half) m[y * w + x] = 1;
    };
    line((x) => Math.abs(x - 10), 1); // 3 px vertical
    line((x) => Math.abs(x - 40), 4); // 9 px vertical
    const opened = openDisk(m, w, w, 2);
    expect(opened[30 * w + 10]).toBe(0);
    expect(opened[30 * w + 40]).toBe(1);

    // A 45° band of the same true width as the thick line must survive too.
    const d = new Uint8Array(w * w);
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) if (Math.abs(x - y) / Math.SQRT2 <= 4) d[y * w + x] = 1;
    }
    const od = openDisk(d, w, w, 2);
    expect(od[30 * w + 30]).toBe(1);
  });

  it('erodes by the true radius', () => {
    const w = 21;
    const m = new Uint8Array(w * w);
    for (let y = 0; y < w; y++) for (let x = 7; x < 14; x++) m[y * w + x] = 1; // 7 px bar
    const e = erodeDisk(m, w, w, 2);
    const row = Array.from(e.subarray(10 * w, 11 * w)).join('');
    expect(row).toBe('000000000111000000000');
  });
});

describe('resampler', () => {
  it('is a partition of unity', () => {
    let s = 0;
    for (let k = -3; k <= 3; k++) s += mitchell(0.3 + k);
    expect(s).toBeCloseTo(1, 6);
  });

  it('preserves a constant image when scaling up and down', () => {
    for (const [dw, dh] of [[133, 71], [17, 9]]) {
      const sw = 40;
      const sh = 25;
      const src = new Float32Array(sw * sh * 4);
      for (let i = 0; i < src.length; i += 4) {
        src[i] = 0.2;
        src[i + 1] = 0.3;
        src[i + 2] = 0.1;
        src[i + 3] = 0.6;
      }
      const rs = new StreamResampler(src, sw, sh, dw, dh, { x0: 0, y0: 0, width: dw, height: dh });
      for (let y = 0; y < dh; y++) {
        const row = rs.row(y);
        for (let x = 0; x < dw; x++) {
          expect(row[x * 4]).toBeCloseTo(0.2, 5);
          expect(row[x * 4 + 3]).toBeCloseTo(0.6, 5);
        }
      }
    }
  });

  it('does not bleed the colour of transparent pixels', () => {
    // Premultiplied: a transparent neighbour contributes nothing but coverage.
    const sw = 4;
    const src = new Float32Array(sw * 4);
    src.set([1, 0, 0, 1, 1, 0, 0, 1], 0); // two opaque red pixels
    // two fully transparent pixels: premultiplied zeros, whatever their colour was
    const rs = new StreamResampler(src, sw, 1, 16, 1, { x0: 0, y0: 0, width: 16, height: 1 });
    const row = rs.row(0);
    for (let x = 0; x < 16; x++) {
      const a = row[x * 4 + 3];
      if (a > 0.05) {
        expect(row[x * 4 + 1] / a).toBeLessThan(1e-6);
        expect(row[x * 4] / a).toBeGreaterThan(0.99);
      }
    }
  });
});

describe('preflight', () => {
  it('rates the source resolution at print size', () => {
    const level = (px: number, widthMm: number) => {
      const s = settings({ widthMm });
      const r = renderTransfer(flat(WHITE, px, px), s, { maxDimension: 300 });
      return analyzeTransfer(r, s).checks.find((c) => c.id === 'resolution')?.level;
    };
    expect(level(800, 60)).toBe('ok'); // 339 DPI
    expect(level(800, 90)).toBe('info'); // 226 DPI
    // 73 DPI: enough for 30 LPI dots (needs 60), not for crisp text.
    expect(level(800, 280)).toBe('warn');
    expect(level(150, 280)).toBe('error'); // 14 DPI
  });

  it('flags dots that lose their white to a heavy choke', () => {
    const s = settings({ widthMm: 60, knockout: { ...DEFAULT_TRANSFER.knockout, enabled: false } });
    const r = renderTransfer(flat(WHITE, 120, 80, 0.15), s);
    expect(analyzeTransfer(r, s).stats.unsupportedCount).toBe(0);
    // Same file, but a print shop choking far harder than planned for.
    const heavy = analyzeTransfer(r, { ...s, chokeMm: 0.6 });
    expect(heavy.stats.unsupportedCount).toBeGreaterThan(10);
    expect(heavy.checks.find((c) => c.id === 'white')?.level).toBe('warn');
  });

  it('finds hairlines but not bold shapes', () => {
    const w = 200;
    const h = 120;
    const src = flat(BLACK, w, h);
    const paint = (x0: number, y0: number, x1: number, y1: number): void => {
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * 4;
          src.data[i] = 1;
          src.data[i + 1] = 1;
          src.data[i + 2] = 1;
        }
      }
    };
    paint(20, 10, 180, 11); // 1 source px -> ~0.2 mm hairline at this scale
    paint(40, 40, 160, 100); // a bold block with sharp corners
    const s = settings({ widthMm: 50 });
    const r = renderTransfer(src, s);
    const a = analyzeTransfer(r, s);
    expect(a.stats.thinCount).toBeGreaterThanOrEqual(1);
    // The block's corners alone must not count as hairlines.
    const blockOnly = flat(BLACK, w, h);
    for (let y = 40; y < 100; y++) {
      for (let x = 40; x < 160; x++) {
        const i = (y * w + x) * 4;
        blockOnly.data[i] = 1;
        blockOnly.data[i + 1] = 1;
        blockOnly.data[i + 2] = 1;
      }
    }
    const rb = renderTransfer(blockOnly, s);
    expect(analyzeTransfer(rb, s).stats.thinCount).toBe(0);
  });

  it('grades the screen ruling', () => {
    const r = renderTransfer(flat(WHITE, 40, 40), settings({ widthMm: 20 }));
    const level = (lpi: number) =>
      analyzeTransfer(r, settings({ screen: { ...DEFAULT_TRANSFER.screen, lpi } })).checks.find(
        (c) => c.id === 'lpi',
      )?.level;
    expect(level(35)).toBe('ok');
    expect(level(50)).toBe('warn');
    expect(level(60)).toBe('error');
  });

  it('checks the placement size against the published ranges', () => {
    const front = PLACEMENTS.find((p) => p.id === 'full-front');
    expect(front).toBeDefined();
    const r = renderTransfer(flat(WHITE, 40, 40), settings({ widthMm: 400 }), { maxDimension: 200 });
    const a = analyzeTransfer(r, settings({ widthMm: 400 }), { placement: front });
    expect(a.checks.find((c) => c.id === 'placement')?.level).toBe('info');
  });
});

describe('file formats', () => {
  function chunks(png: Uint8Array): { type: string; data: Uint8Array }[] {
    const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
    const out: { type: string; data: Uint8Array }[] = [];
    let o = 8;
    while (o + 8 <= png.length) {
      const len = v.getUint32(o, false);
      const type = String.fromCharCode(png[o + 4], png[o + 5], png[o + 6], png[o + 7]);
      out.push({ type, data: png.subarray(o + 8, o + 8 + len) });
      o += 12 + len;
    }
    return out;
  }

  it('writes print resolution and sRGB tagging into the PNG, before the pixels', async () => {
    const rgba = new Uint8ClampedArray(3 * 2 * 4).fill(200);
    const png = await encodePngRgba(rgba, 3, 2, { dpi: 300, srgb: true });
    const list = chunks(png);
    const names = list.map((c) => c.type);
    expect(names[0]).toBe('IHDR');
    expect(names.indexOf('pHYs')).toBeLessThan(names.indexOf('IDAT'));
    expect(names.indexOf('sRGB')).toBeLessThan(names.indexOf('IDAT'));
    const phys = list.find((c) => c.type === 'pHYs');
    expect(phys).toBeDefined();
    const pv = new DataView(phys!.data.buffer, phys!.data.byteOffset, 9);
    expect(pv.getUint32(0, false)).toBe(11811);
    expect(pv.getUint32(4, false)).toBe(11811);
    expect(phys!.data[8]).toBe(1);
    const gama = list.find((c) => c.type === 'gAMA');
    expect(new DataView(gama!.data.buffer, gama!.data.byteOffset, 4).getUint32(0, false)).toBe(45455);
  });

  it('round-trips transfer pixels, alpha included', async () => {
    const r = renderTransfer(flat({ r: 0.5, g: 0.1, b: 0.1 }, 40, 30), settings({ widthMm: 20 }));
    const png = await encodePngRgba(r.rgba, r.width, r.height, { dpi: 300, srgb: true });
    const idat = Buffer.concat(chunks(png).filter((c) => c.type === 'IDAT').map((c) => Buffer.from(c.data)));
    const raw = inflateSync(idat);
    const stride = r.width * 4 + 1;
    for (let y = 0; y < r.height; y++) {
      expect(raw[y * stride]).toBe(0);
      for (let i = 0; i < r.width * 4; i++) {
        if (raw[y * stride + 1 + i] !== r.rgba[y * r.width * 4 + i]) {
          throw new Error(`byte mismatch at row ${y}, ${i}`);
        }
      }
    }
  });

  it('writes a TIFF with real DPI and unassociated alpha', () => {
    const img = { width: 3, height: 2, data: new Uint8ClampedArray(24).map((_, i) => i * 10), colorSpace: 'srgb' } as unknown as ImageData;
    const tif = encodeTiff(img, { dpi: 300, alpha: true });
    const v = new DataView(tif.buffer);
    expect(v.getUint16(2, true)).toBe(42);
    const ifd = v.getUint32(4, true);
    const n = v.getUint16(ifd, true);
    const tags = new Map<number, { type: number; count: number; value: number }>();
    let last = -1;
    for (let i = 0; i < n; i++) {
      const o = ifd + 2 + i * 12;
      const tag = v.getUint16(o, true);
      expect(tag).toBeGreaterThan(last);
      last = tag;
      const type = v.getUint16(o + 2, true);
      const count = v.getUint32(o + 4, true);
      const value = type === 3 && count === 1 ? v.getUint16(o + 8, true) : v.getUint32(o + 8, true);
      tags.set(tag, { type, count, value });
    }
    expect(tags.get(0x0115)?.value).toBe(4);
    expect(tags.get(0x0152)?.value).toBe(2);
    expect(tags.get(0x0128)?.value).toBe(2);
    const xres = tags.get(0x011a)!.value;
    expect(v.getUint32(xres, true) / v.getUint32(xres + 4, true)).toBe(300);
    const strip = tags.get(0x0111)!.value;
    expect(Array.from(tif.subarray(strip, strip + 8))).toEqual([0, 10, 20, 30, 40, 50, 60, 70]);
  });
});
