import type { Palette, PixelBuffer } from '../types';
import { Rng } from '../rng';

export type ExtractMethod = 'medianCut' | 'kmeans' | 'octree';

/** Subsample the image into a flat RGB list; keeps extraction fast and stable. */
function sampleColors(src: PixelBuffer, maxSamples: number): Float32Array {
  const total = src.width * src.height;
  const stride = Math.max(1, Math.floor(total / maxSamples));
  const count = Math.floor((total + stride - 1) / stride);
  const out = new Float32Array(count * 3);
  const d = src.data;
  let o = 0;
  for (let p = 0; p < total; p += stride) {
    const i = p * 4;
    if (d[i + 3] < 0.5) continue; // ignore transparent pixels
    out[o++] = d[i];
    out[o++] = d[i + 1];
    out[o++] = d[i + 2];
  }
  return out.subarray(0, o);
}

// ---------------------------------------------------------------------------
// Median cut
// ---------------------------------------------------------------------------

interface Box {
  start: number;
  end: number; // exclusive, in pixel units
  rMin: number; rMax: number;
  gMin: number; gMax: number;
  bMin: number; bMax: number;
}

function shrinkBox(px: Float32Array, box: Box): void {
  let rMin = 1, rMax = 0, gMin = 1, gMax = 0, bMin = 1, bMax = 0;
  for (let i = box.start; i < box.end; i++) {
    const r = px[i * 3], g = px[i * 3 + 1], b = px[i * 3 + 2];
    if (r < rMin) rMin = r; if (r > rMax) rMax = r;
    if (g < gMin) gMin = g; if (g > gMax) gMax = g;
    if (b < bMin) bMin = b; if (b > bMax) bMax = b;
  }
  box.rMin = rMin; box.rMax = rMax;
  box.gMin = gMin; box.gMax = gMax;
  box.bMin = bMin; box.bMax = bMax;
}

function sortRange(px: Float32Array, start: number, end: number, channel: number): void {
  // Extract, sort indices by channel, write back. Simple and deterministic.
  const n = end - start;
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  const keys = new Float32Array(n);
  for (let i = 0; i < n; i++) keys[i] = px[(start + i) * 3 + channel];
  const order = Array.from(idx).sort((a, b) => keys[a] - keys[b] || a - b);
  const copy = px.slice(start * 3, end * 3);
  for (let i = 0; i < n; i++) {
    const s = order[i] * 3;
    const d = (start + i) * 3;
    px[d] = copy[s];
    px[d + 1] = copy[s + 1];
    px[d + 2] = copy[s + 2];
  }
}

/**
 * Heckbert's median cut: repeatedly split the box with the largest colour
 * extent at the median of its longest axis.
 */
