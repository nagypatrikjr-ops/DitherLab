/**
 * Streaming Mitchell–Netravali resampler (B = C = 1/3).
 *
 * Why Mitchell and not Lanczos: this resampler feeds a coverage map that is
 * then thresholded into dots. Lanczos rings at hard edges, and a few percent
 * of overshoot next to a knocked-out background is enough to sprinkle stray
 * dots along every edge. Mitchell's B = C = 1/3 was chosen by its authors as
 * the best compromise between ringing, blur and anisotropy, and it keeps the
 * overshoot small enough for the knockout floor to absorb.
 *
 * Streaming: the output is produced one row at a time from a small cache of
 * horizontally filtered source rows, so memory stays proportional to the
 * output width rather than the full output area.
 *
 * The input is premultiplied RGBA in linear light — the only space in which
 * averaging neighbouring pixels does not darken edges or bleed transparent
 * colour into the result.
 */

export function mitchell(x: number): number {
  const ax = Math.abs(x);
  if (ax < 1) return (7 * ax * ax * ax - 12 * ax * ax + 16 / 3) / 6;
  if (ax < 2) return ((-7 / 3) * ax * ax * ax + 12 * ax * ax - 20 * ax + 32 / 3) / 6;
  return 0;
}

interface Taps {
  readonly count: number;
  readonly index: Int32Array;
  readonly weight: Float32Array;
}

/**
 * Filter taps for output indices [from, from + length) of a full output of
 * `dstFull` samples. Indices outside the source are clamped, which replicates
 * the edge pixel rather than fading to black.
 */
function buildTaps(srcLen: number, dstFull: number, from: number, length: number): Taps {
  const scale = dstFull / srcLen;
  const filterScale = Math.min(1, scale);
  const support = 2 / filterScale;
  const count = Math.ceil(support * 2) + 1;
  const index = new Int32Array(length * count);
  const weight = new Float32Array(length * count);

  for (let i = 0; i < length; i++) {
    const center = (from + i + 0.5) / scale - 0.5;
    const first = Math.ceil(center - support);
    let sum = 0;
    for (let t = 0; t < count; t++) {
      const k = first + t;
      const w = mitchell((center - k) * filterScale);
      index[i * count + t] = k < 0 ? 0 : k >= srcLen ? srcLen - 1 : k;
      weight[i * count + t] = w;
      sum += w;
    }
    if (sum !== 0) {
      for (let t = 0; t < count; t++) weight[i * count + t] /= sum;
    }
  }
  return { count, index, weight };
}

export interface ResampleWindow {
  x0: number;
  y0: number;
  width: number;
  height: number;
}

/**
 * Produces output rows of a (possibly cropped) resampled image in order.
 * Rows must be requested with non-decreasing y.
 */
function spans(t: Taps, length: number): Int32Array {
  const out = new Int32Array(length * 2);
  for (let i = 0; i < length; i++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < t.count; k++) {
      if (Math.abs(t.weight[i * t.count + k]) < 1e-9) continue;
      const idx = t.index[i * t.count + k];
      if (idx < lo) lo = idx;
      if (idx > hi) hi = idx;
    }
    out[i * 2] = lo === Infinity ? 0 : lo;
    out[i * 2 + 1] = hi === -Infinity ? 0 : hi;
  }
  return out;
}

/**
 * Channel layout: 0..2 premultiplied colour, 3 coverage/alpha, and any extra
 * channels (4+) are independent 0..1 fields resampled alongside.
 */
export class StreamResampler {
  private readonly h: Taps;
  private readonly v: Taps;
  private readonly cache = new Map<number, Float32Array>();
  private readonly out: Float32Array;
  private readonly ch: number;
  /** Source index range [lo, hi] feeding each output column / row. */
  readonly spanX: Int32Array;
  readonly spanY: Int32Array;

  constructor(
    private readonly src: Float32Array,
    private readonly sw: number,
    sh: number,
    dstW: number,
    dstH: number,
    private readonly win: ResampleWindow,
    channels = 4,
  ) {
    this.ch = channels;
    this.h = buildTaps(sw, dstW, win.x0, win.width);
    this.v = buildTaps(sh, dstH, win.y0, win.height);
    this.out = new Float32Array(win.width * channels);
    this.spanX = spans(this.h, win.width);
    this.spanY = spans(this.v, win.height);
  }

  private hRow(sy: number): Float32Array {
    const hit = this.cache.get(sy);
    if (hit) return hit;
    const { count, index, weight } = this.h;
    const w = this.win.width;
    const ch = this.ch;
    const row = new Float32Array(w * ch);
    const base = sy * this.sw * ch;
    const s = this.src;
    for (let x = 0; x < w; x++) {
      const o = x * ch;
      for (let t = 0; t < count; t++) {
        const wt = weight[x * count + t];
        if (wt === 0) continue;
        const i = base + index[x * count + t] * ch;
        for (let c = 0; c < ch; c++) row[o + c] += s[i + c] * wt;
      }
    }
    this.cache.set(sy, row);
    return row;
  }

  /**
   * Output row `y` (relative to the window), premultiplied linear RGBA.
   * Values are clamped so ringing can never produce negative light or colour
   * brighter than its own coverage.
   */
  row(y: number): Float32Array {
    const { count, index, weight } = this.v;
    const w = this.win.width;
    const ch = this.ch;
    const out = this.out;
    out.fill(0);

    let lowest = Infinity;
    for (let t = 0; t < count; t++) {
      const wt = weight[y * count + t];
      const sy = index[y * count + t];
      if (sy < lowest) lowest = sy;
      if (wt === 0) continue;
      const r = this.hRow(sy);
      for (let i = 0; i < w * ch; i++) out[i] += r[i] * wt;
    }

    // Rows above the current window can never be needed again.
    for (const key of this.cache.keys()) {
      if (key < lowest) this.cache.delete(key);
    }

    for (let x = 0; x < w; x++) {
      const i = x * ch;
      let a = out[i + 3];
      a = a < 0 ? 0 : a > 1 ? 1 : a;
      out[i + 3] = a;
      for (let c = 0; c < 3; c++) {
        const v = out[i + c];
        out[i + c] = v < 0 ? 0 : v > a ? a : v;
      }
      for (let c = 4; c < ch; c++) {
        const v = out[i + c];
        out[i + c] = v < 0 ? 0 : v > 1 ? 1 : v;
      }
    }
    return out;
  }
}
