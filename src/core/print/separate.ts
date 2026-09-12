import type { PixelBuffer, RGB } from '../types';
import { srgbToLinear } from '../color/space';
import type { Ink } from './types';

/**
 * Spot-colour separation.
 *
 * Model: at print scale a halftoned area reads as the garment colour with the
 * ink dots averaged on top. Ignoring overprint (separations on a dark garment
 * are knocked out from each other) that is
 *
 *     result = garment + Σ aᵢ · (inkᵢ − garment),    aᵢ ≥ 0,  Σ aᵢ ≤ 1
 *
 * so recovering the per-ink coverage aᵢ from a pixel is a small non-negative
 * least squares with a simplex constraint. Solving it in *linear* light is what
 * makes the midtones come out right — averaging dots is averaging light.
 *
 * Per-pixel iteration would be far too slow at film resolution, so the solution
 * is tabulated over a 6-bit RGB cube once and looked up afterwards.
 */

/**
 * Cube resolution. 5 bits is deliberately coarse: the solve is the expensive
 * part, and the lookup interpolates trilinearly afterwards, so the accuracy
 * that matters is recovered for free. Dropping from 6 to 5 bits alone is an
 * 8x saving on a step that used to take over a second.
 */
const BITS = 5;
const LEVELS = 1 << BITS; // 32
const MASK = LEVELS - 1;

export interface CoverageMaps {
  /** One 0..255 coverage map per enabled ink, in the order given. */
  maps: Uint8Array[];
  inkIds: string[];
  width: number;
  height: number;
}

function toLinear(c: RGB): [number, number, number] {
  return [srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b)];
}

/** Project a vector onto { a ≥ 0, Σa ≤ 1 }. */
function projectSimplex(a: Float64Array): void {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] < 0) a[i] = 0;
    sum += a[i];
  }
  if (sum <= 1) return;
  // Euclidean projection onto the probability simplex (Duchi et al.).
  const sorted = Array.from(a).sort((x, y) => y - x);
  let cum = 0;
  let rho = 0;
  let theta = 0;
  for (let i = 0; i < sorted.length; i++) {
    cum += sorted[i];
    const t = (cum - 1) / (i + 1);
    if (sorted[i] - t > 0) {
      rho = i + 1;
      theta = t;
    }
  }
  if (rho === 0) return;
  for (let i = 0; i < a.length; i++) a[i] = Math.max(0, a[i] - theta);
}

/**
 * Solve for the coverage vector of one target colour.
 * Projected gradient descent: cheap, robust, and converges in a few dozen
 * steps for the two-to-six ink problems this tool deals with.
 */
function solveCoverage(
  target: readonly [number, number, number],
  garment: readonly [number, number, number],
  cols: Float64Array, // 3 x n, column-major: ink_i - garment
  n: number,
  out: Float64Array,
  iterations = 40,
): void {
  const d0 = target[0] - garment[0];
  const d1 = target[1] - garment[1];
  const d2 = target[2] - garment[2];

  let norm = 0;
  for (let i = 0; i < n * 3; i++) norm += cols[i] * cols[i];
  const step = 1 / (norm + 1e-6);

  const grad = new Float64Array(n);
  for (let it = 0; it < iterations; it++) {
    // residual = C a - d
    let r0 = -d0;
    let r1 = -d1;
    let r2 = -d2;
    for (let i = 0; i < n; i++) {
      r0 += cols[i * 3] * out[i];
      r1 += cols[i * 3 + 1] * out[i];
      r2 += cols[i * 3 + 2] * out[i];
    }
    for (let i = 0; i < n; i++) {
      grad[i] = cols[i * 3] * r0 + cols[i * 3 + 1] * r1 + cols[i * 3 + 2] * r2;
      out[i] -= step * grad[i];
    }
    projectSimplex(out);
  }
}

const lutCache = new Map<string, Uint8Array>();

function lutKey(garment: RGB, inks: readonly Ink[]): string {
  const g = `${garment.r.toFixed(4)},${garment.g.toFixed(4)},${garment.b.toFixed(4)}`;
  const i = inks
    .map((k) => `${k.id}:${k.color.r.toFixed(4)},${k.color.g.toFixed(4)},${k.color.b.toFixed(4)}`)
    .join('|');
  return `${g}#${i}`;
}

