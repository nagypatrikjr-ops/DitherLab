import type {
  ParamSchema,
  ParamsOf,
  PixelBuffer,
  Processor,
  RenderContext,
} from '../../types';
import { likeBuffer, toColorSpace } from '../../buffer';
import { Rng, temporalSeed } from '../../rng';
import { register } from '../registry';
import {
  DIFFUSION_PARAMS,
  QUANT_PARAMS,
  SCALE_PARAMS,
  THRESHOLD_PARAMS,
} from '../common/params';
import { makeQuantizer, type ColorMode } from '../common/quantize';
import { withPixelScale } from '../common/scale';
import { rowDirection } from '../common/walk';
import {
  KERNELS,
  kernelFromMatrix,
  type DiffusionKernel,
} from './kernels';

const ED_SCHEMA = {
  ...SCALE_PARAMS,
  ...QUANT_PARAMS,
  ...DIFFUSION_PARAMS,
  ...THRESHOLD_PARAMS,
} as const satisfies ParamSchema;

const CUSTOM_SCHEMA = {
  ...ED_SCHEMA,
  matrix: {
    kind: 'matrix',
    label: 'Hibaterjesztő mátrix',
    rows: 3,
    cols: 5,
    // Floyd–Steinberg as the starting point; centre of row 0 is the current pixel.
    default: [0, 0, 0, 7, 0, 0, 3, 5, 1, 0, 0, 0, 0, 0, 0],
    group: 'Hibaterjesztés',
  },
} as const satisfies ParamSchema;

type EdParams = ParamsOf<typeof ED_SCHEMA>;

/**
 * The single error-diffusion engine. Every kernel in the library runs through
 * this function, which is why `diffusionStrength`, `errorJitter`, serpentine
 * scanning and the three colour modes behave identically everywhere.
 */
export function runErrorDiffusion(
  grid: PixelBuffer,
  kernel: DiffusionKernel,
  params: EdParams,
  ctx: RenderContext,
  layerSeed: number,
): PixelBuffer {
  const w = grid.width;
  const h = grid.height;
  const out = likeBuffer(grid);
  const src = grid.data;
  const dst = out.data;

  // Working copy holding the running error, RGB only.
  const work = new Float32Array(w * h * 3);
  for (let p = 0, q = 0; p < w * h; p++, q += 4) {
    work[p * 3] = src[q];
    work[p * 3 + 1] = src[q + 1];
    work[p * 3 + 2] = src[q + 2];
  }

  const quant = makeQuantizer(
    params.colorMode as ColorMode,
    ctx.palette,
    ctx.distance,
    params.colorDepth,
    grid.colorSpace,
  );

  const strength = params.diffusionStrength / kernel.divisor;
  const jitter = params.errorJitter;
  const rng = new Rng(layerSeed);
  const thr = params.threshold;
  const thrJitter = params.thresholdJitter;
  const entries = kernel.entries;
  const nEntries = entries.length;
  const tmp = new Float32Array(3);

  const dxs = new Int32Array(nEntries);
  const dys = new Int32Array(nEntries);
  const ws = new Float32Array(nEntries);
  for (let i = 0; i < nEntries; i++) {
    dxs[i] = entries[i].dx;
    dys[i] = entries[i].dy;
    ws[i] = entries[i].w;
  }

  for (let y = 0; y < h; y++) {
    const dir = rowDirection(y, params.serpentine);
    const xStart = dir === 1 ? 0 : w - 1;
    const xEnd = dir === 1 ? w : -1;

    for (let x = xStart; x !== xEnd; x += dir) {
      const p = (y * w + x) * 3;
      let bias = thr;
      if (thrJitter > 0) bias += rng.nextSigned() * thrJitter * 0.5;

      const r = work[p] + bias;
      const g = work[p + 1] + bias;
      const b = work[p + 2] + bias;

      quant.quantize(r, g, b, tmp, 0);

      const er = (r - tmp[0]) * strength;
      const eg = (g - tmp[1]) * strength;
      const eb = (b - tmp[2]) * strength;

      const o = (y * w + x) * 4;
      dst[o] = tmp[0];
      dst[o + 1] = tmp[1];
      dst[o + 2] = tmp[2];
      dst[o + 3] = src[o + 3];

      for (let i = 0; i < nEntries; i++) {
        const nx = x + dxs[i] * dir;
        if (nx < 0 || nx >= w) continue;
        const ny = y + dys[i];
        if (ny >= h) continue;
        let weight = ws[i];
        if (jitter > 0) weight *= 1 + rng.nextSigned() * jitter;
        const np = (ny * w + nx) * 3;
        work[np] += er * weight;
        work[np + 1] += eg * weight;
        work[np + 2] += eb * weight;
      }
    }

    if (ctx.progress && (y & 63) === 0) ctx.progress(y / h);
    if (ctx.signal?.aborted) break;
  }

  return out;
}

