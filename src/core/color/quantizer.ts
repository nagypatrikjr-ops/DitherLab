import type { ColorSpace, DistanceMetric, Palette } from '../types';
import {
  distCie76Lab,
  distCiede2000Lab,
  distRgb,
  distWeightedRgb,
  metricNeedsLab,
  paletteToLab,
} from './distance';
import { linearRgbToLab, srgbToLab, srgbToLinear } from './space';

const linearPaletteCache = new Map<string, Float32Array>();

/**
 * Palette colours are authored in sRGB. When the pipeline runs in linear light
 * the palette has to be linearised too, otherwise every nearest-colour search
 * compares a linear pixel against sRGB-encoded entries and the whole image
 * collapses onto whichever entry happens to sit lowest.
 */
export function paletteInSpace(palette: Palette, space: ColorSpace): Float32Array {
  if (space === 'srgb') return palette.colors;
  const key = `${palette.id}:${palette.colors.length}`;
  const hit = linearPaletteCache.get(key);
  if (hit) return hit;
  const out = new Float32Array(palette.colors.length);
  for (let i = 0; i < out.length; i++) out[i] = srgbToLinear(palette.colors[i]);
  if (linearPaletteCache.size > 24) {
    const first = linearPaletteCache.keys().next();
    if (!first.done) linearPaletteCache.delete(first.value);
  }
  linearPaletteCache.set(key, out);
  return out;
}

/**
 * Nearest-palette-colour lookup.
 *
 * Exhaustive search costs O(paletteSize) per pixel, which is fine for a 4
 * colour palette and ruinous for 256 colours combined with CIEDE2000. So the
 * quantiser lazily builds a 6-bit-per-channel lookup cube (262144 entries,
 * one byte each) whose cells hold the exactly-computed nearest index for the
 * cell centre. The cube is deterministic, which keeps golden tests stable.
 */
export class PaletteQuantizer {
  readonly size: number;
  private readonly rgb: Float32Array;
  private readonly lab: Float32Array | null;
  private readonly metric: DistanceMetric;
  private readonly space: ColorSpace;
  private lut: Uint8Array | Uint16Array | null = null;

  private static readonly BITS = 6;
  private static readonly LEVELS = 1 << PaletteQuantizer.BITS; // 64
  private static readonly MASK = PaletteQuantizer.LEVELS - 1;

  constructor(palette: Palette, metric: DistanceMetric, space: ColorSpace = 'srgb') {
    this.space = space;
    // Entries live in the same space as the pixels being matched...
    this.rgb = paletteInSpace(palette, space);
    this.size = palette.colors.length / 3;
    this.metric = metric;
    // ...while Lab is always derived from the authored sRGB values.
    this.lab = metricNeedsLab(metric) ? paletteToLab(palette.colors) : null;
  }

  /**
   * Exact nearest index; ignores the LUT.
   *
   * The query is clamped to [0,1] first. Error diffusion routinely overshoots
   * the gamut, and the weighted-RGB metric's (2 + rmean) coefficient collapses
   * to zero — or goes negative — for out-of-range reds, which silently destroys
   * the ranking and makes the whole image land on one arbitrary entry.
   */
  nearestExact(rIn: number, gIn: number, bIn: number): number {
    const r = rIn < 0 ? 0 : rIn > 1 ? 1 : rIn;
    const g = gIn < 0 ? 0 : gIn > 1 ? 1 : gIn;
    const b = bIn < 0 ? 0 : bIn > 1 ? 1 : bIn;
    const n = this.size;
    let best = 0;
    let bestD = Infinity;

    if (this.lab) {
      const cr = r;
      const cg = g;
      const cb = b;
      const [l, a, bb] =
        this.space === 'linear' ? linearRgbToLab(cr, cg, cb) : srgbToLab(cr, cg, cb);
      const pl = this.lab;
      const fn = this.metric === 'ciede2000' ? distCiede2000Lab : distCie76Lab;
      for (let i = 0; i < n; i++) {
        const d = fn(l, a, bb, pl[i * 3], pl[i * 3 + 1], pl[i * 3 + 2]);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      return best;
    }

    const p = this.rgb;
    const fn = this.metric === 'weightedRgb' ? distWeightedRgb : distRgb;
    for (let i = 0; i < n; i++) {
      const d = fn(r, g, b, p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  private buildLut(): Uint8Array | Uint16Array {
    const L = PaletteQuantizer.LEVELS;
    const total = L * L * L;
    const lut: Uint8Array | Uint16Array =
      this.size <= 256 ? new Uint8Array(total) : new Uint16Array(total);
    const inv = 1 / (L - 1);
    let i = 0;
    for (let ri = 0; ri < L; ri++) {
      const r = ri * inv;
      for (let gi = 0; gi < L; gi++) {
        const g = gi * inv;
        for (let bi = 0; bi < L; bi++) {
          lut[i++] = this.nearestExact(r, g, bi * inv);
        }
      }
    }
    return lut;
  }

  /**
   * Nearest index via the lookup cube. Values outside [0,1] are clamped, which
   * is exactly what we want for error-diffusion overshoot.
   */
  nearest(r: number, g: number, b: number): number {
    // Small palettes are faster to scan than to index through a cold cube.
    if (this.size <= 4) return this.nearestExact(r, g, b);
    if (this.lut === null) this.lut = this.buildLut();
    const L = PaletteQuantizer.LEVELS;
    const M = PaletteQuantizer.MASK;
    const ri = r <= 0 ? 0 : r >= 1 ? M : ((r * M + 0.5) | 0);
    const gi = g <= 0 ? 0 : g >= 1 ? M : ((g * M + 0.5) | 0);
    const bi = b <= 0 ? 0 : b >= 1 ? M : ((b * M + 0.5) | 0);
    return this.lut[(ri * L + gi) * L + bi];
  }

  colorAt(index: number, out: Float32Array, offset = 0): void {
    out[offset] = this.rgb[index * 3];
    out[offset + 1] = this.rgb[index * 3 + 1];
    out[offset + 2] = this.rgb[index * 3 + 2];
  }

  get colors(): Float32Array {
    return this.rgb;
  }
}

const cache = new Map<string, PaletteQuantizer>();

/** Quantisers are expensive to build; keep the last few around. */
export function getQuantizer(
  palette: Palette,
  metric: DistanceMetric,
  space: ColorSpace = 'srgb',
): PaletteQuantizer {
  const key = `${palette.id}:${palette.colors.length}:${metric}:${space}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const q = new PaletteQuantizer(palette, metric, space);
  if (cache.size > 8) {
    const first = cache.keys().next();
    if (!first.done) cache.delete(first.value);
  }
  cache.set(key, q);
  return q;
}

/** Uniform per-channel quantisation to `levels` steps (levels >= 2). */
export function quantizeChannel(v: number, levels: number): number {
  const n = Math.max(2, Math.round(levels)) - 1;
  const c = v <= 0 ? 0 : v >= 1 ? 1 : v;
  return Math.round(c * n) / n;
}
