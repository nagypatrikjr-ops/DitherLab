import type { RGB } from '../types';
import { clamp01, linearRgbToLab, srgbToLinear } from '../color/space';
import type { SpotOther, SpotSettings } from './types';

/**
 * Spot-colour filter: which ink colours the file is allowed to contain.
 *
 * Screen-print-style artwork is drawn with a couple of inks and shaded with
 * dots, but scans, JPEG artefacts and anti-aliasing scatter stray hues through
 * it — a red/white design picks up blue specks. Naming the inks turns that
 * into a decision the file can express: a colour near a chosen ink becomes
 * exactly that ink, and anything else is either left unprinted or replaced.
 *
 * The filter only ever rewrites the *colour* a pixel prints with, and may drop
 * a pixel entirely. Coverage — how much of each pixel is ink, i.e. the dots
 * that carry the shading — is decided before this and never touched, so
 * switching the filter on cannot restructure the halftone.
 *
 * Nearness is CIE76 ΔE*ab: the straight distance in CIE L*a*b*, where one unit
 * is roughly the smallest difference an eye can see. Two colours under ~2.3 are
 * indistinguishable; ~25 separates inks of the same family from different ones.
 */

/** Most inks the filter will carry. Beyond this, naming them stops helping. */
export const MAX_SPOT_COLORS = 8;

/**
 * Lookup cube resolution: the top 6 bits of each sRGB byte. A bucket is four
 * 8-bit steps wide, well under a ΔE of 1 anywhere in the cube, so quantising
 * can only shift a decision for colours already sitting on the tolerance edge.
 */
const Q_BITS = 6;
const Q = 1 << Q_BITS;
const Q_SHIFT = 8 - Q_BITS;
const Q_CENTRE = 1 << (Q_SHIFT - 1);

export interface SpotPalette {
  /** sRGB bytes of each ink, flat triples — exactly what gets written out. */
  readonly byte: Uint8Array;
  /** sRGB bytes of the replacement colour, used when `other` is 'color'. */
  readonly otherByte: Uint8Array;
  readonly count: number;
  readonly other: SpotOther;
  /**
   * Per quantised colour: the nearest ink's index when it is within the
   * tolerance, or `-1 - index` when it is not. See `spotLookup`.
   */
  readonly code: Int8Array;
}

function toByte(v: number): number {
  return Math.round(clamp01(v) * 255);
}

/** The linear value of a quantised channel, taken at the bucket's centre. */
function bucketLinear(q: number): number {
  return srgbToLinear((((q << Q_SHIFT) | Q_CENTRE) & 255) / 255);
}

function signature(spot: SpotSettings): string {
  const inks = spot.colors
    .slice(0, MAX_SPOT_COLORS)
    .map((c) => `${toByte(c.r)},${toByte(c.g)},${toByte(c.b)}`)
    .join(' ');
  const o = spot.otherColor;
  return `${spot.other}|${spot.tolerance}|${toByte(o.r)},${toByte(o.g)},${toByte(o.b)}|${inks}`;
}

let cachedKey: string | null = null;
let cachedPalette: SpotPalette | null = null;

/**
 * The lookup the renderer uses, or null when the filter changes nothing —
 * switched off, or switched on without a single ink named. (Filtering against
 * an empty ink list would erase the whole design, which is never what the
 * user meant by turning it on.)
 *
 * Building the cube costs a few milliseconds, so the last one is kept: the
 * preview re-renders on every slider move with the same inks.
 */
export function buildSpotPalette(spot: SpotSettings | undefined): SpotPalette | null {
  if (spot === undefined || !spot.enabled) return null;
  const colors = spot.colors.slice(0, MAX_SPOT_COLORS);
  if (colors.length === 0) return null;

  const key = signature(spot);
  if (key === cachedKey && cachedPalette !== null) return cachedPalette;

  const n = colors.length;
  const byte = new Uint8Array(n * 3);
  const lab = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = toByte(colors[i].r);
    const g = toByte(colors[i].g);
    const b = toByte(colors[i].b);
    byte[i * 3] = r;
    byte[i * 3 + 1] = g;
    byte[i * 3 + 2] = b;
    const [L, A, B] = linearRgbToLab(srgbToLinear(r / 255), srgbToLinear(g / 255), srgbToLinear(b / 255));
    lab[i * 3] = L;
    lab[i * 3 + 1] = A;
    lab[i * 3 + 2] = B;
  }

  // XYZ is linear in the channels, so each one's contribution is a table.
  const xr = new Float64Array(Q);
  const yr = new Float64Array(Q);
  const zr = new Float64Array(Q);
  const xg = new Float64Array(Q);
  const yg = new Float64Array(Q);
  const zg = new Float64Array(Q);
  const xb = new Float64Array(Q);
  const yb = new Float64Array(Q);
  const zb = new Float64Array(Q);
  for (let q = 0; q < Q; q++) {
    const v = bucketLinear(q);
    xr[q] = 0.4124564 * v;
    yr[q] = 0.2126729 * v;
    zr[q] = 0.0193339 * v;
    xg[q] = 0.3575761 * v;
    yg[q] = 0.7151522 * v;
    zg[q] = 0.119192 * v;
    xb[q] = 0.1804375 * v;
    yb[q] = 0.072175 * v;
    zb[q] = 0.9503041 * v;
  }

  const limit = Math.max(0, spot.tolerance);
  const limit2 = limit * limit;
  const code = new Int8Array(Q * Q * Q);
  for (let qr = 0; qr < Q; qr++) {
    for (let qg = 0; qg < Q; qg++) {
      const base = (qr << (2 * Q_BITS)) | (qg << Q_BITS);
      const x0 = xr[qr] + xg[qg];
      const y0 = yr[qr] + yg[qg];
      const z0 = zr[qr] + zg[qg];
      for (let qb = 0; qb < Q; qb++) {
        const [L, A, B] = labOf(x0 + xb[qb], y0 + yb[qb], z0 + zb[qb]);
        let best = 0;
        let bestD = Infinity;
        for (let i = 0; i < n; i++) {
          const dl = L - lab[i * 3];
          const da = A - lab[i * 3 + 1];
          const db = B - lab[i * 3 + 2];
          const d = dl * dl + da * da + db * db;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
        code[base | qb] = bestD <= limit2 ? best : -1 - best;
      }
    }
  }

  // A named ink must always be recognised as itself, however strict the
  // tolerance: its own bucket is settled by the ink, not by the bucket centre.
  for (let i = 0; i < n; i++) {
    const r = byte[i * 3] >> Q_SHIFT;
    const g = byte[i * 3 + 1] >> Q_SHIFT;
    const b = byte[i * 3 + 2] >> Q_SHIFT;
    code[(r << (2 * Q_BITS)) | (g << Q_BITS) | b] = i;
  }

  const o = spot.otherColor;
  const palette: SpotPalette = {
    byte,
    otherByte: Uint8Array.of(toByte(o.r), toByte(o.g), toByte(o.b)),
    count: n,
    other: spot.other,
    code,
  };
  cachedKey = key;
  cachedPalette = palette;
  return palette;
}

