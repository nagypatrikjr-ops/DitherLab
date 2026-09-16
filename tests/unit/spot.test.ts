import { describe, expect, it } from 'vitest';
import { createBuffer } from '../../src/core/buffer';
import type { PixelBuffer, RGB } from '../../src/core/types';
import {
  DEFAULT_SPOT,
  DEFAULT_TRANSFER,
  buildSpotPalette,
  dominantInks,
  renderTransfer,
  spotDistance,
  spotLookup,
  type SpotSettings,
  type TransferSettings,
} from '../../src/core/transfer';

const RED: RGB = { r: 0.85, g: 0.1, b: 0.12 };
const BLUE: RGB = { r: 0.15, g: 0.25, b: 0.85 };
const WHITE: RGB = { r: 1, g: 1, b: 1 };

function spot(over: Partial<SpotSettings> = {}): SpotSettings {
  return { ...DEFAULT_SPOT, ...over };
}

function settings(over: Partial<TransferSettings> = {}): TransferSettings {
  return { ...DEFAULT_TRANSFER, ...over };
}

function byte(c: RGB): [number, number, number] {
  return [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)];
}

/** Look a colour up the way the renderer does, from sRGB 0..1 components. */
function lookup(pal: ReturnType<typeof buildSpotPalette>, c: RGB): number {
  if (pal === null) throw new Error('no palette');
  const [r, g, b] = byte(c);
  return spotLookup(pal, r, g, b);
}

describe('spot palette', () => {
  it('does nothing unless it is switched on with at least one ink', () => {
    expect(buildSpotPalette(undefined)).toBeNull();
    expect(buildSpotPalette(spot({ colors: [RED] }))).toBeNull();
    // Switched on but with nothing named: filtering against an empty list
    // would erase the design, so the filter stays out of the way.
    expect(buildSpotPalette(spot({ enabled: true }))).toBeNull();
    expect(buildSpotPalette(spot({ enabled: true, colors: [RED] }))).not.toBeNull();
  });

  it('claims colours near an ink and rejects the rest, naming the nearest anyway', () => {
    const pal = buildSpotPalette(spot({ enabled: true, colors: [RED, WHITE], tolerance: 25 }));
    expect(lookup(pal, RED)).toBe(0);
    expect(lookup(pal, WHITE)).toBe(1);
    // A slightly different red is the same ink; a blue is no ink at all.
    expect(lookup(pal, { r: 0.83, g: 0.13, b: 0.1 })).toBe(0);
    const blue = lookup(pal, BLUE);
    expect(blue).toBeLessThan(0);
    // Even when rejected, the code names the closest ink for "nearest" mode.
    // A washed-out orange is a distant red; this blue is nearer the white,
    // which is what the distance says and what the filter must therefore do.
    expect(-1 - lookup(pal, { r: 0.8, g: 0.45, b: 0.2 })).toBe(0);
    expect(spotDistance(BLUE, WHITE)).toBeLessThan(spotDistance(BLUE, RED));
    expect(-1 - blue).toBe(1);
  });

  it('follows the tolerance in both directions', () => {
    const near = { r: 0.7, g: 0.2, b: 0.2 };
    const de = spotDistance(RED, near);
    expect(de).toBeGreaterThan(5);
    expect(lookup(buildSpotPalette(spot({ enabled: true, colors: [RED], tolerance: de + 3 })), near)).toBe(0);
    expect(lookup(buildSpotPalette(spot({ enabled: true, colors: [RED], tolerance: de - 3 })), near)).toBe(-1);
    // At zero tolerance nothing is claimed but the ink itself — which is
    // still claimed, however strict the setting.
    const strict = buildSpotPalette(spot({ enabled: true, colors: [RED], tolerance: 0 }));
    expect(lookup(strict, RED)).toBe(0);
    expect(lookup(strict, near)).toBe(-1);
    expect(lookup(strict, { r: 0.84, g: 0.11, b: 0.12 })).toBe(-1);
  });

  it('measures distance as CIE76 ΔE*ab', () => {
    expect(spotDistance(RED, RED)).toBe(0);
    expect(spotDistance({ r: 0, g: 0, b: 0 }, WHITE)).toBeCloseTo(100, 3);
    // Out-of-range components are clamped rather than extrapolated.
    expect(spotDistance({ r: 2, g: 2, b: 2 }, WHITE)).toBe(0);
  });
});

describe('dominantInks', () => {
  function image(counts: [RGB, number][], transparent = 0): Uint8ClampedArray {
    const total = counts.reduce((n, [, c]) => n + c, 0) + transparent;
    const out = new Uint8ClampedArray(total * 4);
    let p = 0;
    for (const [c, n] of counts) {
      const [r, g, b] = byte(c);
      for (let i = 0; i < n; i++, p++) {
        out[p * 4] = r;
        out[p * 4 + 1] = g;
        out[p * 4 + 2] = b;
        out[p * 4 + 3] = 255;
      }
    }
    return out;
  }

  it('recovers flat colours exactly, ordered by how much they cover', () => {
    const found = dominantInks(image([[RED, 300], [WHITE, 100], [BLUE, 20]]), 4);
    expect(found.map((f) => byte(f.color))).toEqual([byte(RED), byte(WHITE), byte(BLUE)]);
    expect(found[0].share).toBeCloseTo(300 / 420, 6);
    expect(found[2].share).toBeCloseTo(20 / 420, 6);
  });

  it('ignores unprinted pixels and folds shades into the colour they belong to', () => {
    const shade: RGB = { r: 0.86, g: 0.12, b: 0.13 };
    expect(spotDistance(RED, shade)).toBeLessThan(12);
    const found = dominantInks(image([[RED, 200], [shade, 50], [WHITE, 100]], 1000), 4);
    expect(found).toHaveLength(2);
    expect(byte(found[0].color)).toEqual(byte(RED));
    // The shade's pixels count towards the red, and the 1000 transparent
    // pixels count towards nothing at all.
    expect(found[0].share).toBeCloseTo(250 / 350, 6);
    expect(found[1].share).toBeCloseTo(100 / 350, 6);
  });

  it('returns at most what was asked for, and nothing for an empty image', () => {
    expect(dominantInks(image([[RED, 10], [WHITE, 10], [BLUE, 10]]), 2)).toHaveLength(2);
    expect(dominantInks(new Uint8ClampedArray(40), 4)).toEqual([]);
  });
});