/** Build (or reuse) the coverage lookup cube for a garment + ink set. */
export function buildCoverageLut(garment: RGB, inks: readonly Ink[]): Uint8Array {
  const key = lutKey(garment, inks);
  const hit = lutCache.get(key);
  if (hit) return hit;

  const n = inks.length;
  const g = toLinear(garment);
  const cols = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const c = toLinear(inks[i].color);
    cols[i * 3] = c[0] - g[0];
    cols[i * 3 + 1] = c[1] - g[1];
    cols[i * 3 + 2] = c[2] - g[2];
  }

  const lut = new Uint8Array(LEVELS * LEVELS * LEVELS * n);
  // Warm start: neighbouring cells have nearly the same answer, so carrying the
  // previous solution over turns most solves into a handful of refinements.
  const a = new Float64Array(n);
  const inv = 1 / (LEVELS - 1);
  let p = 0;
  for (let ri = 0; ri < LEVELS; ri++) {
    const lr = srgbToLinear(ri * inv);
    for (let gi = 0; gi < LEVELS; gi++) {
      const lg = srgbToLinear(gi * inv);
      a.fill(0);
      for (let bi = 0; bi < LEVELS; bi++) {
        solveCoverage([lr, lg, srgbToLinear(bi * inv)], g, cols, n, a);
        for (let i = 0; i < n; i++) lut[p++] = Math.round(Math.min(1, Math.max(0, a[i])) * 255);
      }
    }
  }

  if (lutCache.size > 4) {
    const first = lutCache.keys().next();
    if (!first.done) lutCache.delete(first.value);
  }
  lutCache.set(key, lut);
  return lut;
}

/** Split an image into one coverage map per ink. */
export function separate(src: PixelBuffer, garment: RGB, inks: readonly Ink[]): CoverageMaps {
  const active = inks.filter((i) => i.enabled);
  const n = active.length;
  const px = src.width * src.height;
  const maps: Uint8Array[] = Array.from({ length: n }, () => new Uint8Array(px));
  if (n === 0) {
    return { maps, inkIds: [], width: src.width, height: src.height };
  }

  const lut = buildCoverageLut(garment, active);
  const d = src.data;
  const acc = new Float32Array(n);

  for (let p = 0; p < px; p++) {
    const i = p * 4;
    // Trilinear lookup: the cube is coarse, so interpolating between cells is
    // what keeps a smooth glow from banding into visible coverage steps.
    const fr = (d[i] <= 0 ? 0 : d[i] >= 1 ? 1 : d[i]) * MASK;
    const fg = (d[i + 1] <= 0 ? 0 : d[i + 1] >= 1 ? 1 : d[i + 1]) * MASK;
    const fb = (d[i + 2] <= 0 ? 0 : d[i + 2] >= 1 ? 1 : d[i + 2]) * MASK;
    const r0 = fr | 0;
    const g0 = fg | 0;
    const b0 = fb | 0;
    const r1 = r0 < MASK ? r0 + 1 : MASK;
    const g1 = g0 < MASK ? g0 + 1 : MASK;
    const b1 = b0 < MASK ? b0 + 1 : MASK;
    const tr = fr - r0;
    const tg = fg - g0;
    const tb = fb - b0;

    const w000 = (1 - tr) * (1 - tg) * (1 - tb);
    const w001 = (1 - tr) * (1 - tg) * tb;
    const w010 = (1 - tr) * tg * (1 - tb);
    const w011 = (1 - tr) * tg * tb;
    const w100 = tr * (1 - tg) * (1 - tb);
    const w101 = tr * (1 - tg) * tb;
    const w110 = tr * tg * (1 - tb);
    const w111 = tr * tg * tb;

    const o000 = ((r0 * LEVELS + g0) * LEVELS + b0) * n;
    const o001 = ((r0 * LEVELS + g0) * LEVELS + b1) * n;
    const o010 = ((r0 * LEVELS + g1) * LEVELS + b0) * n;
    const o011 = ((r0 * LEVELS + g1) * LEVELS + b1) * n;
    const o100 = ((r1 * LEVELS + g0) * LEVELS + b0) * n;
    const o101 = ((r1 * LEVELS + g0) * LEVELS + b1) * n;
    const o110 = ((r1 * LEVELS + g1) * LEVELS + b0) * n;
    const o111 = ((r1 * LEVELS + g1) * LEVELS + b1) * n;

    for (let k = 0; k < n; k++) {
      acc[k] =
        lut[o000 + k] * w000 + lut[o001 + k] * w001 +
        lut[o010 + k] * w010 + lut[o011 + k] * w011 +
        lut[o100 + k] * w100 + lut[o101 + k] * w101 +
        lut[o110 + k] * w110 + lut[o111 + k] * w111;
      maps[k][p] = acc[k] + 0.5;
    }
  }

  return {
    maps,
    inkIds: active.map((i) => i.id),
    width: src.width,
    height: src.height,
  };
}