function makeProcessor(kernel: DiffusionKernel): Processor<typeof ED_SCHEMA> {
  return {
    id: `ed:${kernel.id}`,
    name: kernel.name,
    category: 'errorDiffusion',
    params: ED_SCHEMA,
    supportsColor: true,
    vectorizable: true,
    apply(input, params, ctx) {
      const layerSeed = temporalSeed(
        ctx.seed ^ (params.seed >>> 0),
        `ed:${kernel.id}`,
        ctx.frame,
        ctx.noiseMode,
        ctx.cycleLength,
      );
      const space = params.gammaCorrect && ctx.gammaCorrect ? 'linear' : 'srgb';
      return withPixelScale(input, params, ctx, (grid) => {
        const working = toColorSpace(grid, space);
        const result = runErrorDiffusion(working, kernel, params, ctx, layerSeed);
        return toColorSpace(result, grid.colorSpace);
      });
    },
  };
}

const CUSTOM_PROCESSOR: Processor<typeof CUSTOM_SCHEMA> = {
  id: 'ed:custom',
  name: 'Egyedi hibaterjesztés',
  category: 'errorDiffusion',
  params: CUSTOM_SCHEMA,
  supportsColor: true,
  vectorizable: true,
  apply(input, params, ctx) {
    const kernel = kernelFromMatrix(params.matrix, 5, 3);
    const layerSeed = temporalSeed(
      ctx.seed ^ (params.seed >>> 0),
      'ed:custom',
      ctx.frame,
      ctx.noiseMode,
      ctx.cycleLength,
    );
    const space = params.gammaCorrect && ctx.gammaCorrect ? 'linear' : 'srgb';
    return withPixelScale(input, params, ctx, (grid) => {
      const working = toColorSpace(grid, space);
      const result = runErrorDiffusion(working, kernel, params, ctx, layerSeed);
      return toColorSpace(result, grid.colorSpace);
    });
  },
};

export function registerErrorDiffusion(): void {
  for (const kernel of KERNELS) register(makeProcessor(kernel));
  register(CUSTOM_PROCESSOR);
  register(RIEMERSMA);
}

// ---------------------------------------------------------------------------
// Riemersma (Hilbert curve) dithering
// ---------------------------------------------------------------------------

const RIEMERSMA_SCHEMA = {
  ...SCALE_PARAMS,
  ...QUANT_PARAMS,
  ...THRESHOLD_PARAMS,
  queueSize: {
    kind: 'int',
    label: 'Hiba-sor hossza',
    min: 2,
    max: 64,
    default: 16,
    group: 'Görbe',
  },
  decayRatio: {
    kind: 'float',
    label: 'Lecsengés aránya',
    min: 1.5,
    max: 64,
    step: 0.5,
    default: 16,
    curve: 'log',
    group: 'Görbe',
  },
} as const satisfies ParamSchema;

/**
 * Riemersma dithering walks a Hilbert curve instead of scan lines, so the
 * error stays spatially local in both axes and the result has no directional
 * grain. The Hilbert traversal is exact; the error weighting is the documented
 * exponential decay over the last `queueSize` samples, with the oldest sample
 * weighted 1/decayRatio relative to the newest. (This is a parameterisation of
 * the published scheme, not a reproduction of one specific constant table.)
 */
