import { hashNoise2D, Rng } from '../../rng';

/** A threshold matrix: `size` x `size` values in (0, 1). */
export interface ThresholdMatrix {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly data: Float32Array;
}

function fromRanks(id: string, name: string, size: number, ranks: Int32Array): ThresholdMatrix {
  const n = size * size;
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = (ranks[i] + 0.5) / n;
  return { id, name, size, data };
}

// ---------------------------------------------------------------------------
// Bayer
// ---------------------------------------------------------------------------

/**
 * Recursive Bayer construction:
 *   M_1 = [0]
 *   M_2n = [ 4*M_n + 0 , 4*M_n + 2 ;
 *            4*M_n + 3 , 4*M_n + 1 ]
 */
export function bayerRanks(size: number): Int32Array {
  if ((size & (size - 1)) !== 0) throw new Error('Bayer size must be a power of two.');
  let cur = new Int32Array([0]);
  let curSize = 1;
  while (curSize < size) {
    const next = new Int32Array(curSize * 2 * curSize * 2);
    const ns = curSize * 2;
    for (let y = 0; y < curSize; y++) {
      for (let x = 0; x < curSize; x++) {
        const v = cur[y * curSize + x] * 4;
        next[y * ns + x] = v;
        next[y * ns + (x + curSize)] = v + 2;
        next[(y + curSize) * ns + x] = v + 3;
        next[(y + curSize) * ns + (x + curSize)] = v + 1;
      }
    }
    cur = next;
    curSize = ns;
  }
  return cur;
}

export function bayer(size: number): ThresholdMatrix {
  return fromRanks(`bayer${size}`, `Bayer ${size}×${size}`, size, bayerRanks(size));
}

// ---------------------------------------------------------------------------
// Void-and-cluster (blue noise)
// ---------------------------------------------------------------------------

/**
 * Ulichney's void-and-cluster algorithm.
 *
 * A Gaussian energy field over the torus records how clustered the minority
 * pixels are. Phase 1 removes the tightest cluster repeatedly and ranks
 * downwards from the initial pattern; phase 2 fills the largest void
 * repeatedly and ranks upwards.
 *
 * Note on phase 3: on a torus the total filtered energy at any position is a
 * constant, so "tightest cluster of zeros" and "largest void" select the same
 * pixel. Phases 2 and 3 therefore collapse into one loop here — this is an
 * identity, not a shortcut.
 */
export function voidAndClusterRanks(size: number, sigma = 1.5, seed = 1): Int32Array {
  const n = size * size;
  const binary = new Uint8Array(n);
  const energy = new Float64Array(n);
  const ranks = new Int32Array(n).fill(-1);

  const radius = Math.max(2, Math.ceil(sigma * 3));
  const kernelSide = radius * 2 + 1;
  const kernel = new Float64Array(kernelSide * kernelSide);
  const inv2s2 = 1 / (2 * sigma * sigma);
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      kernel[(dy + radius) * kernelSide + (dx + radius)] = Math.exp(-(dx * dx + dy * dy) * inv2s2);
    }
  }

  const splat = (index: number, sign: number): void => {
    const px = index % size;
    const py = (index / size) | 0;
    for (let dy = -radius; dy <= radius; dy++) {
      const y = (((py + dy) % size) + size) % size;
      for (let dx = -radius; dx <= radius; dx++) {
        const x = (((px + dx) % size) + size) % size;
        energy[y * size + x] += sign * kernel[(dy + radius) * kernelSide + (dx + radius)];
      }
    }
  };

  const tightestCluster = (): number => {
    let best = -1;
    let bestE = -Infinity;
    for (let i = 0; i < n; i++) {
      if (binary[i] === 1 && energy[i] > bestE) {
        bestE = energy[i];
        best = i;
      }
    }
    return best;
  };

  const largestVoid = (): number => {
    let best = -1;
    let bestE = Infinity;
    for (let i = 0; i < n; i++) {
      if (binary[i] === 0 && energy[i] < bestE) {
        bestE = energy[i];
        best = i;
      }
    }
    return best;
  };

  // --- Initial binary pattern -------------------------------------------
  const initialOnes = Math.max(1, Math.round(n * 0.1));
  const rng = new Rng(seed);
  let placed = 0;
  while (placed < initialOnes) {
    const i = rng.nextInt(n);
    if (binary[i] === 1) continue;
    binary[i] = 1;
    splat(i, 1);
    placed++;
  }

  for (let guard = 0; guard < n * 4; guard++) {
    const c = tightestCluster();
    binary[c] = 0;
    splat(c, -1);
    const v = largestVoid();
    if (v === c) {
      binary[c] = 1;
      splat(c, 1);
      break;
    }
    binary[v] = 1;
    splat(v, 1);
  }

  const initial = binary.slice();
  const initialEnergy = energy.slice();

  // --- Phase 1: rank downwards by removing the tightest cluster ----------
  for (let rank = initialOnes - 1; rank >= 0; rank--) {
    const c = tightestCluster();
    if (c < 0) break;
    binary[c] = 0;
    splat(c, -1);
    ranks[c] = rank;
  }

  // --- Phase 2 (+3): rank upwards by filling the largest void ------------
  binary.set(initial);
  energy.set(initialEnergy);
  for (let rank = initialOnes; rank < n; rank++) {
    const v = largestVoid();
    if (v < 0) break;
    binary[v] = 1;
    splat(v, 1);
    ranks[v] = rank;
  }

  for (let i = 0; i < n; i++) if (ranks[i] < 0) ranks[i] = 0;
  return ranks;
}

