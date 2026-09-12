/**
 * Scan-order helpers for sequential algorithms.
 */

/** Serpentine row direction: left-to-right on even rows, reversed on odd. */
export function rowDirection(y: number, serpentine: boolean): 1 | -1 {
  return serpentine && (y & 1) === 1 ? -1 : 1;
}

/**
 * Hilbert curve index -> (x, y) on a 2^order grid.
 * Standard bit-interleaving construction; exact, no approximation.
 */
export function hilbertD2XY(order: number, d: number): [number, number] {
  const n = 1 << order;
  let rx = 0;
  let ry = 0;
  let t = d;
  let x = 0;
  let y = 0;
  for (let s = 1; s < n; s <<= 1) {
    rx = 1 & (t >> 1);
    ry = 1 & (t ^ rx);
    // rotate
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      const tmp = x;
      x = y;
      y = tmp;
    }
    x += s * rx;
    y += s * ry;
    t >>= 2;
  }
  return [x, y];
}

/** Smallest power-of-two order whose grid covers width x height. */
export function hilbertOrderFor(width: number, height: number): number {
  let order = 0;
  while (1 << order < Math.max(width, height)) order++;
  return order;
}
