import type { ColorSpace, DistanceMetric, Palette } from '../../types';
import { getQuantizer, paletteInSpace, PaletteQuantizer } from '../../color/quantizer';
import { lumaSrgb } from '../../color/space';

export type ColorMode = 'palette' | 'perChannel' | 'mono';

/**
 * Uniform interface over the three ways DitherLab reduces a colour:
 * nearest entry in a palette, uniform per-channel levels, or a 1-bit
 * luminance decision. Every dither algorithm quantises through this so the
 * colour behaviour is identical across the whole library.
 */
export interface Quantizer {
  readonly mode: ColorMode;
  /** Writes the quantised colour into out[off..off+2]. */
  quantize(r: number, g: number, b: number, out: Float32Array, off: number): void;
  /** 1-bit only: returns 0 or 1 for the given luminance-ish value. */
  readonly isMono: boolean;
}

class PaletteMode implements Quantizer {
  readonly mode = 'palette';
  readonly isMono: boolean;
  constructor(private readonly q: PaletteQuantizer) {
    this.isMono = q.size === 2;
  }
  quantize(r: number, g: number, b: number, out: Float32Array, off: number): void {
    this.q.colorAt(this.q.nearest(r, g, b), out, off);
  }
}

class PerChannelMode implements Quantizer {
  readonly mode = 'perChannel';
  readonly isMono = false;
  private readonly n: number;
  constructor(levels: number) {
    this.n = Math.max(2, Math.round(levels)) - 1;
  }
  quantize(r: number, g: number, b: number, out: Float32Array, off: number): void {
    const n = this.n;
    out[off] = Math.round((r < 0 ? 0 : r > 1 ? 1 : r) * n) / n;
    out[off + 1] = Math.round((g < 0 ? 0 : g > 1 ? 1 : g) * n) / n;
    out[off + 2] = Math.round((b < 0 ? 0 : b > 1 ? 1 : b) * n) / n;
  }
}

class MonoMode implements Quantizer {
  readonly mode = 'mono';
  readonly isMono = true;
  private readonly mid: number;
  constructor(
    private readonly dark: readonly [number, number, number],
    private readonly light: readonly [number, number, number],
  ) {
    // Decide against the midpoint of the two endpoints rather than a fixed
    // 0.5, so an ink/paper pair behaves the same as pure black and white.
    this.mid = (lumaSrgb(dark[0], dark[1], dark[2]) + lumaSrgb(light[0], light[1], light[2])) * 0.5;
  }
  quantize(r: number, g: number, b: number, out: Float32Array, off: number): void {
    const c = lumaSrgb(r, g, b) >= this.mid ? this.light : this.dark;
    out[off] = c[0];
    out[off + 1] = c[1];
    out[off + 2] = c[2];
  }
}

export function makeQuantizer(
  mode: ColorMode,
  palette: Palette | null,
  metric: DistanceMetric,
  colorDepth: number,
  space: ColorSpace = 'srgb',
): Quantizer {
  if (mode === 'perChannel') return new PerChannelMode(colorDepth);
  if (mode === 'mono' || palette === null || palette.colors.length < 6) {
    const { dark, light } = monoEndpoints(palette, space);
    return new MonoMode(dark, light);
  }
  return new PaletteMode(getQuantizer(palette, metric, space));
}

/**
 * Two-tone endpoints used by threshold-style (ordered / halftone) algorithms,
 * where the decision is a comparison rather than a nearest-colour search.
 */
export function monoEndpoints(
  palette: Palette | null,
  space: ColorSpace = 'srgb',
): { dark: [number, number, number]; light: [number, number, number] } {
  if (palette === null || palette.colors.length < 3) {
    return { dark: [0, 0, 0], light: [1, 1, 1] };
  }
  const c = paletteInSpace(palette, space);
  if (c.length < 6) return { dark: [c[0], c[1], c[2]], light: [1, 1, 1] };
  return {
    dark: [c[0], c[1], c[2]],
    light: [c[c.length - 3], c[c.length - 2], c[c.length - 1]],
  };
}
