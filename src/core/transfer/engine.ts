import type { PixelBuffer } from '../types';
import { createBuffer } from '../buffer';
import { linearToSrgb, lumaSrgb, srgbToLinear } from '../color/space';
import { gaussianBlur } from '../effects/blur';
import { blueNoise } from '../dither/ordered/matrices';
import { dotThreshold, type DotShape } from '../dither/halftone/shapes';
import { hashNoise2D } from '../rng';
import { StreamResampler } from './resample';
import { analyzeComponents, fillSmallHoles, removeSmallInk } from './components';
import { erodeDisk } from './morph';
import {
  ALPHA_FLOOR,
  MAX_PRINT_MM,
  SOLID_ALPHA,
  effectiveMinDotMm,
  mmToPx,
  transferSize,
  type TransferSettings,
} from './types';

// ---------------------------------------------------------------------------
// Encoding tables. Math.pow per output pixel is the single largest cost at
// print resolution, so linear -> sRGB goes through a 16k-entry table (error
// well under one 8-bit step everywhere).
// ---------------------------------------------------------------------------

const ENC_SIZE = 16384;
const ENC_BYTE = new Uint8Array(ENC_SIZE + 1);
const ENC_FLOAT = new Float32Array(ENC_SIZE + 1);
for (let i = 0; i <= ENC_SIZE; i++) {
  const v = linearToSrgb(i / ENC_SIZE);
  ENC_FLOAT[i] = v;
  ENC_BYTE[i] = Math.round(Math.min(1, Math.max(0, v)) * 255);
}

function encodeByte(v: number): number {
  return ENC_BYTE[v <= 0 ? 0 : v >= 1 ? ENC_SIZE : (v * ENC_SIZE + 0.5) | 0];
}

function perceptual(v: number): number {
  return ENC_FLOAT[v <= 0 ? 0 : v >= 1 ? ENC_SIZE : (v * ENC_SIZE + 0.5) | 0];
}

