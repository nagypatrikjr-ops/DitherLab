import type { ParamSchema, Processor } from '../types';
import { likeBuffer } from '../buffer';
import { clamp01, lumaSrgb } from '../color/space';
import { Rng, hashNoise2D, temporalSeed } from '../rng';
import { register } from '../dither/registry';
import {
  QUANT_CHROMA,
  QUANT_LUMA,
  ZIGZAG,
  fdct8x8,
  idct8x8,
  rgbToYcbcr,
  scaleQuantTable,
  ycbcrToRgb,
} from './jpegCore';

// ---------------------------------------------------------------------------
// Chromatic aberration
// ---------------------------------------------------------------------------

const CA_SCHEMA = {
  mode: {
    kind: 'enum',
    label: 'Mód',
    options: [
      { value: 'linear', label: 'Lineáris eltolás' },
      { value: 'radial', label: 'Sugárirányú' },
    ],
    default: 'radial',
    group: 'Aberráció',
  },
  amount: { kind: 'float', label: 'Mérték', min: -40, max: 40, step: 0.1, default: 3, unit: 'px', group: 'Aberráció' },
  angle: { kind: 'angle', label: 'Irány', default: 0, group: 'Aberráció' },
  greenShift: { kind: 'float', label: 'Zöld eltérés', min: -1, max: 1, step: 0.01, default: 0, group: 'Aberráció' },
  falloff: { kind: 'float', label: 'Sugárirányú görbe', min: 0.5, max: 4, step: 0.05, default: 2, group: 'Aberráció' },
} as const satisfies ParamSchema;

