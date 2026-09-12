import type { PixelBuffer, ColorSpace } from '../types';
import { clamp01, linearToSrgb, srgbToLinear } from '../color/space';

export function createBuffer(
  width: number,
  height: number,
  colorSpace: ColorSpace = 'srgb',
): PixelBuffer {
  return { data: new Float32Array(width * height * 4), width, height, colorSpace };
}

export function cloneBuffer(src: PixelBuffer): PixelBuffer {
  return {
    data: new Float32Array(src.data),
    width: src.width,
    height: src.height,
    colorSpace: src.colorSpace,
  };
}

/** Same geometry and colour space, but a fresh zeroed data array. */
export function likeBuffer(src: PixelBuffer): PixelBuffer {
  return {
    data: new Float32Array(src.data.length),
    width: src.width,
    height: src.height,
    colorSpace: src.colorSpace,
  };
}

export function bufferFromRgba(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): PixelBuffer {
  const data = new Float32Array(width * height * 4);
  for (let i = 0; i < data.length; i++) data[i] = rgba[i] / 255;
  return { data, width, height, colorSpace: 'srgb' };
}

export function bufferToRgba(src: PixelBuffer): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(src.width * src.height * 4);
  const d = src.data;
  if (src.colorSpace === 'linear') {
    for (let i = 0; i < out.length; i += 4) {
      // Uint8ClampedArray already rounds on assignment; adding 0.5 here would
      // round twice and shift every value up by one.
      out[i] = linearToSrgb(clamp01(d[i])) * 255;
      out[i + 1] = linearToSrgb(clamp01(d[i + 1])) * 255;
      out[i + 2] = linearToSrgb(clamp01(d[i + 2])) * 255;
      out[i + 3] = clamp01(d[i + 3]) * 255;
    }
  } else {
    for (let i = 0; i < out.length; i++) out[i] = clamp01(d[i]) * 255;
  }
  return out;
}

/** Convert in place-free fashion between sRGB-encoded and linear-light storage. */
export function toColorSpace(src: PixelBuffer, target: ColorSpace): PixelBuffer {
  if (src.colorSpace === target) return src;
  const d = src.data;
  const out = new Float32Array(d.length);
  const fn = target === 'linear' ? srgbToLinear : linearToSrgb;
  for (let i = 0; i < d.length; i += 4) {
    out[i] = fn(d[i]);
    out[i + 1] = fn(d[i + 1]);
    out[i + 2] = fn(d[i + 2]);
    out[i + 3] = d[i + 3];
  }
  return { data: out, width: src.width, height: src.height, colorSpace: target };
}

// ---------------------------------------------------------------------------
// Resampling
// ---------------------------------------------------------------------------

/**
 * Area-average ("box") downscale. Handles non-integer ratios by weighting
 * partial source pixels, so pixelScale may be fractional.
 */
export function resampleBox(src: PixelBuffer, dstW: number, dstH: number): PixelBuffer {
  const w = Math.max(1, Math.round(dstW));
  const h = Math.max(1, Math.round(dstH));
  if (w === src.width && h === src.height) return cloneBuffer(src);

  const out = new Float32Array(w * h * 4);
  const sx = src.width / w;
  const sy = src.height / h;
  const sd = src.data;

  for (let y = 0; y < h; y++) {
    const y0 = y * sy;
    const y1 = Math.min(src.height, (y + 1) * sy);
    const iy0 = Math.floor(y0);
    const iy1 = Math.max(iy0 + 1, Math.ceil(y1));
    for (let x = 0; x < w; x++) {
      const x0 = x * sx;
      const x1 = Math.min(src.width, (x + 1) * sx);
      const ix0 = Math.floor(x0);
      const ix1 = Math.max(ix0 + 1, Math.ceil(x1));

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let wsum = 0;

      for (let yy = iy0; yy < iy1 && yy < src.height; yy++) {
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        if (wy <= 0) continue;
        for (let xx = ix0; xx < ix1 && xx < src.width; xx++) {
          const wx = Math.min(xx + 1, x1) - Math.max(xx, x0);
          if (wx <= 0) continue;
          const weight = wx * wy;
          const i = (yy * src.width + xx) * 4;
          r += sd[i] * weight;
          g += sd[i + 1] * weight;
          b += sd[i + 2] * weight;
          a += sd[i + 3] * weight;
          wsum += weight;
        }
      }

      const o = (y * w + x) * 4;
      if (wsum > 0) {
        const inv = 1 / wsum;
        out[o] = r * inv;
        out[o + 1] = g * inv;
        out[o + 2] = b * inv;
        out[o + 3] = a * inv;
      }
    }
  }
  return { data: out, width: w, height: h, colorSpace: src.colorSpace };
}

