import type { ParamSchema, ParamsOf, PixelBuffer, Processor, RenderContext } from '../../types';
import { likeBuffer } from '../../buffer';
import { hashNoise2D, temporalSeed } from '../../rng';
import { register } from '../registry';
import { SCALE_PARAMS } from '../common/params';
import { residualDivisor, withPixelScale } from '../common/scale';
import { applyDotGain, dotThreshold, type DotShape, type ShapeOptions } from './shapes';

const SHAPE_OPTIONS = [
  { value: 'round', label: 'Kerek pont' },
  { value: 'square', label: 'Négyzet' },
  { value: 'ellipse', label: 'Ellipszis' },
  { value: 'diamond', label: 'Rombusz' },
  { value: 'euclidean', label: 'Euklideszi pont' },
  { value: 'line', label: 'Vonalraszter' },
  { value: 'cross', label: 'Keresztraszter' },
  { value: 'concentric', label: 'Koncentrikus kör' },
  { value: 'wavy', label: 'Hullámos vonal' },
  { value: 'stochastic', label: 'Sztochasztikus (FM)' },
  { value: 'newsprint', label: 'Újságnyomat' },
] as const;

const HALFTONE_SCHEMA = {
  ...SCALE_PARAMS,
  separation: {
    kind: 'enum',
    label: 'Színbontás',
    options: [
      { value: 'cmyk', label: 'CMYK' },
      { value: 'mono', label: 'Monokróm (K)' },
      { value: 'rgb', label: 'RGB csatornák' },
    ],
    default: 'cmyk',
    group: 'Raszter',
  },
  dotShape: {
    kind: 'enum',
    label: 'Pont alakja',
    options: SHAPE_OPTIONS,
    default: 'round',
    group: 'Raszter',
  },
  frequency: {
    kind: 'float',
    label: 'Rácssűrűség',
    min: 5,
    max: 200,
    step: 1,
    default: 45,
    unit: 'LPI',
    group: 'Raszter',
  },
  outputDpi: {
    kind: 'float',
    label: 'Kimeneti felbontás',
    min: 72,
    max: 1200,
    step: 1,
    default: 300,
    unit: 'DPI',
    group: 'Raszter',
  },
  angleC: { kind: 'angle', label: 'Cián szög', default: 15, group: 'Szögek' },
  angleM: { kind: 'angle', label: 'Bíbor szög', default: 75, group: 'Szögek' },
  angleY: { kind: 'angle', label: 'Sárga szög', default: 0, group: 'Szögek' },
  angleK: { kind: 'angle', label: 'Fekete szög', default: 45, group: 'Szögek' },
  dotGain: {
    kind: 'float',
    label: 'Pontnövekedés',
    min: -0.5,
    max: 0.8,
    step: 0.01,
    default: 0.08,
    group: 'Nyomtatás',
  },
  sharpness: {
    kind: 'float',
    label: 'Élesség',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1,
    group: 'Nyomtatás',
  },
  overprint: {
    kind: 'float',
    label: 'Átnyomás',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1,
    group: 'Nyomtatás',
  },
  paperTint: {
    kind: 'color',
    label: 'Papírszín',
    default: { r: 1, g: 0.996, b: 0.98 },
    group: 'Nyomtatás',
  },
  rings: { kind: 'float', label: 'Gyűrűk száma', min: 1, max: 12, step: 0.5, default: 3, group: 'Alakzat' },
  waveAmplitude: {
    kind: 'float', label: 'Hullám amplitúdó', min: 0, max: 0.5, step: 0.01, default: 0.18, group: 'Alakzat',
  },
  waveFrequency: {
    kind: 'float', label: 'Hullám frekvencia', min: 0.5, max: 8, step: 0.5, default: 2, group: 'Alakzat',
  },
  seed: { kind: 'seed', label: 'Seed', default: 1, group: 'Alakzat' },
} as const satisfies ParamSchema;

type HalftoneParams = ParamsOf<typeof HALFTONE_SCHEMA>;

/** Process ink transmittances, as screen approximations of the four inks. */
const INK_C: readonly [number, number, number] = [0.0, 0.682, 0.937];
const INK_M: readonly [number, number, number] = [0.925, 0.0, 0.549];
const INK_Y: readonly [number, number, number] = [1.0, 0.949, 0.0];
const INK_K: readonly [number, number, number] = [0.05, 0.05, 0.05];

interface Screen {
  cos: number;
  sin: number;
  ink: readonly [number, number, number];
}

function makeScreen(angleDeg: number, ink: readonly [number, number, number]): Screen {
  const rad = (angleDeg * Math.PI) / 180;
  return { cos: Math.cos(rad), sin: Math.sin(rad), ink };
}

/**
 * Coverage of one screen at a pixel. `sharpness` controls the width of the
 * transition band: 1 gives a hard binary dot, lower values antialias the edge
 * which is what makes low-frequency screens look printed rather than jagged.
 */
function screenCoverage(
  x: number,
  y: number,
  tone: number,
  screen: Screen,
  cellPx: number,
  shape: DotShape,
  shapeOpts: ShapeOptions,
  sharpness: number,
  seed: number,
): number {
  if (shape === 'stochastic') {
    // FM screening: a per-cell blue-ish noise threshold instead of a dot.
    const u = (x * screen.cos + y * screen.sin) / Math.max(0.5, cellPx * 0.35);
    const v = (-x * screen.sin + y * screen.cos) / Math.max(0.5, cellPx * 0.35);
    const t = hashNoise2D(Math.floor(u), Math.floor(v), seed);
    return tone > t ? 1 : 0;
  }

  const u = (x * screen.cos + y * screen.sin) / cellPx;
  const v = (-x * screen.sin + y * screen.cos) / cellPx;
  const fu = u - Math.floor(u) - 0.5;
  const fv = v - Math.floor(v) - 0.5;
  const t = dotThreshold(shape, fu, fv, shapeOpts);

  if (sharpness >= 0.999) return tone > t ? 1 : 0;
  const band = (1 - sharpness) * 0.5 + 0.004;
  const e = (tone - t) / band;
  return e <= -1 ? 0 : e >= 1 ? 1 : (e + 1) * 0.5;
}

