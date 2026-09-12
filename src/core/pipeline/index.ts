import type { EffectLayer, PixelBuffer, RenderContext } from '../types';
import { composite } from '../blend';
import { coerceParams, getProcessor } from '../dither/registry';
import { hashString } from '../rng';
import { RenderCache } from './cache';

export { RenderCache } from './cache';

export interface RenderResult {
  buffer: PixelBuffer;
  /** Index of the first layer that had to be recomputed; -1 if fully cached. */
  firstRecomputed: number;
  layerCount: number;
  fromCache: boolean;
  elapsedMs: number;
}

/** Everything about the context that can change a layer's output. */
function contextKey(ctx: RenderContext): string {
  const pal = ctx.palette
    ? `${ctx.palette.id}#${ctx.palette.colors.length}#${hashString(
        Array.from(ctx.palette.colors, (v) => Math.round(v * 255)).join(','),
      )}`
    : 'none';
  return [
    pal,
    ctx.distance,
    ctx.gammaCorrect ? 'g1' : 'g0',
    ctx.seed,
    ctx.frame,
    ctx.noiseMode,
    ctx.cycleLength,
    ctx.resolutionDivisor,
  ].join('|');
}

function layerKey(layer: EffectLayer): string {
  return JSON.stringify([
    layer.type,
    layer.enabled,
    layer.opacity,
    layer.blendMode,
    layer.params,
  ]);
}

/**
 * The pipeline is a pure function of (source, layers, context).
 *
 * Cache keys are cumulative: the key for stage i covers the source identity,
 * the render context and every layer up to i. Changing layer 3 therefore
 * leaves the keys for stages 0..2 untouched and their buffers are reused.
 */
export function renderPipeline(
  source: PixelBuffer,
  sourceId: string,
  layers: readonly EffectLayer[],
  ctx: RenderContext,
  cache?: RenderCache,
): RenderResult {
  const started = Date.now();
  const ck = contextKey(ctx);
  let current = source;
  let running = `${sourceId}|${source.width}x${source.height}|${ck}`;
  let firstRecomputed = -1;

  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    running = `${running}||${layerKey(layer)}`;

    if (!layer.enabled) continue;

    const key = `${hashString(running)}:${running.length}`;
    const hit = cache?.get(key);
    if (hit && hit.width === current.width && hit.height === current.height) {
      current = hit;
      continue;
    }
    if (firstRecomputed < 0) firstRecomputed = i;

    const proc = getProcessor(layer.type);
    if (proc === null) continue; // unknown layer type: pass through untouched

    const params = coerceParams(proc.params, layer.params);
    const produced = proc.apply(current, params, ctx);

    // A processor may change geometry (outputMode 'native'); compositing then
    // has nothing to blend against, so the raw result becomes the new base.
    const blended =
      produced.width === current.width && produced.height === current.height
        ? composite(current, produced, layer.blendMode, layer.opacity)
        : produced;

    cache?.set(key, blended);
    current = blended;

    if (ctx.signal?.aborted) break;
  }

  return {
    buffer: current,
    firstRecomputed,
    layerCount: layers.length,
    fromCache: firstRecomputed < 0,
    elapsedMs: Date.now() - started,
  };
}

/**
 * Choose an integer proxy divisor for previewing a large image.
 *
 * Integer only: a fractional divisor would put the dither lattice on a
 * different grid than the export and the preview would stop matching.
 */
export function proxyDivisorFor(width: number, height: number, maxDimension = 2000): number {
  const longest = Math.max(width, height);
  if (longest <= maxDimension) return 1;
  return Math.max(1, Math.ceil(longest / maxDimension));
}

/**
 * True when the preview at `divisor` reproduces the export exactly for the
 * given layers. It does whenever every dither layer's pixelScale is at least
 * the divisor, because the dithered grid then has identical dimensions.
 */
export function previewIsExact(layers: readonly EffectLayer[], divisor: number): boolean {
  if (divisor <= 1) return true;
  for (const layer of layers) {
    if (!layer.enabled) continue;
    const proc = getProcessor(layer.type);
    if (proc === null) continue;
    if (!('pixelScale' in proc.params)) return false;
    const scale = layer.params['pixelScale'];
    if (typeof scale !== 'number' || scale < divisor) return false;
  }
  return true;
}