/** Nearest-neighbour resample. Used to blow the dithered grid back up. */
export function resampleNearest(src: PixelBuffer, dstW: number, dstH: number): PixelBuffer {
  const w = Math.max(1, Math.round(dstW));
  const h = Math.max(1, Math.round(dstH));
  if (w === src.width && h === src.height) return cloneBuffer(src);

  const out = new Float32Array(w * h * 4);
  const sd = src.data;
  const sx = src.width / w;
  const sy = src.height / h;
  const xmap = new Int32Array(w);
  for (let x = 0; x < w; x++) {
    xmap[x] = Math.min(src.width - 1, Math.floor((x + 0.5) * sx));
  }
  for (let y = 0; y < h; y++) {
    const syy = Math.min(src.height - 1, Math.floor((y + 0.5) * sy));
    const rowBase = syy * src.width;
    for (let x = 0; x < w; x++) {
      const i = (rowBase + xmap[x]) * 4;
      const o = (y * w + x) * 4;
      out[o] = sd[i];
      out[o + 1] = sd[i + 1];
      out[o + 2] = sd[i + 2];
      out[o + 3] = sd[i + 3];
    }
  }
  return { data: out, width: w, height: h, colorSpace: src.colorSpace };
}

/** Separable bilinear resample, used for smooth previews and blur pyramids. */
export function resampleBilinear(src: PixelBuffer, dstW: number, dstH: number): PixelBuffer {
  const w = Math.max(1, Math.round(dstW));
  const h = Math.max(1, Math.round(dstH));
  if (w === src.width && h === src.height) return cloneBuffer(src);

  const out = new Float32Array(w * h * 4);
  const sd = src.data;
  const sw = src.width;
  const sh = src.height;
  const sx = sw / w;
  const sy = sh / h;

  for (let y = 0; y < h; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const tx = fx - x0;

      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      const o = (y * w + x) * 4;

      for (let c = 0; c < 4; c++) {
        const top = sd[i00 + c] + (sd[i10 + c] - sd[i00 + c]) * tx;
        const bot = sd[i01 + c] + (sd[i11 + c] - sd[i01 + c]) * tx;
        out[o + c] = top + (bot - top) * ty;
      }
    }
  }
  return { data: out, width: w, height: h, colorSpace: src.colorSpace };
}

/**
 * Edge-preserving pre-filter for `preserveEdges`.
 *
 * A separable-in-practice bilateral filter: spatial Gaussian weights modulated
 * by a range Gaussian on luma difference. Applied before box downscaling so
 * that edges survive the collapse instead of being averaged into mush.
 */
export function bilateralFilter(
  src: PixelBuffer,
  radius: number,
  sigmaSpace: number,
  sigmaRange: number,
): PixelBuffer {
  const r = Math.max(1, Math.round(radius));
  const out = new Float32Array(src.data.length);
  const sd = src.data;
  const w = src.width;
  const h = src.height;

  const spatial = new Float32Array(2 * r + 1);
  const invS2 = 1 / (2 * sigmaSpace * sigmaSpace);
  for (let i = -r; i <= r; i++) spatial[i + r] = Math.exp(-(i * i) * invS2);
  const invR2 = 1 / (2 * sigmaRange * sigmaRange);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ci = (y * w + x) * 4;
      const cl = 0.299 * sd[ci] + 0.587 * sd[ci + 1] + 0.114 * sd[ci + 2];
      let ar = 0;
      let ag = 0;
      let ab = 0;
      let wsum = 0;

      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        const sw = spatial[dy + r];
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const i = (yy * w + xx) * 4;
          const l = 0.299 * sd[i] + 0.587 * sd[i + 1] + 0.114 * sd[i + 2];
          const dl = l - cl;
          const weight = sw * spatial[dx + r] * Math.exp(-(dl * dl) * invR2);
          ar += sd[i] * weight;
          ag += sd[i + 1] * weight;
          ab += sd[i + 2] * weight;
          wsum += weight;
        }
      }
      const inv = wsum > 0 ? 1 / wsum : 0;
      out[ci] = ar * inv;
      out[ci + 1] = ag * inv;
      out[ci + 2] = ab * inv;
      out[ci + 3] = sd[ci + 3];
    }
  }
  return { data: out, width: w, height: h, colorSpace: src.colorSpace };
}
