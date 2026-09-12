import type { ParamSchema, PixelBuffer, Processor, RenderContext } from '../types';
import { likeBuffer } from '../buffer';
import { clamp01, lumaSrgb } from '../color/space';
import { register } from '../dither/registry';

/** Shared helper: run a per-pixel RGB function over a buffer. */
function mapPixels(
  input: PixelBuffer,
  ctx: RenderContext,
  fn: (r: number, g: number, b: number, out: Float32Array) => void,
): PixelBuffer {
  const out = likeBuffer(input);
  const src = input.data;
  const dst = out.data;
  const tmp = new Float32Array(3);
  for (let i = 0; i < src.length; i += 4) {
    fn(src[i], src[i + 1], src[i + 2], tmp);
    dst[i] = tmp[0];
    dst[i + 1] = tmp[1];
    dst[i + 2] = tmp[2];
    dst[i + 3] = src[i + 3];
    if ((i & 0xfffff) === 0 && ctx.signal?.aborted) break;
  }
  return out;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) * 0.5;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hue2rgb(p: number, q: number, t: number): number {
  let tt = t;
  if (tt < 0) tt += 1;
  if (tt > 1) tt -= 1;
  if (tt < 1 / 6) return p + (q - p) * 6 * tt;
  if (tt < 1 / 2) return q;
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
  return p;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)];
}

// ---------------------------------------------------------------------------
// Adjustments (the single panel that mirrors a classic tone stack)
// ---------------------------------------------------------------------------

const ADJUST_SCHEMA = {
  brightness: { kind: 'float', label: 'Fényerő', min: -1, max: 1, step: 0.005, default: 0, group: 'Tónus' },
  contrast: { kind: 'float', label: 'Kontraszt', min: -1, max: 2, step: 0.005, default: 0, group: 'Tónus' },
  saturation: { kind: 'float', label: 'Telítettség', min: -1, max: 2, step: 0.005, default: 0, group: 'Szín' },
  midtones: { kind: 'float', label: 'Középtónusok', min: -1, max: 1, step: 0.005, default: 0, group: 'Tónus' },
  highlights: { kind: 'float', label: 'Csúcsfények', min: -1, max: 1, step: 0.005, default: 0, group: 'Tónus' },
  shadows: { kind: 'float', label: 'Árnyékok', min: -1, max: 1, step: 0.005, default: 0, group: 'Tónus' },
  hue: { kind: 'angle', label: 'Színárnyalat', default: 0, group: 'Szín' },
  temperature: { kind: 'float', label: 'Színhőmérséklet', min: -1, max: 1, step: 0.005, default: 0, group: 'Szín' },
  exposure: { kind: 'float', label: 'Expozíció', min: -3, max: 3, step: 0.01, default: 0, unit: 'EV', group: 'Tónus' },
} as const satisfies ParamSchema;

const ADJUST: Processor<typeof ADJUST_SCHEMA> = {
  id: 'fx:adjust',
  name: 'Tónus és szín',
  category: 'adjust',
  params: ADJUST_SCHEMA,
  supportsColor: true,
  vectorizable: false,
  apply(input, p, ctx) {
    const expMul = Math.pow(2, p.exposure);
    const contrast = p.contrast + 1;
    const sat = p.saturation + 1;
    const hueShift = p.hue / 360;
    // Midtone control as a gamma exponent: +1 -> 0.4, -1 -> 2.5
    const gamma = Math.pow(2.5, -p.midtones);
    const temp = p.temperature;

    return mapPixels(input, ctx, (r0, g0, b0, out) => {
      let r = r0 * expMul;
      let g = g0 * expMul;
      let b = b0 * expMul;

      r += p.brightness;
      g += p.brightness;
      b += p.brightness;

      r = (r - 0.5) * contrast + 0.5;
      g = (g - 0.5) * contrast + 0.5;
      b = (b - 0.5) * contrast + 0.5;

      if (gamma !== 1) {
        r = Math.pow(clamp01(r), gamma);
        g = Math.pow(clamp01(g), gamma);
        b = Math.pow(clamp01(b), gamma);
      }

      if (p.highlights !== 0 || p.shadows !== 0) {
        const l = lumaSrgb(clamp01(r), clamp01(g), clamp01(b));
        // Smooth masks so the two controls do not fight in the midtones.
        const hi = l * l;
        const sh = (1 - l) * (1 - l);
        const add = p.highlights * hi * 0.5 + p.shadows * sh * 0.5;
        r += add;
        g += add;
        b += add;
      }

      if (temp !== 0) {
        r += temp * 0.12;
        b -= temp * 0.12;
      }

      if (sat !== 1 || hueShift !== 0) {
        const [h, s, l] = rgbToHsl(clamp01(r), clamp01(g), clamp01(b));
        const [nr, ng, nb] = hslToRgb(
          (h + hueShift + 1) % 1,
          clamp01(s * sat),
          l,
        );
        r = nr;
        g = ng;
        b = nb;
      }

      out[0] = clamp01(r);
      out[1] = clamp01(g);
      out[2] = clamp01(b);
    });
  },
};

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

