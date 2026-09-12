import type {
  ColorSpace, ParamSchema, ParamsOf, PixelBuffer, Processor, RenderContext,
} from '../../types';
import { likeBuffer, toColorSpace } from '../../buffer';
import { temporalSeed } from '../../rng';
import { lumaSrgb } from '../../color/space';
import { register } from '../registry';
import { QUANT_PARAMS, SCALE_PARAMS, THRESHOLD_PARAMS } from '../common/params';
import { makeQuantizer, monoEndpoints, type ColorMode } from '../common/quantize';
import { residualDivisor, withPixelScale } from '../common/scale';
import { bayer } from '../ordered/matrices';
import { estimatePaletteSpread } from '../ordered';
import { getSimplex } from './noise';
import { getGlyphAtlas, glyphDensities } from './font';

const BAYER8 = bayer(8);

function amplitudeFor(
  mode: ColorMode, ctx: RenderContext, colorDepth: number, space: ColorSpace,
): number {
  if (mode === 'perChannel') return 1 / Math.max(1, colorDepth - 1);
  if (mode === 'palette' && ctx.palette) return estimatePaletteSpread(ctx.palette, space);
  return 1;
}

// ---------------------------------------------------------------------------
// 1. Modulated threshold
// ---------------------------------------------------------------------------

const MOD_SCHEMA = {
  ...SCALE_PARAMS,
  ...QUANT_PARAMS,
  ...THRESHOLD_PARAMS,
  modulation: {
    kind: 'enum',
    label: 'Moduláció',
    options: [
      { value: 'wave', label: 'Szinuszos hullám' },
      { value: 'radial', label: 'Sugárirányú' },
      { value: 'spiral', label: 'Spirál' },
      { value: 'perlin', label: 'Perlin / simplex zaj' },
      { value: 'luminance', label: 'Luminancia-vezérelt' },
      { value: 'drift', label: 'Sodródó rács' },
    ],
    default: 'wave',
    group: 'Moduláció',
  },
  frequency: {
    kind: 'float', label: 'Frekvencia', min: 0.2, max: 64, step: 0.1, default: 6, curve: 'log', group: 'Moduláció',
  },
  amplitude: {
    kind: 'float', label: 'Amplitúdó', min: 0, max: 2, step: 0.01, default: 1, group: 'Moduláció',
  },
  uniformize: {
    kind: 'bool', label: 'Tónushű küszöbmező', default: true, group: 'Moduláció',
  },
  angle: { kind: 'angle', label: 'Irány', default: 0, group: 'Moduláció' },
  octaves: { kind: 'int', label: 'Oktávok', min: 1, max: 6, default: 3, group: 'Moduláció' },
  driftSpeed: {
    kind: 'float', label: 'Sodródás / képkocka', min: -8, max: 8, step: 0.05, default: 0.5, group: 'Moduláció',
  },
  blendBayer: {
    // A pure wave or ring field only has a handful of distinct levels, which
    // quantises the tone range. Mixing in Bayer restores the level count.
    kind: 'float', label: 'Bayer alapréteg', min: 0, max: 1, step: 0.01, default: 0.35, group: 'Moduláció',
  },
  spread: {
    kind: 'float', label: 'Szórás erőssége', min: 0, max: 3, step: 0.01, default: 1, group: 'Szín',
  },
} as const satisfies ParamSchema;

type ModParams = ParamsOf<typeof MOD_SCHEMA>;

/**
 * Flattens a threshold field to a uniform distribution on [0,1].
 *
 * A dither threshold only reproduces tone correctly if its values are
 * uniformly distributed: the fraction of pixels above a level v must equal
 * 1 - v. Sine waves (arcsine distributed) and fBm noise (roughly Gaussian) are
 * not, so using them raw crushes the midtones to solid black. This builds the
 * field's own CDF from a subsample and remaps through it, which makes any
 * modulation shape tonally correct while leaving its structure intact.
 */
