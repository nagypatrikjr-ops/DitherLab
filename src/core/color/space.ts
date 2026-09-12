/**
 * Colour space conversions.
 *
 * sRGB transfer function per IEC 61966-2-1; XYZ/Lab per CIE with the D65
 * white point, matching the sRGB primaries.
 */

const SRGB_TO_LINEAR_LUT = new Float32Array(4096);
for (let i = 0; i < 4096; i++) {
  const c = i / 4095;
  SRGB_TO_LINEAR_LUT[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function srgbToLinear(c: number): number {
  if (c <= 0.04045) return c / 12.92;
  if (c <= 0) return 0;
  return Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(c: number): number {
  if (c <= 0.0031308) return c <= 0 ? 0 : c * 12.92;
  return 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** Fast path for values known to be inside [0,1]; ~1e-4 accurate. */
export function srgbToLinearFast(c: number): number {
  if (c <= 0) return 0;
  if (c >= 1) return 1;
  return SRGB_TO_LINEAR_LUT[(c * 4095) | 0];
}

/** Rec. 709 luminance from *linear* RGB. */
export function luminanceLinear(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Perceptual luma from *sRGB-encoded* RGB (Rec. 601 weights). */
export function lumaSrgb(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

const XN = 0.95047;
const YN = 1.0;
const ZN = 1.08883;

function labF(t: number): number {
  return t > 0.008856451679035631 ? Math.cbrt(t) : 7.787037037037035 * t + 16 / 116;
}

/** Linear-light RGB (sRGB primaries, D65) -> CIE L*a*b*. */
export function linearRgbToLab(r: number, g: number, b: number): [number, number, number] {
  const x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b;
  const fx = labF(x / XN);
  const fy = labF(y / YN);
  const fz = labF(z / ZN);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** sRGB-encoded 0..1 -> CIE L*a*b*. */
export function srgbToLab(r: number, g: number, b: number): [number, number, number] {
  return linearRgbToLab(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b));
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