export function medianCut(src: PixelBuffer, colorCount: number): Float32Array {
  const px = new Float32Array(sampleColors(src, 65536));
  const pixels = px.length / 3;
  if (pixels === 0) return new Float32Array([0, 0, 0]);

  const boxes: Box[] = [
    { start: 0, end: pixels, rMin: 0, rMax: 1, gMin: 0, gMax: 1, bMin: 0, bMax: 1 },
  ];
  shrinkBox(px, boxes[0]);

  while (boxes.length < colorCount) {
    let bestIdx = -1;
    let bestExtent = 0;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.end - b.start < 2) continue;
      const extent = Math.max(b.rMax - b.rMin, b.gMax - b.gMin, b.bMax - b.bMin);
      if (extent > bestExtent) {
        bestExtent = extent;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;

    const box = boxes[bestIdx];
    const dr = box.rMax - box.rMin;
    const dg = box.gMax - box.gMin;
    const db = box.bMax - box.bMin;
    const channel = dr >= dg && dr >= db ? 0 : dg >= db ? 1 : 2;
    sortRange(px, box.start, box.end, channel);

    const mid = box.start + ((box.end - box.start) >> 1);
    const left: Box = { ...box, end: mid };
    const right: Box = { ...box, start: mid };
    shrinkBox(px, left);
    shrinkBox(px, right);
    boxes.splice(bestIdx, 1, left, right);
  }

  const out = new Float32Array(boxes.length * 3);
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    let r = 0, g = 0, bl = 0;
    const n = b.end - b.start;
    for (let p = b.start; p < b.end; p++) {
      r += px[p * 3];
      g += px[p * 3 + 1];
      bl += px[p * 3 + 2];
    }
    out[i * 3] = n > 0 ? r / n : 0;
    out[i * 3 + 1] = n > 0 ? g / n : 0;
    out[i * 3 + 2] = n > 0 ? bl / n : 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// k-means (Lloyd) with k-means++ seeding
// ---------------------------------------------------------------------------

export function kmeans(src: PixelBuffer, colorCount: number, seed = 1, iterations = 24): Float32Array {
  const px = sampleColors(src, 32768);
  const n = px.length / 3;
  if (n === 0) return new Float32Array([0, 0, 0]);
  const k = Math.min(colorCount, n);
  const rng = new Rng(seed);

  const centers = new Float32Array(k * 3);
  // k-means++ seeding
  {
    const first = rng.nextInt(n);
    centers[0] = px[first * 3];
    centers[1] = px[first * 3 + 1];
    centers[2] = px[first * 3 + 2];
    const d2 = new Float32Array(n).fill(Infinity);
    for (let c = 1; c < k; c++) {
      let sum = 0;
      const cr = centers[(c - 1) * 3];
      const cg = centers[(c - 1) * 3 + 1];
      const cb = centers[(c - 1) * 3 + 2];
      for (let i = 0; i < n; i++) {
        const dr = px[i * 3] - cr;
        const dg = px[i * 3 + 1] - cg;
        const db = px[i * 3 + 2] - cb;
        const d = dr * dr + dg * dg + db * db;
        if (d < d2[i]) d2[i] = d;
        sum += d2[i];
      }
      let target = rng.next() * sum;
      let pick = n - 1;
      for (let i = 0; i < n; i++) {
        target -= d2[i];
        if (target <= 0) {
          pick = i;
          break;
        }
      }
      centers[c * 3] = px[pick * 3];
      centers[c * 3 + 1] = px[pick * 3 + 1];
      centers[c * 3 + 2] = px[pick * 3 + 2];
    }
  }

  const sums = new Float64Array(k * 3);
  const counts = new Uint32Array(k);
  for (let iter = 0; iter < iterations; iter++) {
    sums.fill(0);
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      const r = px[i * 3], g = px[i * 3 + 1], b = px[i * 3 + 2];
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const dr = r - centers[c * 3];
        const dg = g - centers[c * 3 + 1];
        const db = b - centers[c * 3 + 2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      sums[best * 3] += r;
      sums[best * 3 + 1] += g;
      sums[best * 3 + 2] += b;
      counts[best]++;
    }
    let moved = 0;
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) continue;
      const inv = 1 / counts[c];
      const nr = sums[c * 3] * inv;
      const ng = sums[c * 3 + 1] * inv;
      const nb = sums[c * 3 + 2] * inv;
      moved += Math.abs(nr - centers[c * 3]) + Math.abs(ng - centers[c * 3 + 1]) +
        Math.abs(nb - centers[c * 3 + 2]);
      centers[c * 3] = nr;
      centers[c * 3 + 1] = ng;
      centers[c * 3 + 2] = nb;
    }
    if (moved < 1e-5) break;
  }
  return centers;
}

// ---------------------------------------------------------------------------
// Octree
// ---------------------------------------------------------------------------

interface OctNode {
  isLeaf: boolean;
  count: number;
  r: number; g: number; b: number;
  children: (OctNode | null)[];
  level: number;
}

function newNode(level: number): OctNode {
  return {
    isLeaf: level >= 8,
    count: 0, r: 0, g: 0, b: 0,
    children: [null, null, null, null, null, null, null, null],
    level,
  };
}

/**
 * Gervautz–Purgathofer octree quantisation: insert every colour into an
 * 8-level octree, then repeatedly fold the deepest, least populated node back
 * into its parent until the leaf count matches the requested palette size.
 */
