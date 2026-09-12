import type { ParamSchema, Processor } from '../types';
import { likeBuffer } from '../buffer';
import { clamp01, lumaSrgb } from '../color/space';
import { Rng, hashNoise2D, temporalSeed } from '../rng';
import { register } from '../dither/registry';

const CRT_SCHEMA = {
  scanlineStrength: {
    kind: 'float', label: 'Sorcsíkok erőssége', min: 0, max: 1, step: 0.01, default: 0.35, group: 'CRT',
  },
  scanlinePitch: {
    kind: 'float', label: 'Sortávolság', min: 1, max: 32, step: 0.25, default: 3, unit: 'px', group: 'CRT',
  },
  maskStrength: {
    kind: 'float', label: 'Árnyékmaszk', min: 0, max: 1, step: 0.01, default: 0.25, group: 'CRT',
  },
  maskType: {
    kind: 'enum',
    label: 'Maszk típusa',
    options: [
      { value: 'aperture', label: 'Apertúra rács' },
      { value: 'shadow', label: 'Árnyékmaszk' },
      { value: 'slot', label: 'Slot maszk' },
    ],
    default: 'aperture',
    group: 'CRT',
  },
  curvature: { kind: 'float', label: 'Görbület', min: 0, max: 0.6, step: 0.005, default: 0.08, group: 'CRT' },
  vignette: { kind: 'float', label: 'Vignetta', min: 0, max: 1, step: 0.01, default: 0.3, group: 'CRT' },
  bleed: { kind: 'float', label: 'Vízszintes elkenődés', min: 0, max: 8, step: 0.1, default: 0.8, unit: 'px', group: 'CRT' },
  brightness: { kind: 'float', label: 'Utókorrekció', min: 0.5, max: 3, step: 0.01, default: 1.25, group: 'CRT' },
} as const satisfies ParamSchema;

const CRT: Processor<typeof CRT_SCHEMA> = {
  id: 'fx:crt',
  name: 'Scanline / CRT',
  category: 'stylize',
  params: CRT_SCHEMA,
  supportsColor: true,
  vectorizable: false,
  apply(input, p, ctx) {
    const w = input.width;
    const h = input.height;
    const out = likeBuffer(input);
    const src = input.data;
    const dst = out.data;
    const div = Math.max(1, ctx.resolutionDivisor);
    const pitch = Math.max(1, p.scanlinePitch / div);
    const bleed = p.bleed / div;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const maxR2 = cx * cx + cy * cy;

    const sample = (x: number, y: number, c: number): number => {
      const ix = Math.min(w - 1, Math.max(0, Math.round(x)));
      const iy = Math.min(h - 1, Math.max(0, Math.round(y)));
      return src[(iy * w + ix) * 4 + c];
    };

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // Barrel distortion of the sampling coordinate.
        let sx = x;
        let sy = y;
        if (p.curvature > 0) {
          const nx = (x - cx) / cx;
          const ny = (y - cy) / cy;
          const r2 = nx * nx + ny * ny;
          const f = 1 + p.curvature * r2;
          sx = cx + nx * cx * f;
          sy = cy + ny * cy * f;
        }

        let r: number;
        let g: number;
        let b: number;
        if (bleed > 0) {
          // Phosphor smear: a short one-sided horizontal average.
          r = (sample(sx, sy, 0) + sample(sx - bleed, sy, 0)) * 0.5;
          g = (sample(sx, sy, 1) + sample(sx - bleed * 0.6, sy, 1)) * 0.5;
          b = (sample(sx, sy, 2) + sample(sx - bleed * 0.3, sy, 2)) * 0.5;
        } else {
          r = sample(sx, sy, 0);
          g = sample(sx, sy, 1);
          b = sample(sx, sy, 2);
        }

        const scan = 1 - p.scanlineStrength * (0.5 + 0.5 * Math.cos((y / pitch) * Math.PI * 2));
        r *= scan; g *= scan; b *= scan;

        if (p.maskStrength > 0) {
          const m = p.maskStrength;
          let mr = 1, mg = 1, mb = 1;
          if (p.maskType === 'aperture') {
            const phase = x % 3;
            mr = phase === 0 ? 1 : 1 - m;
            mg = phase === 1 ? 1 : 1 - m;
            mb = phase === 2 ? 1 : 1 - m;
          } else if (p.maskType === 'shadow') {
            const phase = (x + ((y % 2) * 1)) % 3;
            mr = phase === 0 ? 1 : 1 - m;
            mg = phase === 1 ? 1 : 1 - m;
            mb = phase === 2 ? 1 : 1 - m;
          } else {
            const phase = (x + (Math.floor(y / 2) % 2) * 3) % 6;
            mr = phase < 2 ? 1 : 1 - m;
            mg = phase >= 2 && phase < 4 ? 1 : 1 - m;
            mb = phase >= 4 ? 1 : 1 - m;
          }
          r *= mr; g *= mg; b *= mb;
        }

        if (p.vignette > 0) {
          const dx = x - cx;
          const dy = y - cy;
          const v = 1 - p.vignette * (dx * dx + dy * dy) / maxR2;
          r *= v; g *= v; b *= v;
        }

        const i = (y * w + x) * 4;
        const outside = sx < 0 || sy < 0 || sx > w - 1 || sy > h - 1;
        dst[i] = outside ? 0 : clamp01(r * p.brightness);
        dst[i + 1] = outside ? 0 : clamp01(g * p.brightness);
        dst[i + 2] = outside ? 0 : clamp01(b * p.brightness);
        dst[i + 3] = src[i + 3];
      }
      if (ctx.signal?.aborted) break;
    }
    return out;
  },
};

