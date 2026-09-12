/**
 * Deterministic pseudo-random numbers.
 *
 * Every noisy algorithm in DitherLab is seeded through here so that the same
 * document always renders to the same pixels — a hard requirement for golden
 * image tests and for "preview === export".
 */

/** 32-bit string hash (FNV-1a). Used to derive per-layer streams from ids. */
export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mix several 32-bit values into one. */
export function mixSeeds(...values: number[]): number {
  let h = 0x9e3779b9;
  for (const v of values) {
    h ^= v >>> 0;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return h >>> 0;
}

/**
 * sfc32 — small, fast, statistically solid counter-based generator.
 * Period is at least 2^32, typically ~2^128.
 */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number) {
    const s = seed >>> 0;
    this.a = s ^ 0x9e3779b9;
    this.b = Math.imul(s, 0x85ebca6b) >>> 0;
    this.c = Math.imul(s ^ 0x27d4eb2f, 0xc2b2ae35) >>> 0;
    this.d = 1;
    // Discard the first few outputs so nearby seeds decorrelate.
    for (let i = 0; i < 12; i++) this.nextUint();
  }

  nextUint(): number {
    const t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    const r = (t + this.d) | 0;
    this.c = (this.c + r) | 0;
    return r >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.nextUint() / 4294967296;
  }

  /** Uniform in [-1, 1). */
  nextSigned(): number {
    return this.next() * 2 - 1;
  }

  /** Standard normal via Box-Muller (one sample, second discarded). */
  nextGaussian(): number {
    let u = this.next();
    if (u < 1e-12) u = 1e-12;
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  nextInt(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
}

/**
 * Stateless hash noise: same (x, y, seed) always yields the same value in
 * [0,1). Used where a positional random value is needed without a sequence.
 */
export function hashNoise2D(x: number, y: number, seed: number): number {
  let h = (x | 0) * 0x27d4eb2d;
  h = (h ^ ((y | 0) * 0x165667b1)) >>> 0;
  h = (h ^ (seed >>> 0)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h / 4294967296;
}

/**
 * Seed for a layer at a given frame, honouring the temporal stability mode.
 * `static`   — identical every frame (the raster does not boil)
 * `perFrame` — new every frame
 * `cycling`  — repeats with period `cycleLength` (GIF-friendly)
 */
export function temporalSeed(
  baseSeed: number,
  layerId: string,
  frame: number,
  mode: 'static' | 'perFrame' | 'cycling',
  cycleLength: number,
): number {
  const layer = hashString(layerId);
  switch (mode) {
    case 'static':
      return mixSeeds(baseSeed, layer);
    case 'perFrame':
      return mixSeeds(baseSeed, layer, frame >>> 0);
    case 'cycling': {
      const n = Math.max(1, Math.floor(cycleLength));
      return mixSeeds(baseSeed, layer, ((frame % n) + n) % n);
    }
  }
}
