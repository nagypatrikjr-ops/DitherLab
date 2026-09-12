/**
 * A real JPEG transform pipeline: colour transform, 4:2:0 subsampling,
 * 8x8 forward DCT, quantisation with the standard Annex K tables scaled by the
 * IJG quality formula, then dequantisation and inverse DCT.
 *
 * What this is: genuine JPEG *compression*, so the artefacts (blocking,
 * ringing around edges, chroma bleeding, DC banding) are the real thing and
 * change exactly as quality changes.
 *
 * What this is not: entropy coding. Huffman/arithmetic coding determines file
 * size, not appearance, so it is skipped. Bitstream corruption is modelled
 * directly on the coefficients instead — including DC prediction desync, which
 * is what produces the horizontal colour-smear streaks people recognise as a
 * glitched JPEG.
 */

/** ITU-T T.81 Annex K, Table K.1 — luminance quantisation. */
export const QUANT_LUMA = new Int32Array([
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
]);

/** ITU-T T.81 Annex K, Table K.2 — chrominance quantisation. */
export const QUANT_CHROMA = new Int32Array([
  17, 18, 24, 47, 99, 99, 99, 99,
  18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
]);

/** IJG quality scaling, quality in 1..100. */
export function scaleQuantTable(base: Int32Array, quality: number): Int32Array {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const scale = q < 50 ? 5000 / q : 200 - 2 * q;
  const out = new Int32Array(64);
  for (let i = 0; i < 64; i++) {
    out[i] = Math.min(255, Math.max(1, Math.floor((base[i] * scale + 50) / 100)));
  }
  return out;
}

const COS_TABLE = new Float32Array(64);
for (let u = 0; u < 8; u++) {
  for (let x = 0; x < 8; x++) {
    COS_TABLE[u * 8 + x] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  }
}
const C = new Float32Array(8);
for (let u = 0; u < 8; u++) C[u] = u === 0 ? Math.SQRT1_2 : 1;

/** Forward 8x8 DCT-II, separable, on a block of 64 samples in -128..127. */
export function fdct8x8(block: Float32Array, out: Float32Array): void {
  const tmp = new Float32Array(64);
  for (let y = 0; y < 8; y++) {
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let x = 0; x < 8; x++) s += block[y * 8 + x] * COS_TABLE[u * 8 + x];
      tmp[y * 8 + u] = s * C[u] * 0.5;
    }
  }
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let s = 0;
      for (let y = 0; y < 8; y++) s += tmp[y * 8 + u] * COS_TABLE[v * 8 + y];
      out[v * 8 + u] = s * C[v] * 0.5;
    }
  }
}

/** Inverse 8x8 DCT. */
export function idct8x8(coeff: Float32Array, out: Float32Array): void {
  const tmp = new Float32Array(64);
  for (let v = 0; v < 8; v++) {
    for (let x = 0; x < 8; x++) {
      let s = 0;
      for (let u = 0; u < 8; u++) s += C[u] * coeff[v * 8 + u] * COS_TABLE[u * 8 + x];
      tmp[v * 8 + x] = s * 0.5;
    }
  }
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      let s = 0;
      for (let v = 0; v < 8; v++) s += C[v] * tmp[v * 8 + x] * COS_TABLE[v * 8 + y];
      out[y * 8 + x] = s * 0.5;
    }
  }
}

/** JFIF full-range RGB -> YCbCr, inputs and outputs 0..1 (chroma centred on 0.5). */
export function rgbToYcbcr(r: number, g: number, b: number, out: Float32Array, off = 0): void {
  out[off] = 0.299 * r + 0.587 * g + 0.114 * b;
  out[off + 1] = -0.168736 * r - 0.331264 * g + 0.5 * b + 0.5;
  out[off + 2] = 0.5 * r - 0.418688 * g - 0.081312 * b + 0.5;
}

export function ycbcrToRgb(y: number, cb: number, cr: number, out: Float32Array, off = 0): void {
  const b0 = cb - 0.5;
  const r0 = cr - 0.5;
  out[off] = y + 1.402 * r0;
  out[off + 1] = y - 0.344136 * b0 - 0.714136 * r0;
  out[off + 2] = y + 1.772 * b0;
}

/** Zig-zag order, used when corrupting a contiguous run of coefficients. */
export const ZIGZAG = new Int32Array([
  0, 1, 8, 16, 9, 2, 3, 10,
  17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34,
  27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63,
]);