function smoothstep(e0: number, e1: number, x: number): number {
  if (e1 <= e0) return x >= e1 ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Source preparation (source resolution)
// ---------------------------------------------------------------------------

/**
 * Photo adjustments at source resolution, then conversion to premultiplied
 * linear RGBA ready for resampling.
 *
 * Sharpening works on the luminance of the art *as it will sit on the
 * garment*, so a transparent cut-out gets its real edge sharpened instead of
 * a halo against whatever colour happened to be stored under zero alpha.
 */
export function prepareSource(src: PixelBuffer, s: TransferSettings): Float32Array {
  const w = src.width;
  const h = src.height;
  const n = w * h;
  const d = src.data;
  const { contrast, saturation, sharpen } = s.adjust;
  const straight = new Float32Array(n * 3);

  for (let p = 0; p < n; p++) {
    let r = d[p * 4];
    let g = d[p * 4 + 1];
    let b = d[p * 4 + 2];
    if (contrast !== 0) {
      const k = 1 + contrast;
      r = (r - 0.5) * k + 0.5;
      g = (g - 0.5) * k + 0.5;
      b = (b - 0.5) * k + 0.5;
    }
    if (saturation !== 0) {
      const l = lumaSrgb(r, g, b);
      const k = 1 + saturation;
      r = l + (r - l) * k;
      g = l + (g - l) * k;
      b = l + (b - l) * k;
    }
    straight[p * 3] = r < 0 ? 0 : r > 1 ? 1 : r;
    straight[p * 3 + 1] = g < 0 ? 0 : g > 1 ? 1 : g;
    straight[p * 3 + 2] = b < 0 ? 0 : b > 1 ? 1 : b;
  }

  if (sharpen > 0) {
    const gl = lumaSrgb(s.garment.r, s.garment.g, s.garment.b);
    const lum = createBuffer(w, h);
    for (let p = 0; p < n; p++) {
      const a = Math.min(1, Math.max(0, d[p * 4 + 3]));
      const l = lumaSrgb(straight[p * 3], straight[p * 3 + 1], straight[p * 3 + 2]);
      const v = a * l + (1 - a) * gl;
      lum.data[p * 4] = v;
      lum.data[p * 4 + 1] = v;
      lum.data[p * 4 + 2] = v;
      lum.data[p * 4 + 3] = 1;
    }
    const blurred = gaussianBlur(lum, 3); // sigma = 1 source pixel
    for (let p = 0; p < n; p++) {
      if (d[p * 4 + 3] <= 0) continue;
      const detail = (lum.data[p * 4] - blurred.data[p * 4]) * sharpen;
      for (let c = 0; c < 3; c++) {
        const v = straight[p * 3 + c] + detail;
        straight[p * 3 + c] = v < 0 ? 0 : v > 1 ? 1 : v;
      }
    }
  }

  const out = new Float32Array(n * 4);
  for (let p = 0; p < n; p++) {
    const a = Math.min(1, Math.max(0, d[p * 4 + 3]));
    out[p * 4] = srgbToLinear(straight[p * 3]) * a;
    out[p * 4 + 1] = srgbToLinear(straight[p * 3 + 1]) * a;
    out[p * 4 + 2] = srgbToLinear(straight[p * 3 + 2]) * a;
    out[p * 4 + 3] = a;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Knockout: the colour-to-alpha model shared by every stage
// ---------------------------------------------------------------------------

/** Scratch output of `knock`: [alpha, Cr, Cg, Cb, Pr, Pg, Pb] (linear). */
const KO = new Float64Array(7);

export type InkDirection = 'lighten' | 'darken' | 'both';

/**
 * Which way ink can usefully move a colour away from this garment.
 *
 * On a dark shirt ink only ever makes things lighter: a colour darker than the
 * shirt is best reproduced by the bare shirt, and printing it anyway puts dark
 * ink on white underbase — the chalky grey patch this whole tool exists to
 * avoid. Measured naively, colour-to-alpha does the opposite: it divides by
 * the shirt's tiny linear value and asks for near-solid coverage for a black
 * that is imperceptibly deeper than the fabric. On a light shirt the reverse
 * holds; a mid-tone shirt can go both ways.
 */
export function inkDirection(T: readonly number[]): InkDirection {
  const l = linearToSrgb(0.2126 * T[0] + 0.7152 * T[1] + 0.0722 * T[2]);
  return l < 0.35 ? 'lighten' : l > 0.65 ? 'darken' : 'both';
}

const directionMemo = new WeakMap<readonly number[], InkDirection>();
function directionFor(T: readonly number[]): InkDirection {
  let d = directionMemo.get(T);
  if (d === undefined) {
    d = inkDirection(T);
    directionMemo.set(T, d);
  }
  return d;
}

/**
 * Least ink coverage with which some in-gamut ink reproduces the linear colour
 * (r, g, b) over the garment T — "colour to alpha". 0 means the colour *is* the
 * shirt; 1 means it needs solid ink.
 */
export function coverageNeed(
  r: number,
  g: number,
  b: number,
  T: readonly number[],
  dir: InkDirection = 'both',
): number {
  let a0 = 0;
  for (let c = 0; c < 3; c++) {
    let p = c === 0 ? r : c === 1 ? g : b;
    const t = T[c];
    if (dir === 'lighten' && p < t) p = t;
    else if (dir === 'darken' && p > t) p = t;
    let need = 0;
    if (p > t) need = t < 1 ? (p - t) / (1 - t) : 0;
    else if (p < t) need = t > 0 ? (t - p) / t : 0;
    if (need > a0) a0 = need;
  }
  return a0 > 1 ? 1 : a0;
}

/** Perceptual (sRGB-encoded) value of a linear quantity, via the shared table. */
export function toPerceptual(v: number): number {
  return perceptual(v);
}

/**
 * The knockout model for callers outside the render loop — the auto-tuner and
 * the checks use this so they judge exactly what the renderer will print.
 * Writes [alpha, Cr, Cg, Cb, Pr, Pg, Pb] (linear, C unclamped) into `out`.
 */
export function knockoutPixel(
  pr: number,
  pg: number,
  pb: number,
  as: number,
  T: readonly number[],
  s: TransferSettings,
  out: Float64Array,
): void {
  const invDensity = 1 / Math.min(4, Math.max(0.25, s.knockout.density));
  knock(pr, pg, pb, as, T, s, invDensity);
  for (let i = 0; i < 7; i++) out[i] = KO[i];
}

/**
 * Coverage and ink colour for one pixel.
 *
 * The pixel is composited over the garment in linear light, then
 * un-composited: a0 is the least coverage with which some in-gamut ink colour
 * C reproduces it over the shirt. The knockout ramp then decides how much of
 * that is spent as dots and how much as solid ink.
 */
function knock(
  pr: number,
  pg: number,
  pb: number,
  as: number,
  T: readonly number[],
  s: TransferSettings,
  invDensity: number,
): void {
  const ko = s.knockout;
  if (!ko.enabled) {
    const inv = as > 1e-6 ? 1 / as : 0;
    KO[0] = as;
    KO[1] = pr * inv;
    KO[2] = pg * inv;
    KO[3] = pb * inv;
    KO[4] = pr;
    KO[5] = pg;
    KO[6] = pb;
    return;
  }
  let cr = pr + (1 - as) * T[0];
  let cg = pg + (1 - as) * T[1];
  let cb = pb + (1 - as) * T[2];
  // Only the direction ink can actually take the shirt counts.
  const dir = directionFor(T);
  if (dir === 'lighten') {
    if (cr < T[0]) cr = T[0];
    if (cg < T[1]) cg = T[1];
    if (cb < T[2]) cb = T[2];
  } else if (dir === 'darken') {
    if (cr > T[0]) cr = T[0];
    if (cg > T[1]) cg = T[1];
    if (cb > T[2]) cb = T[2];
  }
  KO[4] = cr;
  KO[5] = cg;
  KO[6] = cb;

  const a0 = coverageNeed(cr, cg, cb, T);

  let alpha: number;
  const dist = perceptual(a0);
  if (dist <= ko.tolerance) {
    alpha = 0;
  } else {
    const ramp = smoothstep(ko.tolerance, ko.solidPoint, dist);
    alpha = ramp > a0 ? ramp : a0;
    if (alpha < 1 && invDensity !== 1) alpha = Math.pow(alpha, invDensity);
  }
  KO[0] = alpha;
  if (alpha > 0) {
    const inv = 1 / alpha;
    KO[1] = T[0] + (cr - T[0]) * inv;
    KO[2] = T[1] + (cg - T[1]) * inv;
    KO[3] = T[2] + (cb - T[2]) * inv;
  } else {
    KO[1] = cr;
    KO[2] = cg;
    KO[3] = cb;
  }
}

/**
 * Coverage at source resolution, appended as a fifth resampled channel, and a
 * summed-area table of *soft* pixels — genuine tone that must be screened.
 *
 * Output pixels whose filter footprint sees no soft source pixel sit on an
 * edge: they are drawn as a crisp contour at the geometric 50% line of the
 * fifth channel. Without this, enlarging a 1000-pixel poster to 30 cm would
 * turn every sharp edge — text above all — into a fringe of dots.
 *
 * An intermediate pixel with both solid and knocked-out pixels within two
 * pixels is anti-aliasing (or a transition too narrow to be a tone): it
 * belongs to the edge, not to a gradient.
 */
function coveragePrepass(
  prepared: Float32Array,
  sw: number,
  sh: number,
  T: readonly number[],
  s: TransferSettings,
  invDensity: number,
): { five: Float32Array; sat: Int32Array } {
  const n = sw * sh;
  const five = new Float32Array(n * 5);
  const cls = new Uint8Array(n); // 0 knocked out, 1 intermediate, 2 solid
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    knock(prepared[i], prepared[i + 1], prepared[i + 2], prepared[i + 3], T, s, invDensity);
    const cov = KO[0];
    five[p * 5] = prepared[i];
    five[p * 5 + 1] = prepared[i + 1];
    five[p * 5 + 2] = prepared[i + 2];
    five[p * 5 + 3] = prepared[i + 3];
    five[p * 5 + 4] = cov;
    cls[p] = cov <= ALPHA_FLOOR ? 0 : cov >= SOLID_ALPHA ? 2 : 1;
  }

  const W1 = sw + 1;
  const table = (pick: number): Int32Array => {
    const t = new Int32Array(W1 * (sh + 1));
    for (let y = 0; y < sh; y++) {
      let row = 0;
      for (let x = 0; x < sw; x++) {
        row += cls[y * sw + x] === pick ? 1 : 0;
        t[(y + 1) * W1 + (x + 1)] = t[y * W1 + (x + 1)] + row;
      }
    }
    return t;
  };
  const sat0 = table(0);
  const sat2 = table(2);
  const count = (t: Int32Array, x: number, y: number, r: number): number => {
    const x0 = Math.max(0, x - r);
    const y0 = Math.max(0, y - r);
    const x1 = Math.min(sw - 1, x + r);
    const y1 = Math.min(sh - 1, y + r);
    return t[(y1 + 1) * W1 + (x1 + 1)] - t[y0 * W1 + (x1 + 1)] - t[(y1 + 1) * W1 + x0] + t[y0 * W1 + x0];
  };

  const sat = new Int32Array(W1 * (sh + 1));
  for (let y = 0; y < sh; y++) {
    let row = 0;
    for (let x = 0; x < sw; x++) {
      const p = y * sw + x;
      const soft = cls[p] === 1 && !(count(sat0, x, y, 2) > 0 && count(sat2, x, y, 2) > 0);
      row += soft ? 1 : 0;
      sat[(y + 1) * W1 + (x + 1)] = sat[y * W1 + (x + 1)] + row;
    }
  }
  return { five, sat };
}

/** Separable box blur on bytes, edges clamped. Radius in pixels. */
function boxBlurBytes(src: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  if (radius < 1) return src;
  const size = 2 * radius + 1;
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const base = y * w;
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += src[base + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[base + x] = Math.round(sum / size);
      sum += src[base + Math.min(w - 1, x + radius + 1)] - src[base + Math.max(0, x - radius)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = Math.round(sum / size);
      sum += tmp[Math.min(h - 1, y + radius + 1) * w + x] - tmp[Math.max(0, y - radius) * w + x];
    }
  }
  return out;
}

/**
 * Give every newly filled pinhole pixel the colour of an adjacent pixel that
 * was already ink, growing inward from the hole's rim. Taking "the last ink
 * pixel in the row" instead can reach across a gap into a different colour.
 */
export function fillHoleColors(
  ink: Uint8Array,
  before: Uint8Array,
  cmap: Uint8Array,
  w: number,
  h: number,
): void {
  const pending: number[] = [];
  for (let p = 0; p < ink.length; p++) if (ink[p] === 1 && before[p] === 0) pending.push(p);
  if (pending.length === 0) return;
  const has = before.slice();
  for (let pass = 0; pass < 64 && pending.length > 0; pass++) {
    const next: number[] = [];
    const found: [number, number][] = [];
    for (const p of pending) {
      const x = p % w;
      const y = (p - x) / w;
      let src = -1;
      if (x > 0 && has[p - 1] === 1) src = p - 1;
      else if (x < w - 1 && has[p + 1] === 1) src = p + 1;
      else if (y > 0 && has[p - w] === 1) src = p - w;
      else if (y < h - 1 && has[p + w] === 1) src = p + w;
      if (src >= 0) found.push([p, src]);
      else next.push(p);
    }
    if (found.length === 0) break;
    for (const [p, src] of found) {
      cmap[p * 3] = cmap[src * 3];
      cmap[p * 3 + 1] = cmap[src * 3 + 1];
      cmap[p * 3 + 2] = cmap[src * 3 + 2];
      has[p] = 1;
    }
    pending.length = 0;
    pending.push(...next);
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export interface TransferOptions {
  /** Cap the long edge of the frame — the interactive preview. */
  maxDimension?: number;
  /** Render only this region of the full-resolution frame, for 1:1 inspection. */
  crop?: { x: number; y: number; width: number; height: number };
  /** Reuse a `prepareSource` result for the same source and adjustments. */
  prepared?: Float32Array;
  /**
   * Width of the original image when `src` is a reduced copy. The resolution
   * check must judge the file the user actually has, not the working copy.
   */
  originalWidth?: number;
}

export interface TransferRender {
  /** Size of the produced region. */
  width: number;
  height: number;
  /** Origin of the region within the frame. */
  x0: number;
  y0: number;
  /** The whole frame at this render's resolution. */
  frameWidth: number;
  frameHeight: number;
  /** Effective resolution of the frame (lower than the target for previews). */
  dpi: number;
  widthMm: number;
  heightMm: number;
  /** Straight RGBA, alpha strictly 0 or 255. */
  rgba: Uint8ClampedArray<ArrayBuffer>;
  /** 1 where the art is solid (not screened) — used for thin-feature checks. */
  solid: Uint8Array;
  /** Resolution of the source image at the physical print size. */
  sourceDpi: number;
  cellPx: number;
  minDotPx: number;
  removedSpecks: number;
  filledHoles: number;
}

const SHAPE_OPTS = { rings: 3, waveAmplitude: 0, waveFrequency: 1 };

/**
 * Print-ready transfer from an image.
 *
 * Per output pixel:
 *   1. resample the premultiplied linear source (Mitchell, streaming);
 *   2. composite over the garment, then un-composite ("colour to alpha"):
 *      the smallest ink coverage a0 that reproduces the pixel over the shirt,
 *      and the ink colour C that goes with it;
 *   3. map a0 through the knockout ramp: below the tolerance nothing prints,
 *      above the solid point the pixel prints solid in its own colour, and in
 *      between the coverage is reproduced with dots of colour C;
 *   4. screen the coverage into dots — AM with a hybrid highlight (below the
 *      smallest printable dot, dots keep their minimum size and get sparser
 *      instead of shrinking into specks) or FM with minimum-size cells;
 *   5. remove any speck or pinhole still below the printable minimum.
 */
export function renderTransfer(
  src: PixelBuffer,
  s: TransferSettings,
  opts: TransferOptions = {},
): TransferRender {
  const aspect = src.width / src.height;
  const widthMm = Math.min(MAX_PRINT_MM, Math.max(5, s.widthMm));
  const full = transferSize({ ...s, widthMm }, aspect);

  let frameW = full.width;
  let frameH = full.height;
  if (opts.crop === undefined && opts.maxDimension !== undefined) {
    const longest = Math.max(frameW, frameH);
    if (longest > opts.maxDimension) {
      const k = opts.maxDimension / longest;
      frameW = Math.max(1, Math.round(frameW * k));
      frameH = Math.max(1, Math.round(frameH * k));
    }
  }
  // Physical rulings follow the pixel count, so the preview shows the real pitch.
  const dpi = (s.dpi * frameW) / full.width;

  const cellPx = Math.max(2, dpi / Math.max(1, s.screen.lpi));
  const minDotPx = Math.max(1, mmToPx(effectiveMinDotMm(s), dpi));
  const minDotArea = (Math.PI / 4) * minDotPx * minDotPx;
  // Area fraction of the smallest dot within one halftone cell. Beyond half a
  // cell the ruling is too fine for the minimum dot; the checks report that.
  const aMin = Math.min(0.5, minDotArea / (cellPx * cellPx));
  const fmCell = Math.max(1, minDotPx);

  // Region to compute: the crop plus enough margin that cells straddling the
  // crop edge can sample their centres and cleanup sees whole components.
  let rx0 = 0;
  let ry0 = 0;
  let rw = frameW;
  let rh = frameH;
  let wx0 = 0;
  let wy0 = 0;
  let ww = frameW;
  let wh = frameH;
  if (opts.crop) {
    rx0 = Math.max(0, Math.min(frameW - 1, Math.floor(opts.crop.x)));
    ry0 = Math.max(0, Math.min(frameH - 1, Math.floor(opts.crop.y)));
    rw = Math.max(1, Math.min(frameW - rx0, Math.floor(opts.crop.width)));
    rh = Math.max(1, Math.min(frameH - ry0, Math.floor(opts.crop.height)));
    const margin = Math.ceil(Math.max(cellPx, fmCell) * 1.5) + 4;
    wx0 = Math.max(0, rx0 - margin);
    wy0 = Math.max(0, ry0 - margin);
    ww = Math.min(frameW, rx0 + rw + margin) - wx0;
    wh = Math.min(frameH, ry0 + rh + margin) - wy0;
  }

  const T = [
    srgbToLinear(s.garment.r),
    srgbToLinear(s.garment.g),
    srgbToLinear(s.garment.b),
  ];
  const invDensity = 1 / Math.min(4, Math.max(0.25, s.knockout.density));

  const prepared = opts.prepared ?? prepareSource(src, s);
  const { five, sat } = coveragePrepass(prepared, src.width, src.height, T, s, invDensity);
  const resampler = new StreamResampler(
    five,
    src.width,
    src.height,
    frameW,
    frameH,
    { x0: wx0, y0: wy0, width: ww, height: wh },
    5,
  );
  const W1 = src.width + 1;
  const intermediateIn = (x0: number, x1: number, y0: number, y1: number): number =>
    sat[(y1 + 1) * W1 + (x1 + 1)] - sat[y0 * W1 + (x1 + 1)] - sat[(y1 + 1) * W1 + x0] + sat[y0 * W1 + x0];
  const fade = s.edgeFade;
  const fadeMm = Math.max(0.001, fade.widthMm);
  const heightMm = widthMm / aspect;
  const mmPerPx = 25.4 / dpi;

  const count = ww * wh;
  const amap = new Uint8Array(count);
  const cmap = new Uint8Array(count * 3);
  const solid = new Uint8Array(count);

  // ---- Pass 1: coverage and ink colour per pixel -------------------------
  /** 0 = screened normally, 1 = hard edge without ink, 2 = hard edge with ink. */
  const edge = new Uint8Array(count);
  for (let y = 0; y < wh; y++) {
    const row = resampler.row(y);
    const ymm = (wy0 + y + 0.5) * mmPerPx;
    const sy0 = resampler.spanY[y * 2];
    const sy1 = resampler.spanY[y * 2 + 1];
    for (let x = 0; x < ww; x++) {
      const i = x * 5;
      knock(row[i], row[i + 1], row[i + 2], row[i + 3], T, s, invDensity);
      let alpha = KO[0];
      let cr = KO[1];
      let cg = KO[2];
      let cb = KO[3];

      let fadeK = 1;
      if (fade.shape !== 'none') {
        const xmm = (wx0 + x + 0.5) * mmPerPx;
        let dist: number;
        if (fade.shape === 'rect') {
          dist = Math.min(xmm, widthMm - xmm, ymm, heightMm - ymm);
        } else {
          const ex = (xmm - widthMm / 2) / (widthMm / 2);
          const ey = (ymm - heightMm / 2) / (heightMm / 2);
          dist = (1 - Math.sqrt(ex * ex + ey * ey)) * Math.min(widthMm, heightMm) * 0.5;
        }
        fadeK = smoothstep(0, fadeMm, dist);
        alpha *= fadeK;
      }

      const p = y * ww + x;
      if (
        fadeK >= 0.999 &&
        intermediateIn(resampler.spanX[x * 2], resampler.spanX[x * 2 + 1], sy0, sy1) === 0
      ) {
        // Hard edge: the fifth channel is the geometric position of the edge.
        const t = row[i + 4];
        if (t >= 0.5) {
          edge[p] = 2;
          if (s.knockout.enabled) {
            // The edge pixel is a blend of the solid colour and the shirt;
            // dividing by the geometric share recovers the solid colour, so
            // edges do not come out darker than the shape they belong to.
            const inv = 1 / t;
            cr = T[0] + (KO[4] - T[0]) * inv;
            cg = T[1] + (KO[5] - T[1]) * inv;
            cb = T[2] + (KO[6] - T[2]) * inv;
          }
        } else {
          edge[p] = 1;
        }
      }

      const ab = Math.round((alpha < 0 ? 0 : alpha > 1 ? 1 : alpha) * 255);
      amap[p] = ab;
      solid[p] = alpha >= SOLID_ALPHA || edge[p] === 2 ? 1 : 0;
      cmap[p * 3] = encodeByte(cr);
      cmap[p * 3 + 1] = encodeByte(cg);
      cmap[p * 3 + 2] = encodeByte(cb);
    }
  }

  // ---- Pass 2: screening --------------------------------------------------
  // A halftone reproduces the average tone of each cell; nothing finer can
  // survive screening. Sampling a single pixel per cell instead hands every
  // cell a random dot size on grainy art and fills dots with stray specks.
  // Edge pixels enter the tone at their geometric coverage.
  const tone = new Uint8Array(count);
  for (let p = 0; p < count; p++) tone[p] = edge[p] === 2 ? 255 : edge[p] === 1 ? 0 : amap[p];
  const toneRadius = Math.max(1, Math.round((s.screen.kind === 'fm' ? fmCell : cellPx) / 2));
  const smooth = boxBlurBytes(tone, ww, wh, toneRadius);

  const solidByte = Math.round(SOLID_ALPHA * 255);
  const floorByte = Math.round(ALPHA_FLOOR * 255);
  const angle = (s.screen.angle * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const shape = s.screen.shape as DotShape;
  const seed = s.screen.seed >>> 0;
  const noise = blueNoise(64, 1.5, (seed % 1024) + 1).data;
  const fm = s.screen.kind === 'fm';

  // A blue-noise value per cell. The 64-cell tile is offset per tile by a
  // hash, so flat areas never show a repeating pattern.
  const cellNoise = (iu: number, iv: number): number => {
    const tx = Math.floor(iu / 64);
    const ty = Math.floor(iv / 64);
    const ox = (hashNoise2D(tx, ty, seed) * 64) | 0;
    const oy = (hashNoise2D(ty, tx, seed ^ 0x5bd1e995) * 64) | 0;
    return noise[((iv + oy) & 63) * 64 + ((iu + ox) & 63)];
  };

  const sampleAlpha = (fx: number, fy: number): number => {
    let px = Math.floor(fx) - wx0;
    let py = Math.floor(fy) - wy0;
    px = px < 0 ? 0 : px >= ww ? ww - 1 : px;
    py = py < 0 ? 0 : py >= wh ? wh - 1 : py;
    return smooth[py * ww + px];
  };

  const ink = new Uint8Array(count);
  for (let y = 0; y < wh; y++) {
    const Y = wy0 + y + 0.5;
    let lastU = NaN;
    let lastV = NaN;
    let ac = 0;
    let hv = 0;
    for (let x = 0; x < ww; x++) {
      const p = y * ww + x;
      const e = edge[p];
      if (e === 2) {
        ink[p] = 1;
        continue;
      }
      if (e === 1) continue;
      const ap = smooth[p];
      if (ap >= solidByte) {
        ink[p] = 1;
        continue;
      }
      if (ap <= floorByte) continue;
      const X = wx0 + x + 0.5;

      if (fm) {
        const iu = Math.floor(X / fmCell);
        const iv = Math.floor(Y / fmCell);
        if (iu !== lastU || iv !== lastV) {
          lastU = iu;
          lastV = iv;
          ac = sampleAlpha((iu + 0.5) * fmCell, (iv + 0.5) * fmCell);
          hv = cellNoise(iu, iv);
        }
        if (ac >= solidByte) ink[p] = 1;
        else if (ac > floorByte) ink[p] = hv < ac / 255 ? 1 : 0;
        continue;
      }

      const u = (X * cos + Y * sin) / cellPx;
      const v = (-X * sin + Y * cos) / cellPx;
      const iu = Math.floor(u);
      const iv = Math.floor(v);
      if (iu !== lastU || iv !== lastV) {
        lastU = iu;
        lastV = iv;
        const uc = iu + 0.5;
        const vc = iv + 0.5;
        ac = sampleAlpha(cellPx * (uc * cos - vc * sin), cellPx * (uc * sin + vc * cos));
        hv = cellNoise(iu, iv);
      }
      // A cell centred in solid ink stays solid; one centred in bare shirt
      // stays bare. Only cells centred on a tone get a dot.
      if (ac >= solidByte) {
        ink[p] = 1;
        continue;
      }
      if (ac <= floorByte) continue;
      const cov = ac / 255;
      let draw = cov;
      if (cov < aMin) draw = hv < cov / aMin ? aMin : 0;
      if (draw > 0 && dotThreshold(shape, u - iu - 0.5, v - iv - 0.5, SHAPE_OPTS) < draw) {
        ink[p] = 1;
      }
    }
  }

  // ---- Pass 3: cleanup ----------------------------------------------------
  let removedSpecks = 0;
  let filledHoles = 0;
  if (s.cleanup) {
    const before = ink.slice();
    // Rasterised minimum dots land within a few percent of their nominal
    // area; anything under 80% of it is a fragment, not a dot.
    removedSpecks = removeSmallInk(ink, ww, wh, 0.8 * minDotArea, opts.crop !== undefined);

    // Pinholes plug from ink spread and powder, which has nothing to do with
    // the white choke — so the limit follows the process minimum, not the
    // choke-enlarged dot. Holes above it are real tone and stay open.
    const processDotPx = Math.max(1, mmToPx(s.screen.minDotMm, dpi));
    filledHoles = fillSmallHoles(ink, ww, wh, 0.6 * (Math.PI / 4) * processDotPx * processDotPx);

    // Small islands too narrow to keep any white under the RIP's choke are
    // invisible on dark fabric and have too little adhesive to survive the
    // wash — typically grain. Long thin features are left alone: deleting
    // part of the design silently would be worse; the preflight flags them.
    const chokePx = mmToPx(s.chokeMm, dpi);
    if (chokePx > 0) {
      const white = erodeDisk(ink, ww, wh, chokePx);
      const info = analyzeComponents(ink, ww, wh, 1, 8);
      const supported = new Uint8Array(info.runCount);
      for (let r = 0; r < info.runCount; r++) {
        const root = info.rootOfRun[r];
        if (supported[root] === 1) continue;
        const base = info.runRow[r] * ww;
        for (let x = info.runStart[r]; x < info.runEnd[r]; x++) {
          if (white[base + x] === 1) {
            supported[root] = 1;
            break;
          }
        }
      }
      const islandLimit = 4 * minDotArea;
      const dropped = new Uint8Array(info.runCount);
      for (let r = 0; r < info.runCount; r++) {
        const root = info.rootOfRun[r];
        if (supported[root] === 1 || info.area[root] >= islandLimit) continue;
        if (opts.crop !== undefined && info.touchesBorder[root] === 1) continue;
        const base = info.runRow[r] * ww;
        ink.fill(0, base + info.runStart[r], base + info.runEnd[r]);
        if (dropped[root] === 0) {
          dropped[root] = 1;
          removedSpecks++;
        }
      }
    }

    if (filledHoles > 0) fillHoleColors(ink, before, cmap, ww, wh);
  }

  // ---- Assemble the requested region -------------------------------------
  const ox = rx0 - wx0;
  const oy = ry0 - wy0;
  const rgba = new Uint8ClampedArray(rw * rh * 4);
  const solidOut = new Uint8Array(rw * rh);
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const sp = (y + oy) * ww + (x + ox);
      const dp = y * rw + x;
      solidOut[dp] = solid[sp];
      if (ink[sp] === 0) continue;
      rgba[dp * 4] = cmap[sp * 3];
      rgba[dp * 4 + 1] = cmap[sp * 3 + 1];
      rgba[dp * 4 + 2] = cmap[sp * 3 + 2];
      rgba[dp * 4 + 3] = 255;
    }
  }

  return {
    width: rw,
    height: rh,
    x0: rx0,
    y0: ry0,
    frameWidth: frameW,
    frameHeight: frameH,
    dpi,
    widthMm,
    heightMm,
    rgba,
    solid: solidOut,
    sourceDpi: (opts.originalWidth ?? src.width) / (widthMm / 25.4),
    cellPx,
    minDotPx,
    removedSpecks,
    filledHoles,
  };
}

/** Horizontal mirror, for workflows where the file itself must be reversed. */
export function mirrorRgba(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(rgba.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const d = (y * width + (width - 1 - x)) * 4;
      out[d] = rgba[s];
      out[d + 1] = rgba[s + 1];
      out[d + 2] = rgba[s + 2];
      out[d + 3] = rgba[s + 3];
    }
  }
  return out;
}
