/**
 * Halftone dot shapes.
 *
 * `dotThreshold` returns, for a position (u, v) in a cell (both in
 * [-0.5, 0.5]), the tone at which that position becomes inked. A pixel is
 * inked when the requested coverage exceeds its threshold, so the inked share
 * of a cell equals the coverage exactly only if the threshold *is* the area
 * fraction ranked ahead of that position.
 *
 * The regular shapes are therefore defined the way PostScript RIPs define
 * them: by a spot function that orders positions (higher = inked earlier),
 * and a threshold table built from the rank of every position in a finely
 * sampled cell. That makes tone exact for any shape — including the regime
 * where dots merge, where closed-form "area" formulas silently print lighter
 * than asked, and the Euclidean dot, whose transition from dots to holes is
 * easy to get non-monotonic.
 *
 * Concentric, wavy, stochastic and newsprint are artistic patterns and keep
 * their direct formulas.
 */

export type DotShape =
  | 'round'
  | 'square'
  | 'ellipse'
  | 'diamond'
  | 'euclidean'
  | 'line'
  | 'cross'
  | 'concentric'
  | 'wavy'
  | 'stochastic'
  | 'newsprint';

export interface ShapeOptions {
  rings: number;
  waveAmplitude: number;
  waveFrequency: number;
}

type RankedShape = 'round' | 'square' | 'ellipse' | 'diamond' | 'euclidean' | 'line' | 'cross';

const ELLIPSE_AX = 0.62;
const ELLIPSE_AY = 0.38;

/** Spot functions: larger value = inked at a lower tone. */
function spot(shape: RankedShape, u: number, v: number): number {
  const au = Math.abs(u);
  const av = Math.abs(v);
  switch (shape) {
    case 'round':
      return -(u * u + v * v);
    case 'square':
      return -Math.max(au, av);
    case 'diamond':
      return -(au + av);
    case 'ellipse':
      return -((u / ELLIPSE_AX) ** 2 + (v / ELLIPSE_AY) ** 2);
    case 'line':
      return -av;
    case 'cross':
      return -Math.min(au, av);
    case 'euclidean': {
      // Classic Euclidean spot (PostScript), in [-1, 1] cell coordinates:
      // a circle inside the centre diamond, a circular hole around each corner
      // outside it, meeting as a checkerboard at exactly 50%.
      const x = au * 2;
      const y = av * 2;
      return x + y <= 1 ? 1 - (x * x + y * y) : (x - 1) * (x - 1) + (y - 1) * (y - 1) - 1;
    }
  }
}

const GRID = 512;
const tables = new Map<RankedShape, Float32Array>();

/**
 * Threshold table for a shape: every sample of a GRID x GRID cell gets the
 * fraction of samples ranked strictly ahead of it, plus half of those tied
 * with it (mid-rank), so the inked share at any tone is exact on average.
 */
function tableFor(shape: RankedShape): Float32Array {
  const hit = tables.get(shape);
  if (hit) return hit;
  const n = GRID * GRID;
  const values = new Float64Array(n);
  for (let j = 0; j < GRID; j++) {
    const v = (j + 0.5) / GRID - 0.5;
    for (let i = 0; i < GRID; i++) {
      const u = (i + 0.5) / GRID - 0.5;
      values[j * GRID + i] = spot(shape, u, v);
    }
  }
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => values[b] - values[a]);

  const table = new Float32Array(n);
  let k = 0;
  while (k < n) {
    let e = k + 1;
    while (e < n && values[order[e]] === values[order[k]]) e++;
    const mid = (k + e) / 2 / n; // mid-rank of the tie block
    for (let t = k; t < e; t++) table[order[t]] = mid;
    k = e;
  }
  tables.set(shape, table);
  return table;
}

function ranked(shape: RankedShape, u: number, v: number): number {
  const table = tableFor(shape);
  let i = Math.floor((u + 0.5) * GRID);
  let j = Math.floor((v + 0.5) * GRID);
  i = i < 0 ? 0 : i >= GRID ? GRID - 1 : i;
  j = j < 0 ? 0 : j >= GRID ? GRID - 1 : j;
  return table[j * GRID + i];
}

function concentricArea(u: number, v: number, rings: number): number {
  const r = Math.sqrt(u * u + v * v) * 2;
  const f = r * rings;
  return f - Math.floor(f);
}

function wavyArea(u: number, v: number, amp: number, freq: number): number {
  const w = v + amp * Math.sin(u * 2 * Math.PI * freq);
  return Math.min(1, Math.abs(w) * 2);
}

export function dotThreshold(
  shape: DotShape,
  u: number,
  v: number,
  opts: ShapeOptions,
): number {
  switch (shape) {
    case 'round':
    case 'square':
    case 'ellipse':
    case 'diamond':
    case 'euclidean':
    case 'line':
    case 'cross':
      return ranked(shape, u, v);
    case 'concentric':
      return Math.min(1, Math.max(0, concentricArea(u, v, opts.rings)));
    case 'wavy':
      return wavyArea(u, v, opts.waveAmplitude, opts.waveFrequency);
    case 'newsprint':
      // Deliberately heavier than the tone asks for: newsprint's dot gain.
      return Math.min(1, ranked('round', u, v) / 1.08);
    case 'stochastic':
      return 0.5; // replaced by a noise field at the call site
  }
}

/** Parabolic dot gain: mid-tones darken, ends stay pinned. */
export function applyDotGain(coverage: number, gain: number): number {
  const c = coverage < 0 ? 0 : coverage > 1 ? 1 : coverage;
  return Math.min(1, Math.max(0, c + gain * c * (1 - c) * 2));
}
