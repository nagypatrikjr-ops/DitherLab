import type { PixelBuffer } from '../types';
import { lumaSrgb } from '../color/space';

export type Point = readonly [number, number];
export type Ring = Point[];

/**
 * Convert a rendered buffer to a binary ink mask.
 * `invert` swaps which side of the threshold counts as ink.
 */
export function toMask(src: PixelBuffer, threshold = 0.5, invert = false): Uint8Array {
  const n = src.width * src.height;
  const mask = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const l = lumaSrgb(src.data[i], src.data[i + 1], src.data[i + 2]);
    const ink = l < threshold;
    mask[p] = (invert ? !ink : ink) ? 1 : 0;
  }
  return mask;
}

/**
 * Trace the boundaries of an ink mask as closed rectilinear rings.
 *
 * Every ink pixel contributes the unit edges that separate it from a
 * background pixel, oriented so that ink always lies to the same side. The
 * edges are then chained into closed loops. At a diagonal pinch (two ink
 * pixels touching only at a corner) two edges leave the same lattice vertex;
 * the walker takes the sharpest turn, which keeps the two regions separate
 * instead of fusing them into a self-touching loop.
 *
 * The result is pixel exact: no curve fitting, no corner rounding. That is
 * deliberate — an embroidery or cutting path must follow the actual dot.
 */
export function traceRings(mask: Uint8Array, width: number, height: number): Ring[] {
  const vStride = width + 1;
  const at = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= width || y >= height ? 0 : mask[y * width + x];

  // Directed edges keyed by their start vertex.
  const outgoing = new Map<number, number[]>();
  const addEdge = (ax: number, ay: number, bx: number, by: number): void => {
    const a = ay * vStride + ax;
    const b = by * vStride + bx;
    const list = outgoing.get(a);
    if (list) list.push(b);
    else outgoing.set(a, [b]);
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (at(x, y) === 0) continue;
      if (at(x, y - 1) === 0) addEdge(x, y, x + 1, y);
      if (at(x + 1, y) === 0) addEdge(x + 1, y, x + 1, y + 1);
      if (at(x, y + 1) === 0) addEdge(x + 1, y + 1, x, y + 1);
      if (at(x - 1, y) === 0) addEdge(x, y + 1, x, y);
    }
  }

  const rings: Ring[] = [];
  const vx = (v: number): number => v % vStride;
  const vy = (v: number): number => Math.floor(v / vStride);

  for (const [startVertex, list] of outgoing) {
    while (list.length > 0) {
      const ring: Point[] = [];
      let current = startVertex;
      let next = list.pop();
      if (next === undefined) break;
      let px = vx(current);
      let py = vy(current);
      ring.push([px, py]);

      let guard = 0;
      const maxSteps = width * height * 4 + 16;
      while (next !== undefined && guard++ < maxSteps) {
        const nx = vx(next);
        const ny = vy(next);
        ring.push([nx, ny]);
        if (next === startVertex) break;

        const dirX = nx - px;
        const dirY = ny - py;
        const candidates = outgoing.get(next);
        if (!candidates || candidates.length === 0) break;

        let pick = 0;
        if (candidates.length > 1) {
          // Prefer the sharpest right turn: cross product then dot product.
          let bestScore = -Infinity;
          for (let i = 0; i < candidates.length; i++) {
            const cx = vx(candidates[i]) - nx;
            const cy = vy(candidates[i]) - ny;
            const cross = dirX * cy - dirY * cx;
            const dot = dirX * cx + dirY * cy;
            const score = cross > 0 ? 2 : cross < 0 ? 0 : dot > 0 ? 1 : -1;
            if (score > bestScore) {
              bestScore = score;
              pick = i;
            }
          }
        }
        const chosen = candidates[pick];
        candidates.splice(pick, 1);
        px = nx;
        py = ny;
        current = next;
        next = chosen;
      }

      if (ring.length >= 4) rings.push(ring);
    }
  }
  return rings;
}

/** Signed area (shoelace). Positive and negative distinguish winding. */
export function ringArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] * ring[i][1]) - (ring[i][0] * ring[j][1]);
  }
  return sum * 0.5;
}

/** Remove points that lie exactly on the segment between their neighbours. */
export function removeCollinear(ring: Ring): Ring {
  if (ring.length < 3) return ring;
  const out: Point[] = [];
  const n = ring.length - (
    ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? 1 : 0
  );
  for (let i = 0; i < n; i++) {
    const prev = ring[(i - 1 + n) % n];
    const cur = ring[i];
    const next = ring[(i + 1) % n];
    const cross =
      (cur[0] - prev[0]) * (next[1] - prev[1]) - (cur[1] - prev[1]) * (next[0] - prev[0]);
    if (cross !== 0) out.push(cur);
  }
  if (out.length >= 3) out.push(out[0]);
  return out.length >= 4 ? out : ring;
}

/** Perpendicular distance from p to the segment a-b. */
function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    const ex = p[0] - a[0];
    const ey = p[1] - a[1];
    return Math.sqrt(ex * ex + ey * ey);
  }
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = a[0] + t * dx;
  const cy = a[1] + t * dy;
  const ex = p[0] - cx;
  const ey = p[1] - cy;
  return Math.sqrt(ex * ex + ey * ey);
}

/** Douglas–Peucker simplification of an open polyline. */
export function douglasPeucker(points: Ring, tolerance: number): Ring {
  if (points.length < 3 || tolerance <= 0) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const seg = stack.pop();
    if (!seg) break;
    const [first, last] = seg;
    let maxDist = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = pointSegmentDistance(points[i], points[first], points[last]);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (index >= 0 && maxDist > tolerance) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  const out: Point[] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/** Simplify a closed ring, keeping it closed. */
export function simplifyRing(ring: Ring, tolerance: number): Ring {
  const cleaned = removeCollinear(ring);
  if (tolerance <= 0) return cleaned;
  const simplified = douglasPeucker(cleaned, tolerance);
  if (simplified.length < 4) return cleaned;
  const first = simplified[0];
  const last = simplified[simplified.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) simplified.push(first);
  return simplified;
}