export function octree(src: PixelBuffer, colorCount: number): Float32Array {
  const px = sampleColors(src, 65536);
  const n = px.length / 3;
  if (n === 0) return new Float32Array([0, 0, 0]);

  const root = newNode(0);
  const levels: OctNode[][] = [[], [], [], [], [], [], [], []];
  let leaves = 0;

  const insert = (r: number, g: number, b: number): void => {
    const ri = Math.min(255, Math.max(0, Math.round(r * 255)));
    const gi = Math.min(255, Math.max(0, Math.round(g * 255)));
    const bi = Math.min(255, Math.max(0, Math.round(b * 255)));
    let node = root;
    for (let level = 0; level < 8; level++) {
      if (node.isLeaf) break;
      const shift = 7 - level;
      const idx =
        (((ri >> shift) & 1) << 2) | (((gi >> shift) & 1) << 1) | ((bi >> shift) & 1);
      let child = node.children[idx];
      if (child === null) {
        child = newNode(level + 1);
        node.children[idx] = child;
        if (child.isLeaf) leaves++;
        else levels[level].push(child);
      }
      node = child;
    }
    node.count++;
    node.r += r;
    node.g += g;
    node.b += b;
    if (!node.isLeaf && node.count === 1) leaves++;
    if (!node.isLeaf) node.isLeaf = false;
  };

  for (let i = 0; i < n; i++) insert(px[i * 3], px[i * 3 + 1], px[i * 3 + 2]);

  const fold = (node: OctNode): number => {
    let removed = 0;
    for (let i = 0; i < 8; i++) {
      const c = node.children[i];
      if (c === null) continue;
      node.count += c.count;
      node.r += c.r;
      node.g += c.g;
      node.b += c.b;
      node.children[i] = null;
      removed++;
    }
    node.isLeaf = true;
    return removed > 0 ? removed - 1 : 0;
  };

  for (let level = 6; level >= 0 && leaves > colorCount; level--) {
    const bucket = levels[level];
    bucket.sort((a, b) => a.count - b.count);
    for (const node of bucket) {
      if (leaves <= colorCount) break;
      if (node.isLeaf) continue;
      leaves -= fold(node);
    }
  }

  const out: number[] = [];
  const collect = (node: OctNode): void => {
    if (node.isLeaf || node.children.every((c) => c === null)) {
      if (node.count > 0) {
        out.push(node.r / node.count, node.g / node.count, node.b / node.count);
      }
      return;
    }
    for (const c of node.children) if (c !== null) collect(c);
  };
  collect(root);

  if (out.length === 0) return new Float32Array([0, 0, 0]);
  return new Float32Array(out.slice(0, colorCount * 3));
}

/** Sort a flat palette dark -> light so UI lists and ramps look sane. */
export function sortByLuma(colors: Float32Array): Float32Array {
  const n = colors.length / 3;
  const idx = Array.from({ length: n }, (_, i) => i);
  const luma = (i: number): number =>
    0.299 * colors[i * 3] + 0.587 * colors[i * 3 + 1] + 0.114 * colors[i * 3 + 2];
  idx.sort((a, b) => luma(a) - luma(b) || a - b);
  const out = new Float32Array(colors.length);
  for (let i = 0; i < n; i++) {
    out[i * 3] = colors[idx[i] * 3];
    out[i * 3 + 1] = colors[idx[i] * 3 + 1];
    out[i * 3 + 2] = colors[idx[i] * 3 + 2];
  }
  return out;
}

export function extractPalette(
  src: PixelBuffer,
  method: ExtractMethod,
  colorCount: number,
  seed = 1,
): Palette {
  const count = Math.max(2, Math.min(256, Math.round(colorCount)));
  let colors: Float32Array;
  switch (method) {
    case 'medianCut': colors = medianCut(src, count); break;
    case 'kmeans': colors = kmeans(src, count, seed); break;
    case 'octree': colors = octree(src, count); break;
  }
  return {
    id: `extracted:${method}:${count}:${seed}`,
    name: `Kinyert (${method}, ${colors.length / 3})`,
    category: 'Kinyert',
    colors: sortByLuma(colors),
  };
}
