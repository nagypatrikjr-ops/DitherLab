/**
 * Error diffusion kernels.
 *
 * A kernel is a list of (dx, dy, weight) offsets relative to the pixel being
 * processed, plus a divisor. Only forward neighbours appear: dy > 0, or dy = 0
 * with dx > 0. Weights are the published integer coefficients; the divisor is
 * their sum unless the algorithm deliberately discards part of the error
 * (Atkinson).
 */

export interface KernelEntry {
  readonly dx: number;
  readonly dy: number;
  readonly w: number;
}

export interface DiffusionKernel {
  readonly id: string;
  readonly name: string;
  readonly divisor: number;
  readonly entries: readonly KernelEntry[];
}

function k(
  id: string,
  name: string,
  divisor: number,
  rows: readonly (readonly [number, number, number])[],
): DiffusionKernel {
  const entries = rows.map(([dx, dy, w]) => ({ dx, dy, w }));
  return { id, name, divisor, entries };
}

export const FLOYD_STEINBERG = k('floyd-steinberg', 'Floyd–Steinberg', 16, [
  [1, 0, 7],
  [-1, 1, 3], [0, 1, 5], [1, 1, 1],
]);

/**
 * The widely reproduced "false" Floyd–Steinberg: three coefficients over
 * eight. Coarser and grainier than the real thing, which is why it is kept.
 */
export const FALSE_FLOYD_STEINBERG = k('false-floyd-steinberg', '„Hibás” Floyd–Steinberg', 8, [
  [1, 0, 3],
  [0, 1, 3], [1, 1, 2],
]);

export const JARVIS = k('jarvis', 'Jarvis–Judice–Ninke', 48, [
  [1, 0, 7], [2, 0, 5],
  [-2, 1, 3], [-1, 1, 5], [0, 1, 7], [1, 1, 5], [2, 1, 3],
  [-2, 2, 1], [-1, 2, 3], [0, 2, 5], [1, 2, 3], [2, 2, 1],
]);

export const STUCKI = k('stucki', 'Stucki', 42, [
  [1, 0, 8], [2, 0, 4],
  [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2],
  [-2, 2, 1], [-1, 2, 2], [0, 2, 4], [1, 2, 2], [2, 2, 1],
]);

/** Divisor 8 with weights summing to 6: a quarter of the error is discarded. */
export const ATKINSON = k('atkinson', 'Atkinson', 8, [
  [1, 0, 1], [2, 0, 1],
  [-1, 1, 1], [0, 1, 1], [1, 1, 1],
  [0, 2, 1],
]);

export const BURKES = k('burkes', 'Burkes', 32, [
  [1, 0, 8], [2, 0, 4],
  [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2],
]);

export const SIERRA3 = k('sierra3', 'Sierra (3 soros)', 32, [
  [1, 0, 5], [2, 0, 3],
  [-2, 1, 2], [-1, 1, 4], [0, 1, 5], [1, 1, 4], [2, 1, 2],
  [-1, 2, 2], [0, 2, 3], [1, 2, 2],
]);

export const SIERRA2 = k('sierra2', 'Sierra (2 soros)', 16, [
  [1, 0, 4], [2, 0, 3],
  [-2, 1, 1], [-1, 1, 2], [0, 1, 3], [1, 1, 2], [2, 1, 1],
]);

export const SIERRA_LITE = k('sierra-lite', 'Sierra Lite', 4, [
  [1, 0, 2],
  [-1, 1, 1], [0, 1, 1],
]);

/** Fan's modification of Floyd–Steinberg: the error is pushed further left. */
export const FAN = k('fan', 'Fan', 16, [
  [1, 0, 7],
  [-2, 1, 1], [-1, 1, 3], [0, 1, 5],
]);

export const SHIAU_FAN_1 = k('shiau-fan-1', 'Shiau–Fan 1', 8, [
  [1, 0, 4],
  [-2, 1, 1], [-1, 1, 1], [0, 1, 2],
]);

export const SHIAU_FAN_2 = k('shiau-fan-2', 'Shiau–Fan 2', 16, [
  [1, 0, 8],
  [-3, 1, 1], [-2, 1, 1], [-1, 1, 2], [0, 1, 4],
]);

export const KERNELS: readonly DiffusionKernel[] = [
  FLOYD_STEINBERG,
  FALSE_FLOYD_STEINBERG,
  JARVIS,
  STUCKI,
  ATKINSON,
  BURKES,
  SIERRA3,
  SIERRA2,
  SIERRA_LITE,
  FAN,
  SHIAU_FAN_1,
  SHIAU_FAN_2,
];

/**
 * Build a kernel from a user-edited 5x3 grid. The current pixel sits at
 * column 2 of row 0; cells at or before it in row 0 are ignored because error
 * can only travel forward.
 */
export function kernelFromMatrix(values: readonly number[], cols = 5, rows = 3): DiffusionKernel {
  const originCol = (cols - 1) >> 1;
  const entries: KernelEntry[] = [];
  let sum = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const w = values[y * cols + x] ?? 0;
      if (w === 0) continue;
      const dx = x - originCol;
      if (y === 0 && dx <= 0) continue;
      entries.push({ dx, dy: y, w });
      sum += w;
    }
  }
  return {
    id: 'custom',
    name: 'Egyedi mátrix',
    divisor: sum === 0 ? 1 : sum,
    entries,
  };
}
