import type {
  ColorSpace,
  ParamSchema,
  ParamsOf,
  PixelBuffer,
  Palette,
  Processor,
  RenderContext,
} from '../../types';
import { likeBuffer, toColorSpace } from '../../buffer';
import { hashNoise2D, temporalSeed } from '../../rng';
import { register } from '../registry';
import { ORDERED_PARAMS, QUANT_PARAMS, SCALE_PARAMS, THRESHOLD_PARAMS } from '../common/params';
import { makeQuantizer, type ColorMode } from '../common/quantize';
import { paletteInSpace } from '../../color/quantizer';
import { residualDivisor, withPixelScale } from '../common/scale';
import {
  blueNoise,
  interleavedGradientNoise,
  parseMatrixText,
  STATIC_MATRICES,
  type ThresholdMatrix,
} from './matrices';

const spreadCache = new Map<string, number>();

/**
 * Mean distance from each palette entry to its nearest neighbour. This is the
 * natural amplitude for an ordered perturbation: dithering between two colours
 * that are already close needs a small kick, far-apart colours need a big one.
 */
export function estimatePaletteSpread(palette: Palette, space: ColorSpace = 'srgb'): number {
  const key = `${palette.id}:${space}`;
  const hit = spreadCache.get(key);
  if (hit !== undefined) return hit;
  const c = paletteInSpace(palette, space);
  const n = c.length / 3;
  if (n < 2) return 1;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    let best = Infinity;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const dr = c[i * 3] - c[j * 3];
      const dg = c[i * 3 + 1] - c[j * 3 + 1];
      const db = c[i * 3 + 2] - c[j * 3 + 2];
      const d = Math.sqrt(dr * dr + dg * dg + db * db);
      if (d < best) best = d;
    }
    sum += best;
  }
  const v = sum / n;
  spreadCache.set(key, v);
  return v;
}

type PatternKind = 'matrix' | 'blueNoise' | 'whiteNoise' | 'ign' | 'custom';

const ORDERED_SCHEMA = {
  ...SCALE_PARAMS,
  ...QUANT_PARAMS,
  ...ORDERED_PARAMS,
  ...THRESHOLD_PARAMS,
  spread: {
    kind: 'float',
    label: 'Szórás erőssége',
    min: 0,
    max: 3,
    step: 0.01,
    default: 1,
    unit: '×',
    group: 'Minta',
  },
} as const satisfies ParamSchema;

const CUSTOM_MATRIX_SCHEMA = {
  ...ORDERED_SCHEMA,
  matrixText: {
    kind: 'text',
    label: 'Mátrix (soronként számok)',
    default: '0 8 2 10\n12 4 14 6\n3 11 1 9\n15 7 13 5',
    group: 'Minta',
  },
} as const satisfies ParamSchema;

type OrderedParams = ParamsOf<typeof ORDERED_SCHEMA>;

/**
 * Builds the threshold sampler. Rotation is applied to the sampling
 * coordinates rather than to the matrix itself, so any angle works without
 * resampling artefacts in the pattern.
 */
function makeSampler(
  kind: PatternKind,
  matrix: ThresholdMatrix | null,
  params: OrderedParams,
  ctx: RenderContext,
  layerSeed: number,
): (x: number, y: number) => number {
  // Raster geometry only needs the part of the proxy divisor that the
  // pixelScale collapse did not already absorb; see residualDivisor.
  const scale = Math.max(
    0.05,
    params.matrixScale / residualDivisor(params.pixelScale, ctx.resolutionDivisor),
  );
  const rad = (params.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const contrast = params.contrast;
  const bias = params.bias;

  const shape = (t: number): number => {
    const v = (t - 0.5) * contrast + 0.5 + bias;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  };

  if (kind === 'whiteNoise') {
    return (x, y) => {
      const u = (x * cos + y * sin) / scale;
      const v = (-x * sin + y * cos) / scale;
      return shape(hashNoise2D(Math.floor(u), Math.floor(v), layerSeed));
    };
  }

  if (kind === 'ign') {
    return (x, y) => {
      const u = (x * cos + y * sin) / scale;
      const v = (-x * sin + y * cos) / scale;
      const offset = (layerSeed % 64) * 0.7548776662;
      return shape(interleavedGradientNoise(u + offset, v + offset));
    };
  }

  const m = matrix;
  if (m === null) return () => 0.5;
  const size = m.size;
  const data = m.data;
  return (x, y) => {
    const u = (x * cos + y * sin) / scale;
    const v = (-x * sin + y * cos) / scale;
    const mx = ((Math.floor(u) % size) + size) % size;
    const my = ((Math.floor(v) % size) + size) % size;
    return shape(data[my * size + mx]);
  };
}

function runOrdered(
  grid: PixelBuffer,
  sampler: (x: number, y: number) => number,
  params: OrderedParams,
  ctx: RenderContext,
): PixelBuffer {
  const w = grid.width;
  const h = grid.height;
  const out = likeBuffer(grid);
  const src = grid.data;
  const dst = out.data;

  const mode = params.colorMode as ColorMode;
  const space = grid.colorSpace;
  const quant = makeQuantizer(mode, ctx.palette, ctx.distance, params.colorDepth, space);

  let amplitude: number;
  if (mode === 'perChannel') {
    amplitude = 1 / Math.max(1, params.colorDepth - 1);
  } else if (mode === 'palette' && ctx.palette) {
    amplitude = estimatePaletteSpread(ctx.palette, space);
  } else {
    amplitude = 1;
  }
  amplitude *= params.spread;

  const tmp = new Float32Array(3);
  const thr = params.threshold;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = sampler(x, y);
      const kick = (t - 0.5) * amplitude + thr;
      const i = (y * w + x) * 4;
      quant.quantize(src[i] + kick, src[i + 1] + kick, src[i + 2] + kick, tmp, 0);
      dst[i] = tmp[0];
      dst[i + 1] = tmp[1];
      dst[i + 2] = tmp[2];
      dst[i + 3] = src[i + 3];
    }
    if (ctx.progress && (y & 127) === 0) ctx.progress(y / h);
    if (ctx.signal?.aborted) break;
  }
  return out;
}