/** Bilinear resize of a single-channel coverage map. */
export function resizeCoverage(
  map: Uint8Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Uint8Array {
  if (sw === dw && sh === dh) return map;
  const out = new Uint8Array(dw * dh);
  const xs = sw / dw;
  const ys = sh / dh;
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) * ys - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) * xs - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const tx = fx - x0;
      const a = map[y0 * sw + x0];
      const b = map[y0 * sw + x1];
      const c = map[y1 * sw + x0];
      const e = map[y1 * sw + x1];
      const top = a + (b - a) * tx;
      const bot = c + (e - c) * tx;
      out[y * dw + x] = Math.round(top + (bot - top) * ty);
    }
  }
  return out;
}

/**
 * Suggest an ink set by clustering the image's colours, with the darkest
 * cluster treated as the garment. For a poster that is already two or three
 * flat colours this recovers exactly those colours.
 */
export function suggestInks(
  src: PixelBuffer,
  count: number,
): { garment: RGB; inks: RGB[] } {
  const px = src.width * src.height;
  const stride = Math.max(1, Math.floor(px / 40000));
  const samples: number[] = [];
  for (let p = 0; p < px; p += stride) {
    const i = p * 4;
    samples.push(src.data[i], src.data[i + 1], src.data[i + 2]);
  }
  const n = samples.length / 3;
  const k = Math.max(2, Math.min(8, count));

  // k-means++ seeding on the sampled colours.
  const centers = new Float64Array(k * 3);
  centers[0] = samples[0];
  centers[1] = samples[1];
  centers[2] = samples[2];
  const d2 = new Float64Array(n).fill(Infinity);
  for (let c = 1; c < k; c++) {
    let best = 0;
    let bestD = -1;
    for (let i = 0; i < n; i++) {
      const dr = samples[i * 3] - centers[(c - 1) * 3];
      const dg = samples[i * 3 + 1] - centers[(c - 1) * 3 + 1];
      const db = samples[i * 3 + 2] - centers[(c - 1) * 3 + 2];
      const d = dr * dr + dg * dg + db * db;
      if (d < d2[i]) d2[i] = d;
      if (d2[i] > bestD) {
        bestD = d2[i];
        best = i;
      }
    }
    centers[c * 3] = samples[best * 3];
    centers[c * 3 + 1] = samples[best * 3 + 1];
    centers[c * 3 + 2] = samples[best * 3 + 2];
  }

  const sums = new Float64Array(k * 3);
  const counts = new Uint32Array(k);
  for (let iter = 0; iter < 30; iter++) {
    sums.fill(0);
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const dr = samples[i * 3] - centers[c * 3];
        const dg = samples[i * 3 + 1] - centers[c * 3 + 1];
        const db = samples[i * 3 + 2] - centers[c * 3 + 2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      sums[best * 3] += samples[i * 3];
      sums[best * 3 + 1] += samples[i * 3 + 1];
      sums[best * 3 + 2] += samples[i * 3 + 2];
      counts[best]++;
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) continue;
      centers[c * 3] = sums[c * 3] / counts[c];
      centers[c * 3 + 1] = sums[c * 3 + 1] / counts[c];
      centers[c * 3 + 2] = sums[c * 3 + 2] / counts[c];
    }
  }

  const list: RGB[] = [];
  for (let c = 0; c < k; c++) {
    list.push({ r: centers[c * 3], g: centers[c * 3 + 1], b: centers[c * 3 + 2] });
  }
  const luma = (c: RGB): number => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
  list.sort((a, b) => luma(a) - luma(b));
  const [garment, ...inks] = list;
  return { garment, inks };
}