function uniformizeField(field: Float32Array): void {
  const BINS = 1024;
  const n = field.length;
  const stride = Math.max(1, Math.floor(n / 65536));

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i += stride) {
    const v = field[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  if (!(range > 1e-9)) {
    field.fill(0.5);
    return;
  }

  const hist = new Float64Array(BINS);
  let samples = 0;
  for (let i = 0; i < n; i += stride) {
    const b = Math.min(BINS - 1, Math.floor(((field[i] - min) / range) * BINS));
    hist[b] += 1;
    samples++;
  }

  // Mid-rank CDF: a bin maps to the centre of the range it occupies, so a
  // field with k distinct levels lands on (i + 0.5) / k rather than on the
  // left edges, which would bias the whole image dark.
  const cdf = new Float32Array(BINS + 1);
  let acc = 0;
  for (let b = 0; b < BINS; b++) {
    cdf[b] = (acc + hist[b] * 0.5) / samples;
    acc += hist[b];
  }
  cdf[BINS] = 1;

  for (let i = 0; i < n; i++) {
    const t = ((field[i] - min) / range) * BINS;
    const b = Math.min(BINS - 1, Math.max(0, Math.floor(t)));
    const frac = t - b;
    field[i] = cdf[b] + (cdf[b + 1] - cdf[b]) * frac;
  }
}

function modulatedThreshold(
  grid: PixelBuffer,
  params: ModParams,
  ctx: RenderContext,
  layerSeed: number,
): PixelBuffer {
  const w = grid.width;
  const h = grid.height;
  const out = likeBuffer(grid);
  const src = grid.data;
  const dst = out.data;

  const mode = params.colorMode as ColorMode;
  const space = grid.colorSpace;
  const quant = makeQuantizer(mode, ctx.palette, ctx.distance, params.colorDepth, space);
  const amp = amplitudeFor(mode, ctx, params.colorDepth, space) * params.spread;

  const div = residualDivisor(params.pixelScale, ctx.resolutionDivisor);
  const freq = (params.frequency / div) * 0.05;
  const rad = (params.angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = w * 0.5;
  const cy = h * 0.5;
  const simplex = getSimplex(layerSeed);
  const drift = (params.driftSpeed * ctx.frame) / div;
  const bayerMix = params.blendBayer;
  const kind = params.modulation;

  /** Triangle wave of a phase in turns: uniform on [0,1] for a uniform phase. */
  const tri = (phase: number): number => {
    const f = phase - Math.floor(phase);
    return f < 0.5 ? f * 2 : 2 - f * 2;
  };

  // Pass 1: build the threshold field.
  const field = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const i = p * 4;
      const u = x * cos + y * sin;
      const v = -x * sin + y * cos;

      let m: number;
      switch (kind) {
        case 'wave':
          m = tri(u * freq);
          break;
        case 'radial': {
          const dx = x - cx;
          const dy = y - cy;
          m = tri(Math.sqrt(dx * dx + dy * dy) * freq);
          break;
        }
        case 'spiral': {
          const dx = x - cx;
          const dy = y - cy;
          const r = Math.sqrt(dx * dx + dy * dy);
          const a = Math.atan2(dy, dx) / (2 * Math.PI);
          m = tri(r * freq + a * 3);
          break;
        }
        case 'perlin':
          m = simplex.fbm(u * freq, v * freq, params.octaves) * 0.5 + 0.5;
          break;
        case 'luminance': {
          const l = lumaSrgb(src[i], src[i + 1], src[i + 2]);
          m = tri(u * freq + l * 4);
          break;
        }
        case 'drift': {
          const du = u + drift;
          const dv = v + drift * 0.37;
          const bx = ((Math.floor(du) % 8) + 8) % 8;
          const by = ((Math.floor(dv) % 8) + 8) % 8;
          m = BAYER8.data[by * 8 + bx];
          break;
        }
      }

      if (bayerMix > 0 && kind !== 'drift') {
        m = m * (1 - bayerMix) + BAYER8.data[(y & 7) * 8 + (x & 7)] * bayerMix;
      }
      field[p] = m;
    }
  }

  if (params.uniformize) uniformizeField(field);

  // Pass 2: quantise against the field.
  const tmp = new Float32Array(3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const i = p * 4;
      const kick = (field[p] - 0.5) * amp * params.amplitude + params.threshold;
      quant.quantize(src[i] + kick, src[i + 1] + kick, src[i + 2] + kick, tmp, 0);
      dst[i] = tmp[0];
      dst[i + 1] = tmp[1];
      dst[i + 2] = tmp[2];
      dst[i + 3] = src[i + 3];
    }
    if (ctx.signal?.aborted) break;
  }
  return out;
}