const generatedCache = new Map<string, ThresholdMatrix>();

function cached(key: string, build: () => ThresholdMatrix): ThresholdMatrix {
  const hit = generatedCache.get(key);
  if (hit) return hit;
  const m = build();
  generatedCache.set(key, m);
  return m;
}

export function blueNoise(size: number, sigma = 1.5, seed = 1): ThresholdMatrix {
  return cached(`vac:${size}:${sigma}:${seed}`, () =>
    fromRanks(
      `blue-noise${size}`,
      `Kék zaj ${size}×${size}`,
      size,
      voidAndClusterRanks(size, sigma, seed),
    ),
  );
}

// ---------------------------------------------------------------------------
// Analytic patterns
// ---------------------------------------------------------------------------

/** Bit-reversal permutation, used to grow line screens evenly. */
function bitReverse(value: number, bits: number): number {
  let r = 0;
  for (let i = 0; i < bits; i++) r |= ((value >> i) & 1) << (bits - 1 - i);
  return r;
}

export function lineScreen(
  size: number,
  orientation: 'horizontal' | 'vertical' | 'diagonal' | 'antiDiagonal',
): ThresholdMatrix {
  const bits = Math.round(Math.log2(size));
  const data = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let coord: number;
      switch (orientation) {
        case 'horizontal': coord = y; break;
        case 'vertical': coord = x; break;
        case 'diagonal': coord = (x + y) % size; break;
        case 'antiDiagonal': coord = (x - y + size * 2) % size; break;
      }
      const rank = (1 << bits) === size ? bitReverse(coord, bits) : coord;
      data[y * size + x] = (rank + 0.5) / size;
    }
  }
  const names: Record<string, string> = {
    horizontal: 'Vízszintes vonalraszter',
    vertical: 'Függőleges vonalraszter',
    diagonal: '45°-os vonalraszter',
    antiDiagonal: '135°-os vonalraszter',
  };
  return { id: `line-${orientation}${size}`, name: names[orientation], size, data };
}

export function crossHatch(size: number): ThresholdMatrix {
  const h = lineScreen(size, 'horizontal');
  const v = lineScreen(size, 'vertical');
  const data = new Float32Array(size * size);
  for (let i = 0; i < data.length; i++) data[i] = Math.min(h.data[i], v.data[i]);
  return { id: `cross-hatch${size}`, name: `Keresztraszter ${size}`, size, data };
}

export function diagonalWeave(size: number): ThresholdMatrix {
  const a = lineScreen(size, 'diagonal');
  const b = lineScreen(size, 'antiDiagonal');
  const data = new Float32Array(size * size);
  for (let i = 0; i < data.length; i++) data[i] = (a.data[i] + b.data[i]) * 0.5;
  return { id: `weave${size}`, name: `Átlós szövet ${size}`, size, data };
}

export function checkerboard(): ThresholdMatrix {
  return { id: 'checker', name: 'Sakktábla', size: 2, data: new Float32Array([0.25, 0.75, 0.75, 0.25]) };
}

/**
 * Clustered dot: cells are ranked by distance from the cell centre, so the
 * dot grows outward as tone darkens — the behaviour of a classic AM screen.
 */
