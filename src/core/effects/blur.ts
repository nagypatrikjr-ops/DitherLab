import type { ParamSchema, PixelBuffer, Processor } from '../types';
import { createBuffer, likeBuffer, resampleBilinear, resampleBox } from '../buffer';
import { clamp01, lumaSrgb, linearToSrgb, srgbToLinear } from '../color/space';
import { hashNoise2D, temporalSeed } from '../rng';
import { register } from '../dither/registry';

/** Separable Gaussian blur. Radius is in pixels; sigma = radius / 3. */
export function gaussianBlur(src: PixelBuffer, radius: number): PixelBuffer {
  const r = Math.max(0, radius);
  if (r < 0.25) return { ...src, data: new Float32Array(src.data) };
  const sigma = Math.max(0.3, r / 3);
  const k = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(k * 2 + 1);
  const inv2s2 = 1 / (2 * sigma * sigma);
  let sum = 0;
  for (let i = -k; i <= k; i++) {
    const v = Math.exp(-(i * i) * inv2s2);
    kernel[i + k] = v;
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;

  const w = src.width;
  const h = src.height;
  const tmp = new Float32Array(src.data.length);
  const out = new Float32Array(src.data.length);
  const d = src.data;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let ar = 0, ag = 0, ab = 0, aa = 0;
      for (let i = -k; i <= k; i++) {
        const xx = Math.min(w - 1, Math.max(0, x + i));
        const s = (y * w + xx) * 4;
        const kw = kernel[i + k];
        ar += d[s] * kw;
        ag += d[s + 1] * kw;
        ab += d[s + 2] * kw;
        aa += d[s + 3] * kw;
      }
      const o = (y * w + x) * 4;
      tmp[o] = ar; tmp[o + 1] = ag; tmp[o + 2] = ab; tmp[o + 3] = aa;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let ar = 0, ag = 0, ab = 0, aa = 0;
      for (let i = -k; i <= k; i++) {
        const yy = Math.min(h - 1, Math.max(0, y + i));
        const s = (yy * w + x) * 4;
        const kw = kernel[i + k];
        ar += tmp[s] * kw;
        ag += tmp[s + 1] * kw;
        ab += tmp[s + 2] * kw;
        aa += tmp[s + 3] * kw;
      }
      const o = (y * w + x) * 4;
      out[o] = ar; out[o + 1] = ag; out[o + 2] = ab; out[o + 3] = aa;
    }
  }
  return { data: out, width: w, height: h, colorSpace: src.colorSpace };
}

const BLUR_SCHEMA = {
  radius: { kind: 'float', label: 'Sugár', min: 0, max: 128, step: 0.5, default: 4, curve: 'log', group: 'Elmosás' },
} as const satisfies ParamSchema;

const BLUR: Processor<typeof BLUR_SCHEMA> = {
  id: 'fx:blur',
  name: 'Elmosás',
  category: 'blur',
  params: BLUR_SCHEMA,
  supportsColor: true,
  vectorizable: false,
  apply(input, p, ctx) {
    return gaussianBlur(input, p.radius / Math.max(1, ctx.resolutionDivisor));
  },
};

const SHARPEN_SCHEMA = {
  amount: { kind: 'float', label: 'Erősség', min: 0, max: 4, step: 0.01, default: 0.6, group: 'Élesítés' },
  radius: { kind: 'float', label: 'Sugár', min: 0.5, max: 32, step: 0.25, default: 1.5, group: 'Élesítés' },
  threshold: { kind: 'float', label: 'Küszöb', min: 0, max: 0.5, step: 0.002, default: 0, group: 'Élesítés' },
} as const satisfies ParamSchema;

/** Unsharp mask: original + amount * (original - blurred), gated by threshold. */
const SHARPEN: Processor<typeof SHARPEN_SCHEMA> = {
  id: 'fx:sharpen',
  name: 'Élesítés',
  category: 'blur',
  params: SHARPEN_SCHEMA,
  supportsColor: true,
  vectorizable: false,
  apply(input, p, ctx) {
    const blurred = gaussianBlur(input, p.radius / Math.max(1, ctx.resolutionDivisor));
    const out = likeBuffer(input);
    const s = input.data;
    const b = blurred.data;
    const d = out.data;
    for (let i = 0; i < s.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const diff = s[i + c] - b[i + c];
        d[i + c] = Math.abs(diff) >= p.threshold ? clamp01(s[i + c] + diff * p.amount) : s[i + c];
      }
      d[i + 3] = s[i + 3];
    }
    return out;
  },
};