/** Red artwork with a scatter of blue specks, on a transparent background. */
function speckled(w: number, h: number): PixelBuffer {
  const b = createBuffer(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const speck = (x * 7 + y * 13) % 29 === 0;
      const c = speck ? BLUE : RED;
      b.data[p] = c.r;
      b.data[p + 1] = c.g;
      b.data[p + 2] = c.b;
      b.data[p + 3] = 1;
    }
  }
  return b;
}

function colorsIn(rgba: Uint8ClampedArray): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] !== 0) out.add(`${rgba[i]},${rgba[i + 1]},${rgba[i + 2]}`);
  }
  return out;
}

function alphaOf(rgba: Uint8ClampedArray): Uint8Array {
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4 + 3];
  return out;
}

/** The filter may take ink away; it must never put ink somewhere new. */
function inkOnlyRemoved(after: Uint8Array, before: Uint8Array): number {
  let gone = 0;
  for (let i = 0; i < after.length; i++) {
    expect(after[i] === before[i] || (after[i] === 0 && before[i] === 255)).toBe(true);
    if (after[i] !== before[i]) gone++;
  }
  return gone;
}

describe('the spot filter in a render', () => {
  const src = speckled(160, 160);
  const base = settings({ widthMm: 80 });
  const plain = renderTransfer(src, base);

  it('leaves the render untouched while it is off', () => {
    const off = renderTransfer(src, settings({ ...base, spot: spot({ colors: [RED], enabled: false }) }));
    expect(off.rgba).toEqual(plain.rgba);
    // The unfiltered print really does contain both colours.
    const found = dominantInks(plain.rgba, 4);
    expect(found.length).toBeGreaterThanOrEqual(2);
  });

  it('drops colours no ink claims, keeping every dot of the ones it does', () => {
    const out = renderTransfer(src, settings({ ...base, spot: spot({ enabled: true, colors: [RED], other: 'remove' }) }));
    for (const c of colorsIn(out.rgba)) expect(c).toBe(byte(RED).join(','));
    expect(inkOnlyRemoved(alphaOf(out.rgba), alphaOf(plain.rgba))).toBeGreaterThan(0);
  });

  it('repaints the rest without moving a single dot', () => {
    const inks = spot({ enabled: true, colors: [RED], other: 'color', otherColor: WHITE });
    const out = renderTransfer(src, settings({ ...base, spot: inks }));
    // Replacing a colour must not change which pixels carry ink.
    expect(alphaOf(out.rgba)).toEqual(alphaOf(plain.rgba));
    expect(colorsIn(out.rgba)).toEqual(new Set([byte(RED).join(','), byte(WHITE).join(',')]));

    const nearest = renderTransfer(src, settings({ ...base, spot: spot({ ...inks, other: 'nearest' }) }));
    expect(alphaOf(nearest.rgba)).toEqual(alphaOf(plain.rgba));
    // With one ink named, "nearest" can only ever be that ink.
    expect(colorsIn(nearest.rgba)).toEqual(new Set([byte(RED).join(',')]));
  });

  it('keeps the two named inks apart instead of merging them', () => {
    const out = renderTransfer(
      src,
      settings({ ...base, spot: spot({ enabled: true, colors: [RED, BLUE], other: 'remove' }) }),
    );
    // Naming both colours keeps both, and prints nothing besides them: the
    // blends along their edges land on one ink or the other.
    expect(colorsIn(out.rgba)).toEqual(new Set([byte(RED).join(','), byte(BLUE).join(',')]));
    inkOnlyRemoved(alphaOf(out.rgba), alphaOf(plain.rgba));
  });

  it('holds the edges together instead of cutting a gap along them', () => {
    // The default tolerance has to reach past the middle of a red-to-white
    // blend, or every anti-aliased edge loses its ink and prints as a seam.
    const mid: RGB = { r: (RED.r + WHITE.r) / 2, g: (RED.g + WHITE.g) / 2, b: (RED.b + WHITE.b) / 2 };
    const pal = buildSpotPalette(spot({ enabled: true, colors: [RED, WHITE] }));
    expect(pal).not.toBeNull();
    if (pal === null) return;
    const [r, g, b] = byte(mid);
    expect(spotLookup(pal, r, g, b)).toBeGreaterThanOrEqual(0);
    // A foreign hue is still foreign at that reach.
    expect(spotLookup(pal, ...byte(BLUE))).toBeLessThan(0);
  });
});