const MODULATED: Processor<typeof MOD_SCHEMA> = {
  id: 'mod:threshold',
  name: 'Modulált küszöb',
  category: 'modulated',
  params: MOD_SCHEMA,
  supportsColor: true,
  vectorizable: true,
  apply(input, params, ctx) {
    const seed = temporalSeed(
      ctx.seed ^ (params.seed >>> 0), 'mod:threshold', ctx.frame, ctx.noiseMode, ctx.cycleLength,
    );
    const space = params.gammaCorrect && ctx.gammaCorrect ? 'linear' : 'srgb';
    return withPixelScale(input, params, ctx, (grid) => {
      const working = toColorSpace(grid, space);
      return toColorSpace(modulatedThreshold(working, params, ctx, seed), grid.colorSpace);
    });
  },
};

// ---------------------------------------------------------------------------
// 2. Character (ASCII) dither
// ---------------------------------------------------------------------------

const ASCII_SCHEMA = {
  charset: {
    kind: 'text',
    label: 'Karakterkészlet (világostól sötétig)',
    default: ' .:-=+*#%@',
    group: 'Karakterek',
  },
  fontFamily: {
    kind: 'text', label: 'Betűtípus', default: 'monospace', group: 'Karakterek',
  },
  cellWidth: { kind: 'int', label: 'Cella szélesség', min: 3, max: 64, default: 8, group: 'Karakterek' },
  cellHeight: { kind: 'int', label: 'Cella magasság', min: 3, max: 64, default: 12, group: 'Karakterek' },
  invert: { kind: 'bool', label: 'Invertálás', default: false, group: 'Karakterek' },
  autoOrder: {
    kind: 'bool', label: 'Automatikus sűrűség-sorrend', default: true, group: 'Karakterek',
  },
  colorFromSource: {
    kind: 'bool', label: 'Karakter színe a képből', default: false, group: 'Karakterek',
  },
  ...THRESHOLD_PARAMS,
} as const satisfies ParamSchema;