const NOISE_SCHEMA = {
  type: {
    kind: 'enum',
    label: 'Típus',
    options: [
      { value: 'gaussian', label: 'Gauss' },
      { value: 'uniform', label: 'Egyenletes' },
      { value: 'filmGrain', label: 'Filmszemcse' },
    ],
    default: 'filmGrain',
    group: 'Zaj',
  },
  amount: { kind: 'float', label: 'Mennyiség', min: 0, max: 1, step: 0.005, default: 0.08, group: 'Zaj' },
  size: { kind: 'float', label: 'Szemcseméret', min: 1, max: 16, step: 0.25, default: 1, unit: 'px', group: 'Zaj' },
  monochrome: { kind: 'bool', label: 'Monokróm zaj', default: true, group: 'Zaj' },
  shadowBias: {
    kind: 'float', label: 'Árnyék-súlyozás', min: -1, max: 1, step: 0.01, default: 0.4, group: 'Zaj',
  },
  seed: { kind: 'seed', label: 'Seed', default: 1, group: 'Zaj' },
} as const satisfies ParamSchema;

const NOISE: Processor<typeof NOISE_SCHEMA> = {
  id: 'fx:noise',
  name: 'Zaj / szemcse',
  category: 'stylize',
  params: NOISE_SCHEMA,
  supportsColor: true,
  vectorizable: false,
  apply(input, p, ctx) {
    const w = input.width;
    const h = input.height;
    const out = likeBuffer(input);
    const src = input.data;
    const dst = out.data;
    const seed = temporalSeed(
      ctx.seed ^ (p.seed >>> 0), 'fx:noise', ctx.frame, ctx.noiseMode, ctx.cycleLength,
    );
    const grain = Math.max(1, p.size / Math.max(1, ctx.resolutionDivisor));
    const rng = new Rng(seed);
    // Pre-generate a gaussian lattice so grain size behaves like real grain.
    const gw = Math.ceil(w / grain) + 1;
    const gh = Math.ceil(h / grain) + 1;
    const lattice = new Float32Array(gw * gh * 3);
    for (let i = 0; i < lattice.length; i++) {
      lattice[i] = p.type === 'uniform' ? rng.nextSigned() : rng.nextGaussian() * 0.5;
    }

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const gx = Math.min(gw - 1, Math.floor(x / grain));
        const gy = Math.min(gh - 1, Math.floor(y / grain));
        const li = (gy * gw + gx) * 3;
        let nr = lattice[li];
        let ng = p.monochrome ? nr : lattice[li + 1];
        let nb = p.monochrome ? nr : lattice[li + 2];

        if (p.type === 'filmGrain') {
          // Grain scales with exposure: strongest in the midtones/shadows.
          const l = lumaSrgb(src[i], src[i + 1], src[i + 2]);
          const weight = Math.pow(1 - l, Math.max(0.01, 1 + p.shadowBias * 2)) + 0.15;
          nr *= weight; ng *= weight; nb *= weight;
        } else if (p.shadowBias !== 0) {
          const l = lumaSrgb(src[i], src[i + 1], src[i + 2]);
          const weight = 1 + p.shadowBias * (0.5 - l) * 2;
          nr *= weight; ng *= weight; nb *= weight;
        }

        // Break lattice blockiness with a per-pixel dither of the grain value.
        if (grain > 1) {
          const j = (hashNoise2D(x, y, seed) - 0.5) * 0.35;
          nr += j; ng += j; nb += j;
        }

        dst[i] = clamp01(src[i] + nr * p.amount);
        dst[i + 1] = clamp01(src[i + 1] + ng * p.amount);
        dst[i + 2] = clamp01(src[i + 2] + nb * p.amount);
        dst[i + 3] = src[i + 3];
      }
      if (ctx.signal?.aborted) break;
    }
    return out;
  },
};

export function registerStylize(): void {
  register(CRT);
  register(NOISE);
}