const XN = 0.95047;
const ZN = 1.08883;

function labF(t: number): number {
  return t > 0.008856451679035631 ? Math.cbrt(t) : 7.787037037037035 * t + 16 / 116;
}

function labOf(x: number, y: number, z: number): [number, number, number] {
  const fx = labF(x / XN);
  const fy = labF(y);
  const fz = labF(z / ZN);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/**
 * What to do with a printed colour: `code >= 0` is the ink it belongs to,
 * and a negative code means no ink is near enough, with `-1 - code` naming
 * the nearest one anyway (for the "closest chosen colour" replacement).
 */
export function spotLookup(pal: SpotPalette, r: number, g: number, b: number): number {
  return pal.code[((r >> Q_SHIFT) << (2 * Q_BITS)) | ((g >> Q_SHIFT) << Q_BITS) | (b >> Q_SHIFT)];
}

/** ΔE*ab between two sRGB colours given as 0..1 components. */
export function spotDistance(a: RGB, b: RGB): number {
  const [l1, a1, b1] = linearRgbToLab(
    srgbToLinear(clamp01(a.r)),
    srgbToLinear(clamp01(a.g)),
    srgbToLinear(clamp01(a.b)),
  );
  const [l2, a2, b2] = linearRgbToLab(
    srgbToLinear(clamp01(b.r)),
    srgbToLinear(clamp01(b.g)),
    srgbToLinear(clamp01(b.b)),
  );
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

export interface SpotCandidate {
  readonly color: RGB;
  /** Share of the printed pixels this colour covers, 0..1. */
  readonly share: number;
}

/**
 * The colours a finished transfer actually prints with, most-used first.
 *
 * Colours are tallied in a 32-level cube and each bucket keeps the true mean
 * of the pixels in it, so flat artwork gives its exact ink back rather than a
 * rounded version of it. Buckets closer than `minDeltaE` to an already-listed
 * colour are folded away, so the list is inks rather than the shades of one.
 */
export function dominantInks(rgba: Uint8ClampedArray | Uint8Array, count: number, minDeltaE = 12): SpotCandidate[] {
  const BITS = 5;
  const SIDE = 1 << BITS;
  const SHIFT = 8 - BITS;
  const sums = new Float64Array(SIDE * SIDE * SIDE * 3);
  const hits = new Float64Array(SIDE * SIDE * SIDE);
  let total = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue;
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    const k = ((r >> SHIFT) << (2 * BITS)) | ((g >> SHIFT) << BITS) | (b >> SHIFT);
    sums[k * 3] += r;
    sums[k * 3 + 1] += g;
    sums[k * 3 + 2] += b;
    hits[k]++;
    total++;
  }
  if (total === 0) return [];

  const order: number[] = [];
  for (let k = 0; k < hits.length; k++) if (hits[k] > 0) order.push(k);
  order.sort((a, b) => hits[b] - hits[a] || a - b);

  const picked: RGB[] = [];
  const pickedLab: [number, number, number][] = [];
  const weight: number[] = [];
  const want = Math.max(1, Math.min(MAX_SPOT_COLORS, count));
  const limit2 = minDeltaE * minDeltaE;
  for (const k of order) {
    const r = sums[k * 3] / hits[k] / 255;
    const g = sums[k * 3 + 1] / hits[k] / 255;
    const b = sums[k * 3 + 2] / hits[k] / 255;
    const [L, A, B] = linearRgbToLab(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b));
    let near = -1;
    for (let i = 0; i < pickedLab.length; i++) {
      const dl = L - pickedLab[i][0];
      const da = A - pickedLab[i][1];
      const db = B - pickedLab[i][2];
      if (dl * dl + da * da + db * db < limit2) {
        near = i;
        break;
      }
    }
    // A shade of a colour already listed counts towards that colour's share.
    if (near >= 0) weight[near] += hits[k];
    else if (picked.length < want) {
      picked.push({ r, g, b });
      pickedLab.push([L, A, B]);
      weight.push(hits[k]);
    }
  }
  return picked.map((color, i) => ({ color, share: weight[i] / total }));
}