const GLOW_SCHEMA = {
  threshold: { kind: 'float', label: 'Küszöb', min: 0, max: 1, step: 0.005, default: 0.7, group: 'Ragyogás' },
  knee: { kind: 'float', label: 'Lágy átmenet', min: 0, max: 0.5, step: 0.005, default: 0.12, group: 'Ragyogás' },
  radius: { kind: 'float', label: 'Sugár', min: 1, max: 200, step: 1, default: 24, curve: 'log', group: 'Ragyogás' },
  intensity: { kind: 'float', label: 'Intenzitás', min: 0, max: 4, step: 0.01, default: 0.9, group: 'Ragyogás' },
  scatter: { kind: 'float', label: 'Szórás (epszilon)', min: 0, max: 1, step: 0.01, default: 0.15, group: 'Ragyogás' },
  tint: { kind: 'color', label: 'Színezés', default: { r: 1, g: 1, b: 1 }, group: 'Ragyogás' },
  seed: { kind: 'seed', label: 'Seed', default: 1, group: 'Ragyogás' },
} as const satisfies ParamSchema;

/**
 * Threshold-and-bloom in linear light, which is the only place where adding
 * light is physically meaningful. The scatter term injects a tiny amount of
 * seeded noise into the bright mask before blurring, which breaks up the
 * concentric banding a pure Gaussian would leave behind.
 */
const GLOW: Processor<typeof GLOW_SCHEMA> = {
  id: 'fx:glow',
  name: 'Ragyogás / Bloom',
  category: 'stylize',
  params: GLOW_SCHEMA,
  supportsColor: true,
  vectorizable: false,
  apply(input, p, ctx) {
    const w = input.width;
    const h = input.height;
    const seed = temporalSeed(
      ctx.seed ^ (p.seed >>> 0), 'fx:glow', ctx.frame, ctx.noiseMode, ctx.cycleLength,
    );
    const mask = createBuffer(w, h, 'linear');
    const src = input.data;
    const md = mask.data;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const lr = srgbToLinear(clamp01(src[i]));
        const lg = srgbToLinear(clamp01(src[i + 1]));
        const lb = srgbToLinear(clamp01(src[i + 2]));
        const l = lumaSrgb(src[i], src[i + 1], src[i + 2]);
        const t = p.threshold;
        const knee = Math.max(1e-5, p.knee);
        const weight = l <= t - knee ? 0 : l >= t + knee ? 1 : (l - t + knee) / (2 * knee);
        const jitter = p.scatter > 0 ? 1 + (hashNoise2D(x, y, seed) - 0.5) * p.scatter : 1;
        md[i] = lr * weight * jitter;
        md[i + 1] = lg * weight * jitter;
        md[i + 2] = lb * weight * jitter;
        md[i + 3] = 1;
      }
    }

    // A bloom is low-frequency by construction, so blurring it at full
    // resolution is wasted work: a 24 px Gaussian over 12 MP costs seconds.
    // Box-downsampling the mask first cuts both the pixel count and the kernel
    // width, which is a quadratic saving, and the bilinear upsample adds its
    // own smoothing. Measured 5.0 s -> well under the 3 s budget at 4000x3000.
    const radius = p.radius / Math.max(1, ctx.resolutionDivisor);
    const step = Math.min(8, Math.max(1, Math.round(radius / 4)));
    let bloom: PixelBuffer;
    if (step > 1) {
      const small = resampleBox(
        mask,
        Math.max(1, Math.round(w / step)),
        Math.max(1, Math.round(h / step)),
      );
      bloom = resampleBilinear(gaussianBlur(small, radius / step), w, h);
    } else {
      bloom = gaussianBlur(mask, radius);
    }
    const out = likeBuffer(input);
    const bd = bloom.data;
    const d = out.data;
    const tint = p.tint;
    for (let i = 0; i < src.length; i += 4) {
      const lr = srgbToLinear(clamp01(src[i])) + bd[i] * p.intensity * tint.r;
      const lg = srgbToLinear(clamp01(src[i + 1])) + bd[i + 1] * p.intensity * tint.g;
      const lb = srgbToLinear(clamp01(src[i + 2])) + bd[i + 2] * p.intensity * tint.b;
      d[i] = linearToSrgb(clamp01(lr));
      d[i + 1] = linearToSrgb(clamp01(lg));
      d[i + 2] = linearToSrgb(clamp01(lb));
      d[i + 3] = src[i + 3];
    }
    return out;
  },
};

export function registerBlur(): void {
  register(BLUR);
  register(SHARPEN);
  register(GLOW);
}