const LEVELS_SCHEMA = {
  inBlack: { kind: 'float', label: 'Bemenet fekete', min: 0, max: 1, step: 0.002, default: 0, group: 'Bemenet' },
  inWhite: { kind: 'float', label: 'Bemenet fehér', min: 0, max: 1, step: 0.002, default: 1, group: 'Bemenet' },
  gamma: { kind: 'float', label: 'Gamma', min: 0.1, max: 5, step: 0.01, default: 1, curve: 'log', group: 'Bemenet' },
  outBlack: { kind: 'float', label: 'Kimenet fekete', min: 0, max: 1, step: 0.002, default: 0, group: 'Kimenet' },
  outWhite: { kind: 'float', label: 'Kimenet fehér', min: 0, max: 1, step: 0.002, default: 1, group: 'Kimenet' },
  channel: {
    kind: 'enum',
    label: 'Csatorna',
    options: [
      { value: 'rgb', label: 'RGB' },
      { value: 'r', label: 'Vörös' },
      { value: 'g', label: 'Zöld' },
      { value: 'b', label: 'Kék' },
    ],
    default: 'rgb',
    group: 'Bemenet',
  },
} as const satisfies ParamSchema;

const LEVELS: Processor<typeof LEVELS_SCHEMA> = {
  id: 'fx:levels',
  name: 'Szintek',
  category: 'adjust',
  params: LEVELS_SCHEMA,
  supportsColor: true,
  vectorizable: false,
  apply(input, p, ctx) {
    const range = Math.max(1e-6, p.inWhite - p.inBlack);
    const invGamma = 1 / Math.max(1e-6, p.gamma);
    const f = (v: number): number => {
      const n = clamp01((v - p.inBlack) / range);
      return p.outBlack + Math.pow(n, invGamma) * (p.outWhite - p.outBlack);
    };
    const ch = p.channel;
    return mapPixels(input, ctx, (r, g, b, out) => {
      out[0] = ch === 'rgb' || ch === 'r' ? f(r) : r;
      out[1] = ch === 'rgb' || ch === 'g' ? f(g) : g;
      out[2] = ch === 'rgb' || ch === 'b' ? f(b) : b;
    });
  },
};

// ---------------------------------------------------------------------------
// Posterize / Invert / Threshold
// ---------------------------------------------------------------------------

const POSTERIZE_SCHEMA = {
  levels: { kind: 'int', label: 'Szintek', min: 2, max: 64, default: 6, group: 'Poszterizálás' },
  perChannel: { kind: 'bool', label: 'Csatornánként', default: true, group: 'Poszterizálás' },
} as const satisfies ParamSchema;

const POSTERIZE: Processor<typeof POSTERIZE_SCHEMA> = {
  id: 'fx:posterize',
  name: 'Poszterizálás',
  category: 'adjust',
  params: POSTERIZE_SCHEMA,
  supportsColor: true,
  vectorizable: false,
  apply(input, p, ctx) {
    const n = Math.max(1, p.levels - 1);
    return mapPixels(input, ctx, (r, g, b, out) => {
      if (p.perChannel) {
        out[0] = Math.round(clamp01(r) * n) / n;
        out[1] = Math.round(clamp01(g) * n) / n;
        out[2] = Math.round(clamp01(b) * n) / n;
      } else {
        const l = Math.round(lumaSrgb(r, g, b) * n) / n;
        out[0] = l;
        out[1] = l;
        out[2] = l;
      }
    });
  },
};