const RIEMERSMA: Processor<typeof RIEMERSMA_SCHEMA> = {
  id: 'ed:riemersma',
  name: 'Riemersma (Hilbert-görbe)',
  category: 'errorDiffusion',
  params: RIEMERSMA_SCHEMA,
  supportsColor: true,
  vectorizable: true,
  apply(input, params, ctx) {
    const layerSeed = temporalSeed(
      ctx.seed ^ (params.seed >>> 0),
      'ed:riemersma',
      ctx.frame,
      ctx.noiseMode,
      ctx.cycleLength,
    );
    const space = params.gammaCorrect && ctx.gammaCorrect ? 'linear' : 'srgb';
    return withPixelScale(input, params, ctx, (grid) => {
      const working = toColorSpace(grid, space);
      const result = riemersma(working, params, ctx, layerSeed);
      return toColorSpace(result, grid.colorSpace);
    });
  },
};

function riemersma(
  grid: PixelBuffer,
  params: ParamsOf<typeof RIEMERSMA_SCHEMA>,
  ctx: RenderContext,
  layerSeed: number,
): PixelBuffer {
  const w = grid.width;
  const h = grid.height;
  const out = likeBuffer(grid);
  const src = grid.data;
  const dst = out.data;

  const quant = makeQuantizer(
    params.colorMode as ColorMode,
    ctx.palette,
    ctx.distance,
    params.colorDepth,
    grid.colorSpace,
  );

  const n = Math.max(2, params.queueSize);
  const ratio = Math.max(1.5, params.decayRatio);
  // weight[i] with i = 0 (oldest) .. n-1 (newest); newest is `ratio` times
  // stronger than the oldest, normalised to sum to 1.
  const weights = new Float32Array(n);
  let wsum = 0;
  for (let i = 0; i < n; i++) {
    weights[i] = Math.pow(ratio, i / (n - 1));
    wsum += weights[i];
  }
  for (let i = 0; i < n; i++) weights[i] /= wsum;

  const qr = new Float32Array(n);
  const qg = new Float32Array(n);
  const qb = new Float32Array(n);
  let head = 0;

  const rng = new Rng(layerSeed);
  const tmp = new Float32Array(3);
  const thr = params.threshold;
  const thrJitter = params.thresholdJitter;

  // Cover the image with the smallest power-of-two Hilbert grid and skip the
  // cells that fall outside; the visited order inside the image is unchanged.
  let order = 0;
  while (1 << order < Math.max(w, h)) order++;
  const side = 1 << order;
  const total = side * side;

  for (let d = 0; d < total; d++) {
    // Inline Hilbert d2xy for speed.
    let rx = 0;
    let ry = 0;
    let t = d;
    let x = 0;
    let y = 0;
    for (let s = 1; s < side; s <<= 1) {
      rx = 1 & (t >> 1);
      ry = 1 & (t ^ rx);
      if (ry === 0) {
        if (rx === 1) {
          x = s - 1 - x;
          y = s - 1 - y;
        }
        const sw = x;
        x = y;
        y = sw;
      }
      x += s * rx;
      y += s * ry;
      t >>= 2;
    }
    if (x >= w || y >= h) continue;

    let cr = 0;
    let cg = 0;
    let cb = 0;
    for (let i = 0; i < n; i++) {
      const idx = (head + i) % n;
      cr += qr[idx] * weights[i];
      cg += qg[idx] * weights[i];
      cb += qb[idx] * weights[i];
    }

    let bias = thr;
    if (thrJitter > 0) bias += rng.nextSigned() * thrJitter * 0.5;

    const p = (y * w + x) * 4;
    const r = src[p] + cr + bias;
    const g = src[p + 1] + cg + bias;
    const b = src[p + 2] + cb + bias;

    quant.quantize(r, g, b, tmp, 0);
    dst[p] = tmp[0];
    dst[p + 1] = tmp[1];
    dst[p + 2] = tmp[2];
    dst[p + 3] = src[p + 3];

    qr[head] = r - tmp[0];
    qg[head] = g - tmp[1];
    qb[head] = b - tmp[2];
    head = (head + 1) % n;

    if (ctx.signal?.aborted) break;
  }
  return out;
}