function runHalftone(
  grid: PixelBuffer,
  params: HalftoneParams,
  ctx: RenderContext,
  layerSeed: number,
): PixelBuffer {
  const w = grid.width;
  const h = grid.height;
  const out = likeBuffer(grid);
  const src = grid.data;
  const dst = out.data;

  // Cell size in pixels, on the (possibly collapsed) dither grid. Only the
  // residual part of the proxy divisor applies here.
  const cellPx = Math.max(
    1.2,
    params.outputDpi /
      Math.max(1, params.frequency) /
      residualDivisor(params.pixelScale, ctx.resolutionDivisor),
  );

  const shape = params.dotShape as DotShape;
  const shapeOpts: ShapeOptions = {
    rings: params.rings,
    waveAmplitude: params.waveAmplitude,
    waveFrequency: params.waveFrequency,
  };
  const sharp = params.sharpness;
  const gain = params.dotGain;
  const over = params.overprint;
  const paper = params.paperTint;

  const sc = makeScreen(params.angleC, INK_C);
  const sm = makeScreen(params.angleM, INK_M);
  const sy = makeScreen(params.angleY, INK_Y);
  const sk = makeScreen(params.angleK, INK_K);
  const mode = params.separation;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = src[i];
      const g = src[i + 1];
      const b = src[i + 2];

      let cr = paper.r;
      let cg = paper.g;
      let cb = paper.b;

      const lay = (
        coverage: number,
        ink: readonly [number, number, number],
      ): void => {
        if (coverage <= 0) return;
        // Multiply (true subtractive overprint) vs. opaque (top ink wins).
        const mr = cr * (1 - coverage + coverage * ink[0]);
        const mg = cg * (1 - coverage + coverage * ink[1]);
        const mb = cb * (1 - coverage + coverage * ink[2]);
        const or_ = cr + (ink[0] - cr) * coverage;
        const og = cg + (ink[1] - cg) * coverage;
        const ob = cb + (ink[2] - cb) * coverage;
        cr = or_ + (mr - or_) * over;
        cg = og + (mg - og) * over;
        cb = ob + (mb - ob) * over;
      };

      if (mode === 'mono') {
        const k = applyDotGain(1 - (0.299 * r + 0.587 * g + 0.114 * b), gain);
        lay(screenCoverage(x, y, k, sk, cellPx, shape, shapeOpts, sharp, layerSeed), INK_K);
      } else if (mode === 'rgb') {
        lay(
          screenCoverage(x, y, applyDotGain(1 - r, gain), sc, cellPx, shape, shapeOpts, sharp, layerSeed),
          [0, 1, 1],
        );
        lay(
          screenCoverage(x, y, applyDotGain(1 - g, gain), sm, cellPx, shape, shapeOpts, sharp, layerSeed + 1),
          [1, 0, 1],
        );
        lay(
          screenCoverage(x, y, applyDotGain(1 - b, gain), sy, cellPx, shape, shapeOpts, sharp, layerSeed + 2),
          [1, 1, 0],
        );
      } else {
        const k0 = 1 - Math.max(r, g, b);
        const inv = k0 < 0.999 ? 1 / (1 - k0) : 0;
        const c0 = k0 < 0.999 ? (1 - r - k0) * inv : 0;
        const m0 = k0 < 0.999 ? (1 - g - k0) * inv : 0;
        const y0 = k0 < 0.999 ? (1 - b - k0) * inv : 0;

        lay(
          screenCoverage(x, y, applyDotGain(c0, gain), sc, cellPx, shape, shapeOpts, sharp, layerSeed),
          INK_C,
        );
        lay(
          screenCoverage(x, y, applyDotGain(m0, gain), sm, cellPx, shape, shapeOpts, sharp, layerSeed + 1),
          INK_M,
        );
        lay(
          screenCoverage(x, y, applyDotGain(y0, gain), sy, cellPx, shape, shapeOpts, sharp, layerSeed + 2),
          INK_Y,
        );
        lay(
          screenCoverage(x, y, applyDotGain(k0, gain), sk, cellPx, shape, shapeOpts, sharp, layerSeed + 3),
          INK_K,
        );
      }

      dst[i] = cr;
      dst[i + 1] = cg;
      dst[i + 2] = cb;
      dst[i + 3] = src[i + 3];
    }
    if (ctx.progress && (y & 127) === 0) ctx.progress(y / h);
    if (ctx.signal?.aborted) break;
  }
  return out;
}

const HALFTONE: Processor<typeof HALFTONE_SCHEMA> = {
  id: 'ht:halftone',
  name: 'Halftone raszter',
  category: 'halftone',
  params: HALFTONE_SCHEMA,
  supportsColor: true,
  vectorizable: false,
  apply(input, params, ctx) {
    const layerSeed = temporalSeed(
      ctx.seed ^ (params.seed >>> 0),
      'ht:halftone',
      ctx.frame,
      ctx.noiseMode,
      ctx.cycleLength,
    );
    return withPixelScale(input, params, ctx, (grid) => runHalftone(grid, params, ctx, layerSeed));
  },
};

export function registerHalftone(): void {
  register(HALFTONE);
}