export function clusteredDot(size: number): ThresholdMatrix {
  const n = size * size;
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const order = Array.from({ length: n }, (_, i) => i);
  const key = (i: number): number => {
    const x = i % size;
    const y = (i / size) | 0;
    const dx = x - cx;
    const dy = y - cy;
    // Radius first, angle as a stable tie-break.
    return Math.sqrt(dx * dx + dy * dy) * 1000 + (Math.atan2(dy, dx) + Math.PI);
  };
  order.sort((a, b) => key(a) - key(b) || a - b);
  const ranks = new Int32Array(n);
  for (let r = 0; r < n; r++) ranks[order[r]] = r;
  return fromRanks(`clustered${size}`, `Tömör pont ${size}×${size}`, size, ranks);
}

/** Archimedean spiral ordering: the dot unwinds instead of growing radially. */
export function spiralDot(size: number): ThresholdMatrix {
  const n = size * size;
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const order = Array.from({ length: n }, (_, i) => i);
  const key = (i: number): number => {
    const x = i % size;
    const y = (i / size) | 0;
    const dx = x - cx;
    const dy = y - cy;
    const r = Math.sqrt(dx * dx + dy * dy);
    const a = (Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI);
    return r + a;
  };
  order.sort((a, b) => key(a) - key(b) || a - b);
  const ranks = new Int32Array(n);
  for (let r = 0; r < n; r++) ranks[order[r]] = r;
  return fromRanks(`spiral${size}`, `Spirál pont ${size}×${size}`, size, ranks);
}

/**
 * Odd-order magic square via the Siamese (de la Loubère) method. Every row,
 * column and diagonal sums equally, which yields a very even, slightly woven
 * threshold pattern.
 */
export function magicSquare(size: number): ThresholdMatrix {
  if (size % 2 === 0) throw new Error('Magic square generator requires an odd size.');
  const grid = new Int32Array(size * size).fill(-1);
  let x = (size - 1) >> 1;
  let y = 0;
  for (let v = 0; v < size * size; v++) {
    grid[y * size + x] = v;
    const nx = (x + 1) % size;
    const ny = (y - 1 + size) % size;
    if (grid[ny * size + nx] >= 0) {
      y = (y + 1) % size;
    } else {
      x = nx;
      y = ny;
    }
  }
  return fromRanks(`magic${size}`, `Bűvös négyzet ${size}×${size}`, size, grid);
}

/** White noise: uncorrelated, deterministic per (x, y). */
export function whiteNoiseValue(x: number, y: number, seed: number): number {
  return hashNoise2D(x, y, seed);
}

/**
 * Interleaved gradient noise (Jimenez). Cheap, temporally stable and visually
 * far better than white noise for a screen-space threshold.
 */
export function interleavedGradientNoise(x: number, y: number): number {
  const v = 52.9829189 * ((0.06711056 * x + 0.00583715 * y) % 1);
  return v - Math.floor(v);
}

/** Parse a whitespace/comma separated square grid of numbers into a matrix. */
export function parseMatrixText(text: string): ThresholdMatrix {
  const rows = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(/[\s,;]+/).map(Number));
  if (rows.length === 0) throw new Error('Üres mátrix.');
  const size = rows.length;
  if (rows.some((r) => r.length !== size)) throw new Error('A mátrixnak négyzetesnek kell lennie.');
  if (rows.some((r) => r.some((v) => !Number.isFinite(v)))) {
    throw new Error('A mátrix nem numerikus értéket tartalmaz.');
  }
  const flat = rows.flat();
  const min = Math.min(...flat);
  const max = Math.max(...flat);
  const range = max - min;
  const data = new Float32Array(size * size);
  for (let i = 0; i < flat.length; i++) {
    data[i] = range === 0 ? 0.5 : (flat[i] - min + 0.5) / (range + 1);
  }
  return { id: 'custom-matrix', name: 'Egyedi mátrix', size, data };
}

export const STATIC_MATRICES: readonly ThresholdMatrix[] = [
  bayer(2), bayer(4), bayer(8), bayer(16), bayer(32),
  checkerboard(),
  clusteredDot(4), clusteredDot(6), clusteredDot(8),
  spiralDot(8),
  magicSquare(5), magicSquare(7),
  lineScreen(8, 'horizontal'),
  lineScreen(8, 'vertical'),
  lineScreen(8, 'diagonal'),
  lineScreen(8, 'antiDiagonal'),
  crossHatch(8),
  diagonalWeave(8),
];