const INVERT_SCHEMA = {
  amount: { kind: 'float', label: 'Mérték', min: 0, max: 1, step: 0.01, default: 1, group: 'Invertálás' },
} as const satisfies ParamSchema;

const INVERT: Processor<typeof INVERT_SCHEMA> = {
  id: 'fx:invert',
  name: 'Invertálás',
  category: 'adjust',
  params: INVERT_SCHEMA,
  supportsColor: true,
  vectorizable: false,
  apply(input, p, ctx) {
    const a = p.amount;
    return mapPixels(input, ctx, (r, g, b, out) => {
      out[0] = r + (1 - 2 * r) * a;
      out[1] = g + (1 - 2 * g) * a;
      out[2] = b + (1 - 2 * b) * a;
    });
  },
};

const THRESHOLD_FX_SCHEMA = {
  threshold: { kind: 'float', label: 'Küszöb', min: 0, max: 1, step: 0.002, default: 0.5, group: 'Küszöb' },
  softness: { kind: 'float', label: 'Lágyság', min: 0, max: 0.5, step: 0.002, default: 0, group: 'Küszöb' },
} as const satisfies ParamSchema;

const THRESHOLD_FX: Processor<typeof THRESHOLD_FX_SCHEMA> = {
  id: 'fx:threshold',
  name: 'Küszöb',
  category: 'adjust',
  params: THRESHOLD_FX_SCHEMA,
  supportsColor: false,
  vectorizable: true,
  apply(input, p, ctx) {
    const t = p.threshold;
    const s = p.softness;
    return mapPixels(input, ctx, (r, g, b, out) => {
      const l = lumaSrgb(r, g, b);
      const v = s <= 0 ? (l >= t ? 1 : 0) : clamp01((l - t + s) / (2 * s));
      out[0] = v;
      out[1] = v;
      out[2] = v;
    });
  },
};

const GRAYSCALE_SCHEMA = {
  mode: {
    kind: 'enum',
    label: 'Módszer',
    options: [
      { value: 'luma', label: 'Luma (Rec. 601)' },
      { value: 'average', label: 'Átlag' },
      { value: 'lightness', label: 'Világosság' },
      { value: 'red', label: 'Vörös csatorna' },
      { value: 'green', label: 'Zöld csatorna' },
      { value: 'blue', label: 'Kék csatorna' },
    ],
    default: 'luma',
    group: 'Szürkeárnyalat',
  },
  amount: { kind: 'float', label: 'Mérték', min: 0, max: 1, step: 0.01, default: 1, group: 'Szürkeárnyalat' },
} as const satisfies ParamSchema;

const GRAYSCALE: Processor<typeof GRAYSCALE_SCHEMA> = {
  id: 'fx:grayscale',
  name: 'Szürkeárnyalat',
  category: 'adjust',
  params: GRAYSCALE_SCHEMA,
  supportsColor: false,
  vectorizable: false,
  apply(input, p, ctx) {
    return mapPixels(input, ctx, (r, g, b, out) => {
      let v: number;
      switch (p.mode) {
        case 'average': v = (r + g + b) / 3; break;
        case 'lightness': v = (Math.max(r, g, b) + Math.min(r, g, b)) * 0.5; break;
        case 'red': v = r; break;
        case 'green': v = g; break;
        case 'blue': v = b; break;
        default: v = lumaSrgb(r, g, b);
      }
      out[0] = r + (v - r) * p.amount;
      out[1] = g + (v - g) * p.amount;
      out[2] = b + (v - b) * p.amount;
    });
  },
};

export function registerAdjustments(): void {
  register(ADJUST);
  register(LEVELS);
  register(POSTERIZE);
  register(INVERT);
  register(THRESHOLD_FX);
  register(GRAYSCALE);
}