function sampleBilinear(
  d: Float32Array, w: number, h: number, x: number, y: number, c: number,
): number {
  const cx = Math.min(w - 1, Math.max(0, x));
  const cy = Math.min(h - 1, Math.max(0, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const tx = cx - x0;
  const ty = cy - y0;
  const a = d[(y0 * w + x0) * 4 + c];
  const b = d[(y0 * w + x1) * 4 + c];
  const e = d[(y1 * w + x0) * 4 + c];
  const f = d[(y1 * w + x1) * 4 + c];
  return (a + (b - a) * tx) + ((e + (f - e) * tx) - (a + (b - a) * tx)) * ty;
}

const CHROMATIC: Processor<typeof CA_SCHEMA> = {
  id: 'fx:chromatic',
  name: 'Kromatikus aberráció',
  category: 'glitch',
  params: CA_SCHEMA,
  supportsColor: true,
  vectorizable: false,
  apply(input, p, ctx) {
    const w = input.width;
    const h = input.height;
    const out = likeBuffer(input);
    const src = input.data;
    const dst = out.data;
    const div = Math.max(1, ctx.resolutionDivisor);
    const amt = p.amount / div;
    const rad = (p.angle * Math.PI) / 180;
    const dx = Math.cos(rad);
    const dy = Math.sin(rad);
    const cx = w * 0.5;
    const cy = h * 0.5;
    const maxR = Math.sqrt(cx * cx + cy * cy) || 1;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let ox: number;
        let oy: number;
        if (p.mode === 'radial') {
          const vx = (x - cx) / maxR;
          const vy = (y - cy) / maxR;
          const r = Math.pow(Math.sqrt(vx * vx + vy * vy), p.falloff);
          const len = Math.sqrt(vx * vx + vy * vy) || 1;
          ox = (vx / len) * r * amt;
          oy = (vy / len) * r * amt;
        } else {
          ox = dx * amt;
          oy = dy * amt;
        }
        const i = (y * w + x) * 4;
        dst[i] = sampleBilinear(src, w, h, x + ox, y + oy, 0);
        dst[i + 1] = sampleBilinear(src, w, h, x + ox * p.greenShift, y + oy * p.greenShift, 1);
        dst[i + 2] = sampleBilinear(src, w, h, x - ox, y - oy, 2);
        dst[i + 3] = src[i + 3];
      }
      if (ctx.signal?.aborted) break;
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// JPEG glitch
// ---------------------------------------------------------------------------

const JPEG_SCHEMA = {
  quality: { kind: 'int', label: 'JPEG minőség', min: 1, max: 100, default: 30, group: 'Tömörítés' },
  passes: { kind: 'int', label: 'Ismételt tömörítés', min: 1, max: 12, default: 1, group: 'Tömörítés' },
  subsample: { kind: 'bool', label: '4:2:0 színbontás', default: true, group: 'Tömörítés' },
  corruption: {
    kind: 'float', label: 'Blokk-sérülés', min: 0, max: 1, step: 0.005, default: 0, group: 'Sérülés',
  },
  dcDrift: {
    kind: 'float', label: 'DC elcsúszás', min: 0, max: 1, step: 0.005, default: 0, group: 'Sérülés',
  },
  driftLength: {
    kind: 'int', label: 'Elcsúszás hossza', min: 1, max: 256, default: 24, unit: 'blokk', group: 'Sérülés',
  },
  coefficientShift: {
    kind: 'int', label: 'Együttható-csúszás', min: 0, max: 32, default: 0, group: 'Sérülés',
  },
  seed: { kind: 'seed', label: 'Seed', default: 1, group: 'Sérülés' },
} as const satisfies ParamSchema;

interface Plane {
  data: Float32Array;
  w: number;
  h: number;
}

function makePlane(w: number, h: number): Plane {
  return { data: new Float32Array(w * h), w, h };
}

function planeSample(p: Plane, x: number, y: number): number {
  const cx = Math.min(p.w - 1, Math.max(0, x));
  const cy = Math.min(p.h - 1, Math.max(0, y));
  return p.data[cy * p.w + cx];
}

/**
 * One compress/decompress round trip on a single plane, with optional
 * coefficient corruption. `dcCarry` threads a running DC error along the block
 * scan order, exactly like a desynchronised DC predictor in a damaged file.
 */
function processPlane(
  plane: Plane,
  quant: Int32Array,
  rng: Rng,
  corruption: number,
  dcDrift: number,
  driftLength: number,
  coefShift: number,
): void {
  const blocksX = Math.ceil(plane.w / 8);
  const blocksY = Math.ceil(plane.h / 8);
  const block = new Float32Array(64);
  const coeff = new Float32Array(64);
  const spatial = new Float32Array(64);
  let dcCarry = 0;
  let carryLeft = 0;

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          // Level shift to -128..127 as the standard requires.
          block[y * 8 + x] = planeSample(plane, bx * 8 + x, by * 8 + y) * 255 - 128;
        }
      }
      fdct8x8(block, coeff);

      // Quantise -> integer coefficients.
      const q = new Int32Array(64);
      for (let i = 0; i < 64; i++) q[i] = Math.round(coeff[i] / quant[i]);

      if (coefShift > 0) {
        // Shift the zig-zag sequence: the classic "smeared block" artefact.
        const shifted = new Int32Array(64);
        for (let i = 0; i < 64; i++) {
          const from = ZIGZAG[(i + coefShift) % 64];
          shifted[ZIGZAG[i]] = q[from];
        }
        q.set(shifted);
      }

      if (corruption > 0 && rng.next() < corruption) {
        // Damage a contiguous run of AC coefficients, as a lost bit run would.
        const start = 1 + rng.nextInt(40);
        const len = 1 + rng.nextInt(24);
        const flip = rng.nextSigned() * 40;
        for (let i = start; i < Math.min(64, start + len); i++) {
          q[ZIGZAG[i]] = Math.round(q[ZIGZAG[i]] + flip);
        }
      }

      if (dcDrift > 0) {
        if (carryLeft <= 0) {
          if (rng.next() < dcDrift * 0.15) {
            dcCarry = rng.nextSigned() * dcDrift * 60;
            carryLeft = driftLength;
          } else {
            dcCarry = 0;
          }
        } else {
          carryLeft--;
        }
        q[0] += Math.round(dcCarry / Math.max(1, quant[0]));
      }

      for (let i = 0; i < 64; i++) coeff[i] = q[i] * quant[i];
      idct8x8(coeff, spatial);

      for (let y = 0; y < 8; y++) {
        const py = by * 8 + y;
        if (py >= plane.h) break;
        for (let x = 0; x < 8; x++) {
          const px = bx * 8 + x;
          if (px >= plane.w) break;
          plane.data[py * plane.w + px] = (spatial[y * 8 + x] + 128) / 255;
        }
      }
    }
  }
}

