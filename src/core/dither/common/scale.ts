import type { PixelBuffer, RenderContext } from '../../types';
import { bilateralFilter, resampleBox, resampleNearest } from '../../buffer';

/**
 * The core of DitherLab's "dither resolution is independent of output
 * resolution" idea.
 *
 * The image is boxed down by `pixelScale`, dithered on that small grid, then
 * blown back up with nearest neighbour. Detail collapses; resolution does not.
 *
 * Proxy handling: when the preview renders at 1/N, the raster geometry must be
 * divided by N as well, otherwise the preview shows a different raster than the
 * export. When pixelScale >= resolutionDivisor the dithered grid comes out at
 * exactly the same pixel dimensions in both cases, so preview and export agree
 * bit for bit apart from the final nearest-neighbour blow-up.
 */
export function effectivePixelScale(pixelScale: number, resolutionDivisor: number): number {
  return Math.max(1, pixelScale / Math.max(1, resolutionDivisor));
}

/** True when the proxy preview cannot reproduce the final raster exactly. */
export function proxyIsExact(pixelScale: number, resolutionDivisor: number): boolean {
  return pixelScale >= resolutionDivisor;
}

export interface ScaleOptions {
  pixelScale: number;
  preserveEdges: boolean;
  outputMode: 'upscaled' | 'native';
}

/**
 * Runs `fn` on the downscaled grid and returns the result at the requested
 * output size. `fn` sees a buffer in the same colour space it was given.
 */
export function withPixelScale(
  input: PixelBuffer,
  opts: ScaleOptions,
  ctx: RenderContext,
  fn: (grid: PixelBuffer) => PixelBuffer,
): PixelBuffer {
  const scale = effectivePixelScale(opts.pixelScale, ctx.resolutionDivisor);
  if (scale <= 1.0001) return fn(input);

  const gw = Math.max(1, Math.round(input.width / scale));
  const gh = Math.max(1, Math.round(input.height / scale));

  let source = input;
  if (opts.preserveEdges) {
    // Radius tracks the collapse factor: the bigger the jump, the wider the
    // edge-preserving pre-filter has to look to keep a boundary intact.
    const radius = Math.min(6, Math.max(1, Math.round(scale * 0.5)));
    source = bilateralFilter(input, radius, Math.max(1, scale * 0.5), 0.12);
  }

  const grid = resampleBox(source, gw, gh);
  const dithered = fn(grid);

  if (opts.outputMode === 'native') return dithered;
  return resampleNearest(dithered, input.width, input.height);
}

/**
 * How much of the proxy divisor the pixelScale collapse did *not* absorb.
 *
 * Inside `withPixelScale` the callback sees a grid whose dimensions already
 * account for the divisor whenever pixelScale >= divisor — the grid is then
 * identical in preview and export, so raster geometry (matrix scale, halftone
 * cell size, modulation frequency) must NOT be divided again. Only the part
 * the collapse could not absorb still needs scaling.
 *
 *   pixelScale >= divisor -> 1        (grid identical, no further scaling)
 *   pixelScale <  divisor -> divisor / pixelScale
 */
export function residualDivisor(pixelScale: number, resolutionDivisor: number): number {
  const div = Math.max(1, resolutionDivisor);
  const ps = Math.max(1, pixelScale);
  const effective = effectivePixelScale(ps, div);
  return (div * effective) / ps;
}