function makeOrderedProcessor(
  id: string,
  name: string,
  kind: PatternKind,
  matrixFor: (params: OrderedParams, seed: number) => ThresholdMatrix | null,
): Processor<typeof ORDERED_SCHEMA> {
  return {
    id,
    name,
    category: 'ordered',
    params: ORDERED_SCHEMA,
    supportsColor: true,
    vectorizable: true,
    apply(input, params, ctx) {
      const layerSeed = temporalSeed(
        ctx.seed ^ (params.seed >>> 0),
        id,
        ctx.frame,
        ctx.noiseMode,
        ctx.cycleLength,
      );
      const space = params.gammaCorrect && ctx.gammaCorrect ? 'linear' : 'srgb';
      const matrix = matrixFor(params, layerSeed);
      const sampler = makeSampler(kind, matrix, params, ctx, layerSeed);
      return withPixelScale(input, params, ctx, (grid) => {
        const working = toColorSpace(grid, space);
        const result = runOrdered(working, sampler, params, ctx);
        return toColorSpace(result, grid.colorSpace);
      });
    },
  };
}

const CUSTOM_MATRIX_PROCESSOR: Processor<typeof CUSTOM_MATRIX_SCHEMA> = {
  id: 'ord:custom-matrix',
  name: 'Egyedi mátrix',
  category: 'ordered',
  params: CUSTOM_MATRIX_SCHEMA,
  supportsColor: true,
  vectorizable: true,
  apply(input, params, ctx) {
    const layerSeed = temporalSeed(
      ctx.seed ^ (params.seed >>> 0),
      'ord:custom-matrix',
      ctx.frame,
      ctx.noiseMode,
      ctx.cycleLength,
    );
    let matrix: ThresholdMatrix;
    try {
      matrix = parseMatrixText(params.matrixText);
    } catch {
      matrix = STATIC_MATRICES[2]; // fall back to Bayer 8 rather than failing the render
    }
    const sampler = makeSampler('matrix', matrix, params, ctx, layerSeed);
    const space = params.gammaCorrect && ctx.gammaCorrect ? 'linear' : 'srgb';
    return withPixelScale(input, params, ctx, (grid) => {
      const working = toColorSpace(grid, space);
      const result = runOrdered(working, sampler, params, ctx);
      return toColorSpace(result, grid.colorSpace);
    });
  },
};

export function registerOrdered(): void {
  for (const m of STATIC_MATRICES) {
    register(makeOrderedProcessor(`ord:${m.id}`, m.name, 'matrix', () => m));
  }
  register(
    makeOrderedProcessor('ord:blue-noise', 'Kék zaj (void-and-cluster)', 'matrix', (_p, seed) =>
      blueNoise(64, 1.5, (seed % 1024) + 1),
    ),
  );
  register(
    makeOrderedProcessor('ord:void-cluster-32', 'Void-and-cluster 32×32', 'matrix', (_p, seed) =>
      blueNoise(32, 1.9, (seed % 1024) + 1),
    ),
  );
  register(makeOrderedProcessor('ord:white-noise', 'Fehér zaj', 'whiteNoise', () => null));
  register(
    makeOrderedProcessor('ord:ign', 'Interleaved gradient noise', 'ign', () => null),
  );
  register(CUSTOM_MATRIX_PROCESSOR);
}