const ASCII: Processor<typeof ASCII_SCHEMA> = {
  id: 'mod:ascii',
  name: 'Karakteres (ASCII) dither',
  category: 'modulated',
  params: ASCII_SCHEMA,
  supportsColor: true,
  vectorizable: false,
  apply(input, params, ctx) {
    const div = Math.max(1, ctx.resolutionDivisor);
    const cw = Math.max(2, Math.round(params.cellWidth / div));
    const ch = Math.max(2, Math.round(params.cellHeight / div));
    const atlas = getGlyphAtlas(params.charset, cw, ch, params.fontFamily);
    const densities = glyphDensities(atlas);

    let order: number[] = Array.from(densities, (_, i) => i);
    if (params.autoOrder) {
      order = [...order].sort((a, b) => densities[a] - densities[b] || a - b);
    }

    const { dark, light } = monoEndpoints(ctx.palette, input.colorSpace);
    const w = input.width;
    const h = input.height;
    const out = likeBuffer(input);
    const src = input.data;
    const dst = out.data;
    const cols = Math.ceil(w / atlas.cellW);
    const rows = Math.ceil(h / atlas.cellH);
    const per = atlas.cellW * atlas.cellH;
    const n = order.length;

    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        // Mean tone and mean colour of the cell.
        let sum = 0;
        let sr = 0;
        let sg = 0;
        let sb = 0;
        let count = 0;
        for (let y = cy * atlas.cellH; y < Math.min(h, (cy + 1) * atlas.cellH); y++) {
          for (let x = cx * atlas.cellW; x < Math.min(w, (cx + 1) * atlas.cellW); x++) {
            const i = (y * w + x) * 4;
            sum += lumaSrgb(src[i], src[i + 1], src[i + 2]);
            sr += src[i];
            sg += src[i + 1];
            sb += src[i + 2];
            count++;
          }
        }
        if (count === 0) continue;
        let tone = sum / count + params.threshold;
        if (params.invert) tone = 1 - tone;
        tone = tone < 0 ? 0 : tone > 1 ? 1 : tone;

        // Dark tone -> dense glyph, so index by inverted tone.
        const gi = order[Math.min(n - 1, Math.max(0, Math.round((1 - tone) * (n - 1))))];

        const fr = params.colorFromSource ? sr / count : dark[0];
        const fg = params.colorFromSource ? sg / count : dark[1];
        const fb = params.colorFromSource ? sb / count : dark[2];

        for (let y = 0; y < atlas.cellH; y++) {
          const py = cy * atlas.cellH + y;
          if (py >= h) break;
          for (let x = 0; x < atlas.cellW; x++) {
            const px = cx * atlas.cellW + x;
            if (px >= w) break;
            const cov = atlas.coverage[gi * per + y * atlas.cellW + x];
            const i = (py * w + px) * 4;
            dst[i] = light[0] + (fr - light[0]) * cov;
            dst[i + 1] = light[1] + (fg - light[1]) * cov;
            dst[i + 2] = light[2] + (fb - light[2]) * cov;
            dst[i + 3] = src[i + 3];
          }
        }
      }
      if (ctx.signal?.aborted) break;
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// 3. Shape dither: a glyph whose size follows tone
// ---------------------------------------------------------------------------

const SHAPE_SCHEMA = {
  shape: {
    kind: 'enum',
    label: 'Alakzat',
    options: [
      { value: 'circle', label: 'Kör' },
      { value: 'square', label: 'Négyzet' },
      { value: 'triangle', label: 'Háromszög' },
      { value: 'diamond', label: 'Rombusz' },
      { value: 'cross', label: 'Kereszt' },
      { value: 'ring', label: 'Gyűrű' },
      { value: 'star', label: 'Csillag' },
    ],
    default: 'circle',
    group: 'Alakzat',
  },
  cellSize: { kind: 'float', label: 'Cella méret', min: 2, max: 128, step: 0.5, default: 12, group: 'Alakzat' },
  rotation: { kind: 'angle', label: 'Rácselforgatás', default: 0, group: 'Alakzat' },
  spin: { kind: 'angle', label: 'Alakzat forgatás', default: 0, group: 'Alakzat' },
  minSize: { kind: 'float', label: 'Minimum méret', min: 0, max: 1, step: 0.01, default: 0, group: 'Alakzat' },
  maxSize: { kind: 'float', label: 'Maximum méret', min: 0.1, max: 1.6, step: 0.01, default: 1.15, group: 'Alakzat' },
  invert: { kind: 'bool', label: 'Invertálás', default: false, group: 'Alakzat' },
  softness: { kind: 'float', label: 'Lágyság', min: 0, max: 1, step: 0.01, default: 0, group: 'Alakzat' },
  ...THRESHOLD_PARAMS,
} as const satisfies ParamSchema;

/** Signed distance from the shape boundary; negative is inside. */
function shapeSdf(kind: string, x: number, y: number, r: number): number {
  switch (kind) {
    case 'square':
      return Math.max(Math.abs(x), Math.abs(y)) - r;
    case 'diamond':
      return (Math.abs(x) + Math.abs(y)) * 0.70710678 - r * 0.70710678;
    case 'triangle': {
      // Equilateral triangle pointing up.
      const k = 1.7320508;
      let px = Math.abs(x) - r;
      let py = y + r / k;
      if (px + k * py > 0) {
        const nx = (px - k * py) / 2;
        const ny = (-k * px - py) / 2;
        px = nx;
        py = ny;
      }
      px -= Math.min(Math.max(px, -2 * r), 0);
      return -Math.sqrt(px * px + py * py) * Math.sign(py);
    }
    case 'cross': {
      const a = Math.max(Math.abs(x) - r, Math.abs(y) - r * 0.32);
      const b = Math.max(Math.abs(x) - r * 0.32, Math.abs(y) - r);
      return Math.min(a, b);
    }
    case 'ring': {
      const d = Math.sqrt(x * x + y * y);
      return Math.abs(d - r * 0.72) - r * 0.28;
    }
    case 'star': {
      const a = Math.atan2(y, x);
      const d = Math.sqrt(x * x + y * y);
      const petals = 5;
      const rr = r * (0.62 + 0.38 * Math.cos(a * petals));
      return d - rr;
    }
    default:
      return Math.sqrt(x * x + y * y) - r;
  }
}

const SHAPE_DITHER: Processor<typeof SHAPE_SCHEMA> = {
  id: 'mod:shape',
  name: 'Alakzat-dither',
  category: 'modulated',
  params: SHAPE_SCHEMA,
  supportsColor: false,
  vectorizable: true,
  apply(input, params, ctx) {
    const div = Math.max(1, ctx.resolutionDivisor);
    const cell = Math.max(2, params.cellSize / div);
    const rad = (params.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const spin = (params.spin * Math.PI) / 180;
    const scos = Math.cos(spin);
    const ssin = Math.sin(spin);

    const { dark, light } = monoEndpoints(ctx.palette, input.colorSpace);
    const w = input.width;
    const h = input.height;
    const out = likeBuffer(input);
    const src = input.data;
    const dst = out.data;
    const soft = params.softness * cell * 0.5 + 0.5;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const u = (x * cos + y * sin) / cell;
        const v = (-x * sin + y * cos) / cell;
        const cu = Math.floor(u);
        const cv = Math.floor(v);

        // Tone is sampled at the cell centre in image space.
        const scx = (cu + 0.5) * cell;
        const scy = (cv + 0.5) * cell;
        const ix = Math.min(w - 1, Math.max(0, Math.round(scx * cos - scy * sin)));
        const iy = Math.min(h - 1, Math.max(0, Math.round(scx * sin + scy * cos)));
        const si = (iy * w + ix) * 4;
        let tone = lumaSrgb(src[si], src[si + 1], src[si + 2]) + params.threshold;
        if (!params.invert) tone = 1 - tone;
        tone = tone < 0 ? 0 : tone > 1 ? 1 : tone;

        const radius =
          (params.minSize + (params.maxSize - params.minSize) * Math.sqrt(tone)) * 0.5;

        let lx = (u - cu - 0.5);
        let ly = (v - cv - 0.5);
        const rx = lx * scos - ly * ssin;
        const ry = lx * ssin + ly * scos;
        lx = rx;
        ly = ry;

        const d = shapeSdf(params.shape, lx, ly, radius) * cell;
        const cov = soft <= 0.5 ? (d <= 0 ? 1 : 0) : Math.min(1, Math.max(0, 0.5 - d / soft));

        const i = (y * w + x) * 4;
        dst[i] = light[0] + (dark[0] - light[0]) * cov;
        dst[i + 1] = light[1] + (dark[1] - light[1]) * cov;
        dst[i + 2] = light[2] + (dark[2] - light[2]) * cov;
        dst[i + 3] = src[i + 3];
      }
      if (ctx.signal?.aborted) break;
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// 4. Quadtree / adaptive block dither
// ---------------------------------------------------------------------------

const QUADTREE_SCHEMA = {
  ...QUANT_PARAMS,
  ...THRESHOLD_PARAMS,
  minBlock: { kind: 'int', label: 'Legkisebb blokk', min: 1, max: 64, default: 4, group: 'Blokkok' },
  maxBlock: { kind: 'int', label: 'Legnagyobb blokk', min: 2, max: 256, default: 64, group: 'Blokkok' },
  variance: {
    kind: 'float', label: 'Felosztási küszöb', min: 0.0005, max: 0.2, step: 0.0005, default: 0.012,
    curve: 'log', group: 'Blokkok',
  },
  ditherInside: { kind: 'bool', label: 'Bayer a blokkokon belül', default: true, group: 'Blokkok' },
  showGrid: { kind: 'bool', label: 'Blokkhatárok', default: false, group: 'Blokkok' },
} as const satisfies ParamSchema;

const QUADTREE: Processor<typeof QUADTREE_SCHEMA> = {
  id: 'mod:quadtree',
  name: 'Quadtree blokk-dither',
  category: 'modulated',
  params: QUADTREE_SCHEMA,
  supportsColor: true,
  vectorizable: false,
  apply(input, params, ctx) {
    const w = input.width;
    const h = input.height;
    const out = likeBuffer(input);
    const src = input.data;
    const dst = out.data;
    const div = Math.max(1, ctx.resolutionDivisor);
    const minB = Math.max(1, Math.round(params.minBlock / div));
    const maxB = Math.max(minB, Math.round(params.maxBlock / div));

    const mode = params.colorMode as ColorMode;
    const quant = makeQuantizer(mode, ctx.palette, ctx.distance, params.colorDepth, input.colorSpace);
    const amp = amplitudeFor(mode, ctx, params.colorDepth, input.colorSpace);
    const tmp = new Float32Array(3);

    const stats = (x0: number, y0: number, size: number): [number, number, number, number] => {
      let sr = 0, sg = 0, sb = 0, sq = 0, n = 0;
      const x1 = Math.min(w, x0 + size);
      const y1 = Math.min(h, y0 + size);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * 4;
          const l = lumaSrgb(src[i], src[i + 1], src[i + 2]);
          sr += src[i];
          sg += src[i + 1];
          sb += src[i + 2];
          sq += l * l;
          n++;
        }
      }
      if (n === 0) return [0, 0, 0, 0];
      const mr = sr / n, mg = sg / n, mb = sb / n;
      const ml = lumaSrgb(mr, mg, mb);
      return [mr, mg, mb, Math.max(0, sq / n - ml * ml)];
    };

    const fill = (x0: number, y0: number, size: number, r: number, g: number, b: number): void => {
      const x1 = Math.min(w, x0 + size);
      const y1 = Math.min(h, y0 + size);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          let kick = params.threshold;
          if (params.ditherInside) {
            kick += (BAYER8.data[(y & 7) * 8 + (x & 7)] - 0.5) * amp;
          }
          quant.quantize(r + kick, g + kick, b + kick, tmp, 0);
          const i = (y * w + x) * 4;
          const edge =
            params.showGrid && (x === x0 || y === y0) ? 0.0 : 1.0;
          dst[i] = tmp[0] * edge;
          dst[i + 1] = tmp[1] * edge;
          dst[i + 2] = tmp[2] * edge;
          dst[i + 3] = src[i + 3];
        }
      }
    };

    const subdivide = (x0: number, y0: number, size: number): void => {
      if (x0 >= w || y0 >= h) return;
      const [r, g, b, varr] = stats(x0, y0, size);
      if (size <= minB || varr <= params.variance) {
        fill(x0, y0, size, r, g, b);
        return;
      }
      const half = size >> 1;
      if (half < 1) {
        fill(x0, y0, size, r, g, b);
        return;
      }
      subdivide(x0, y0, half);
      subdivide(x0 + half, y0, half);
      subdivide(x0, y0 + half, half);
      subdivide(x0 + half, y0 + half, half);
    };

    let root = 1;
    while (root < maxB) root <<= 1;
    for (let y = 0; y < h; y += root) {
      for (let x = 0; x < w; x += root) subdivide(x, y, root);
      if (ctx.signal?.aborted) break;
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// 5. Contour / level lines
// ---------------------------------------------------------------------------

const CONTOUR_SCHEMA = {
  levels: { kind: 'int', label: 'Szintek száma', min: 2, max: 64, default: 10, group: 'Kontúr' },
  lineWidth: {
    kind: 'float', label: 'Vonalvastagság', min: 0.02, max: 0.5, step: 0.005, default: 0.12, group: 'Kontúr',
  },
  softness: { kind: 'float', label: 'Lágyság', min: 0, max: 1, step: 0.01, default: 0.15, group: 'Kontúr' },
  fillLevels: { kind: 'bool', label: 'Szintek kitöltése', default: false, group: 'Kontúr' },
  invert: { kind: 'bool', label: 'Invertálás', default: false, group: 'Kontúr' },
  ...THRESHOLD_PARAMS,
} as const satisfies ParamSchema;

const CONTOUR: Processor<typeof CONTOUR_SCHEMA> = {
  id: 'mod:contour',
  name: 'Szintvonalas dither',
  category: 'modulated',
  params: CONTOUR_SCHEMA,
  supportsColor: false,
  vectorizable: true,
  apply(input, params, ctx) {
    const w = input.width;
    const h = input.height;
    const out = likeBuffer(input);
    const src = input.data;
    const dst = out.data;
    const { dark, light } = monoEndpoints(ctx.palette, input.colorSpace);
    const levels = params.levels;
    const lw = params.lineWidth;
    const soft = params.softness * 0.5;

    for (let p = 0; p < w * h; p++) {
      const i = p * 4;
      const l = Math.min(1, Math.max(0, lumaSrgb(src[i], src[i + 1], src[i + 2]) + params.threshold));
      const scaled = l * levels;
      const f = scaled - Math.floor(scaled);
      const dist = Math.abs(f - 0.5) * 2; // 0 at band centre, 1 at band edge
      let cov: number;
      if (params.fillLevels) {
        cov = 1 - Math.floor(scaled) / levels;
      } else {
        const edge = 1 - lw;
        cov = soft <= 0.001
          ? (dist >= edge ? 1 : 0)
          : Math.min(1, Math.max(0, (dist - edge + soft) / (2 * soft)));
      }
      if (params.invert) cov = 1 - cov;
      dst[i] = light[0] + (dark[0] - light[0]) * cov;
      dst[i + 1] = light[1] + (dark[1] - light[1]) * cov;
      dst[i + 2] = light[2] + (dark[2] - light[2]) * cov;
      dst[i + 3] = src[i + 3];
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// 6. Edge-aware dither: fine raster on edges, coarse on flat areas
// ---------------------------------------------------------------------------

const EDGE_SCHEMA = {
  ...QUANT_PARAMS,
  ...THRESHOLD_PARAMS,
  fineScale: { kind: 'float', label: 'Finom lépték', min: 0.25, max: 8, step: 0.25, default: 1, group: 'Élek' },
  coarseScale: { kind: 'float', label: 'Durva lépték', min: 1, max: 32, step: 0.5, default: 6, group: 'Élek' },
  edgeGain: { kind: 'float', label: 'Élérzékenység', min: 0.2, max: 20, step: 0.1, default: 6, group: 'Élek' },
  spread: { kind: 'float', label: 'Szórás erőssége', min: 0, max: 3, step: 0.01, default: 1, group: 'Szín' },
} as const satisfies ParamSchema;

const EDGE_AWARE: Processor<typeof EDGE_SCHEMA> = {
  id: 'mod:edge-aware',
  name: 'Élérzékeny dither',
  category: 'modulated',
  params: EDGE_SCHEMA,
  supportsColor: true,
  vectorizable: true,
  apply(input, params, ctx) {
    const w = input.width;
    const h = input.height;
    const out = likeBuffer(input);
    const src = input.data;
    const dst = out.data;
    const div = Math.max(1, ctx.resolutionDivisor);

    const mode = params.colorMode as ColorMode;
    const quant = makeQuantizer(mode, ctx.palette, ctx.distance, params.colorDepth, input.colorSpace);
    const amp = amplitudeFor(mode, ctx, params.colorDepth, input.colorSpace) * params.spread;
    const tmp = new Float32Array(3);

    const luma = new Float32Array(w * h);
    for (let p = 0; p < w * h; p++) {
      const i = p * 4;
      luma[p] = lumaSrgb(src[i], src[i + 1], src[i + 2]);
    }

    const fine = Math.max(0.25, params.fineScale / div);
    const coarse = Math.max(fine, params.coarseScale / div);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // Sobel magnitude
        const xm = x > 0 ? x - 1 : 0;
        const xp = x < w - 1 ? x + 1 : w - 1;
        const ym = y > 0 ? y - 1 : 0;
        const yp = y < h - 1 ? y + 1 : h - 1;
        const gx =
          luma[ym * w + xp] + 2 * luma[y * w + xp] + luma[yp * w + xp] -
          luma[ym * w + xm] - 2 * luma[y * w + xm] - luma[yp * w + xm];
        const gy =
          luma[yp * w + xm] + 2 * luma[yp * w + x] + luma[yp * w + xp] -
          luma[ym * w + xm] - 2 * luma[ym * w + x] - luma[ym * w + xp];
        const edge = Math.min(1, Math.sqrt(gx * gx + gy * gy) * params.edgeGain * 0.25);

        const scale = coarse + (fine - coarse) * edge;
        const bx = ((Math.floor(x / scale) % 8) + 8) % 8;
        const by = ((Math.floor(y / scale) % 8) + 8) % 8;
        const kick = (BAYER8.data[by * 8 + bx] - 0.5) * amp + params.threshold;

        const i = (y * w + x) * 4;
        quant.quantize(src[i] + kick, src[i + 1] + kick, src[i + 2] + kick, tmp, 0);
        dst[i] = tmp[0];
        dst[i + 1] = tmp[1];
        dst[i + 2] = tmp[2];
        dst[i + 3] = src[i + 3];
      }
      if (ctx.signal?.aborted) break;
    }
    return out;
  },
};

export function registerModulated(): void {
  register(MODULATED);
  register(ASCII);
  register(SHAPE_DITHER);
  register(QUADTREE);
  register(CONTOUR);
  register(EDGE_AWARE);
}