const JPEG_GLITCH: Processor<typeof JPEG_SCHEMA> = {
  id: 'fx:jpeg',
  name: 'JPEG glitch',
  category: 'glitch',
  params: JPEG_SCHEMA,
  supportsColor: true,
  vectorizable: false,
  apply(input, p, ctx) {
    const w = input.width;
    const h = input.height;
    const src = input.data;
    const seed = temporalSeed(
      ctx.seed ^ (p.seed >>> 0), 'fx:jpeg', ctx.frame, ctx.noiseMode, ctx.cycleLength,
    );

    const yP = makePlane(w, h);
    const cw = p.subsample ? Math.ceil(w / 2) : w;
    const chh = p.subsample ? Math.ceil(h / 2) : h;
    const cbP = makePlane(cw, chh);
    const crP = makePlane(cw, chh);
    const counts = p.subsample ? new Float32Array(cw * chh) : null;

    const tmp = new Float32Array(3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        rgbToYcbcr(clamp01(src[i]), clamp01(src[i + 1]), clamp01(src[i + 2]), tmp, 0);
        yP.data[y * w + x] = tmp[0];
        if (counts) {
          const ci = (y >> 1) * cw + (x >> 1);
          cbP.data[ci] += tmp[1];
          crP.data[ci] += tmp[2];
          counts[ci] += 1;
        } else {
          cbP.data[y * w + x] = tmp[1];
          crP.data[y * w + x] = tmp[2];
        }
      }
    }
    if (counts) {
      for (let i = 0; i < counts.length; i++) {
        if (counts[i] > 0) {
          cbP.data[i] /= counts[i];
          crP.data[i] /= counts[i];
        }
      }
    }

    const qL = scaleQuantTable(QUANT_LUMA, p.quality);
    const qC = scaleQuantTable(QUANT_CHROMA, p.quality);
    const rng = new Rng(seed);

    for (let pass = 0; pass < p.passes; pass++) {
      processPlane(yP, qL, rng, p.corruption, p.dcDrift, p.driftLength, p.coefficientShift);
      processPlane(cbP, qC, rng, p.corruption * 0.6, p.dcDrift * 0.8, p.driftLength, p.coefficientShift);
      processPlane(crP, qC, rng, p.corruption * 0.6, p.dcDrift * 0.8, p.driftLength, p.coefficientShift);
      if (ctx.signal?.aborted) break;
      ctx.progress?.((pass + 1) / p.passes);
    }

    const out = likeBuffer(input);
    const dst = out.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const cb = p.subsample ? planeSample(cbP, x >> 1, y >> 1) : cbP.data[y * w + x];
        const cr = p.subsample ? planeSample(crP, x >> 1, y >> 1) : crP.data[y * w + x];
        ycbcrToRgb(yP.data[y * w + x], cb, cr, tmp, 0);
        dst[i] = clamp01(tmp[0]);
        dst[i + 1] = clamp01(tmp[1]);
        dst[i + 2] = clamp01(tmp[2]);
        dst[i + 3] = src[i + 3];
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// Pixel sort
// ---------------------------------------------------------------------------

const SORT_SCHEMA = {
  direction: {
    kind: 'enum',
    label: 'Irány',
    options: [
      { value: 'horizontal', label: 'Vízszintes' },
      { value: 'vertical', label: 'Függőleges' },
    ],
    default: 'horizontal',
    group: 'Rendezés',
  },
  key: {
    kind: 'enum',
    label: 'Rendezési kulcs',
    options: [
      { value: 'luma', label: 'Luminancia' },
      { value: 'hue', label: 'Színárnyalat' },
      { value: 'saturation', label: 'Telítettség' },
      { value: 'red', label: 'Vörös' },
      { value: 'green', label: 'Zöld' },
      { value: 'blue', label: 'Kék' },
    ],
    default: 'luma',
    group: 'Rendezés',
  },
  lower: { kind: 'float', label: 'Alsó küszöb', min: 0, max: 1, step: 0.005, default: 0.25, group: 'Rendezés' },
  upper: { kind: 'float', label: 'Felső küszöb', min: 0, max: 1, step: 0.005, default: 0.8, group: 'Rendezés' },
  reverse: { kind: 'bool', label: 'Fordított sorrend', default: false, group: 'Rendezés' },
  maxRun: { kind: 'int', label: 'Max. futamhossz', min: 2, max: 4096, default: 512, group: 'Rendezés' },
} as const satisfies ParamSchema;

const PIXEL_SORT: Processor<typeof SORT_SCHEMA> = {
  id: 'fx:pixel-sort',
  name: 'Pixel sort',
  category: 'glitch',
  params: SORT_SCHEMA,
  supportsColor: true,
  vectorizable: false,
  apply(input, p, ctx) {
    const w = input.width;
    const h = input.height;
    const out = { ...input, data: new Float32Array(input.data) };
    const d = out.data;

    const keyOf = (i: number): number => {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      switch (p.key) {
        case 'red': return r;
        case 'green': return g;
        case 'blue': return b;
        case 'saturation': {
          const mx = Math.max(r, g, b);
          const mn = Math.min(r, g, b);
          return mx === 0 ? 0 : (mx - mn) / mx;
        }
        case 'hue': {
          const mx = Math.max(r, g, b);
          const mn = Math.min(r, g, b);
          if (mx === mn) return 0;
          const dd = mx - mn;
          if (mx === r) return (((g - b) / dd + 6) % 6) / 6;
          if (mx === g) return ((b - r) / dd + 2) / 6;
          return ((r - g) / dd + 4) / 6;
        }
        default: return lumaSrgb(r, g, b);
      }
    };

    const lines = p.direction === 'horizontal' ? h : w;
    const len = p.direction === 'horizontal' ? w : h;
    const indexOf = (line: number, pos: number): number =>
      p.direction === 'horizontal' ? (line * w + pos) * 4 : (pos * w + line) * 4;

    for (let line = 0; line < lines; line++) {
      let start = -1;
      for (let pos = 0; pos <= len; pos++) {
        const inside =
          pos < len && (() => {
            const k = lumaSrgb(
              d[indexOf(line, pos)],
              d[indexOf(line, pos) + 1],
              d[indexOf(line, pos) + 2],
            );
            return k >= p.lower && k <= p.upper;
          })();
        if (inside && start < 0) start = pos;
        const runEnded = (!inside && start >= 0) || (inside && pos - start >= p.maxRun);
        if (runEnded) {
          const end = pos;
          const n = end - start;
          if (n > 1) {
            const idx = Array.from({ length: n }, (_, k) => start + k);
            const keys = idx.map((pp) => keyOf(indexOf(line, pp)));
            const order = idx
              .map((_, k) => k)
              .sort((a, b) => (keys[a] - keys[b]) || (a - b));
            if (p.reverse) order.reverse();
            const copy = new Float32Array(n * 4);
            for (let k = 0; k < n; k++) {
              const s = indexOf(line, start + order[k]);
              copy[k * 4] = d[s];
              copy[k * 4 + 1] = d[s + 1];
              copy[k * 4 + 2] = d[s + 2];
              copy[k * 4 + 3] = d[s + 3];
            }
            for (let k = 0; k < n; k++) {
              const t = indexOf(line, start + k);
              d[t] = copy[k * 4];
              d[t + 1] = copy[k * 4 + 1];
              d[t + 2] = copy[k * 4 + 2];
              d[t + 3] = copy[k * 4 + 3];
            }
          }
          start = inside ? pos : -1;
        }
      }
      if (ctx.signal?.aborted) break;
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// Displacement map
// ---------------------------------------------------------------------------

const DISPLACE_SCHEMA = {
  source: {
    kind: 'enum',
    label: 'Forrás',
    options: [
      { value: 'self', label: 'Saját luminancia' },
      { value: 'noise', label: 'Zaj' },
    ],
    default: 'noise',
    group: 'Torzítás',
  },
  amount: { kind: 'float', label: 'Mérték', min: -200, max: 200, step: 0.5, default: 12, unit: 'px', group: 'Torzítás' },
  scale: { kind: 'float', label: 'Lépték', min: 1, max: 512, step: 1, default: 40, curve: 'log', group: 'Torzítás' },
  angle: { kind: 'angle', label: 'Irány', default: 0, group: 'Torzítás' },
  seed: { kind: 'seed', label: 'Seed', default: 1, group: 'Torzítás' },
} as const satisfies ParamSchema;

const DISPLACE: Processor<typeof DISPLACE_SCHEMA> = {
  id: 'fx:displace',
  name: 'Elmozdítás (displacement)',
  category: 'glitch',
  params: DISPLACE_SCHEMA,
  supportsColor: true,
  vectorizable: false,
  apply(input, p, ctx) {
    const w = input.width;
    const h = input.height;
    const out = likeBuffer(input);
    const src = input.data;
    const dst = out.data;
    const div = Math.max(1, ctx.resolutionDivisor);
    const amt = p.amount / div;
    const scale = Math.max(1, p.scale / div);
    const rad = (p.angle * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const seed = temporalSeed(
      ctx.seed ^ (p.seed >>> 0), 'fx:displace', ctx.frame, ctx.noiseMode, ctx.cycleLength,
    );

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        let m: number;
        if (p.source === 'self') {
          m = lumaSrgb(src[i], src[i + 1], src[i + 2]) - 0.5;
        } else {
          // Value noise: bilinear interpolation of a hashed lattice.
          const fx = x / scale;
          const fy = y / scale;
          const x0 = Math.floor(fx);
          const y0 = Math.floor(fy);
          const tx = fx - x0;
          const ty = fy - y0;
          const a = hashNoise2D(x0, y0, seed);
          const b = hashNoise2D(x0 + 1, y0, seed);
          const c = hashNoise2D(x0, y0 + 1, seed);
          const e = hashNoise2D(x0 + 1, y0 + 1, seed);
          const sx = tx * tx * (3 - 2 * tx);
          const sy = ty * ty * (3 - 2 * ty);
          m = (a + (b - a) * sx) + ((c + (e - c) * sx) - (a + (b - a) * sx)) * sy - 0.5;
        }
        const ox = cos * m * amt;
        const oy = sin * m * amt;
        for (let c = 0; c < 3; c++) {
          dst[i + c] = sampleBilinear(src, w, h, x + ox, y + oy, c);
        }
        dst[i + 3] = src[i + 3];
      }
      if (ctx.signal?.aborted) break;
    }
    return out;
  },
};

export function registerGlitch(): void {
  register(CHROMATIC);
  register(JPEG_GLITCH);
  register(PIXEL_SORT);
  register(DISPLACE);
}
