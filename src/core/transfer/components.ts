/**
 * Connected-component analysis on binary masks, run-length based.
 *
 * Every horizontal run of equal pixels is a node; runs on consecutive rows
 * that touch are merged with union-find. Memory scales with the number of
 * runs, not pixels — a 35-megapixel print mostly made of dots and solid
 * areas has far fewer runs than pixels, which is what keeps full-resolution
 * cleanup affordable in a browser worker.
 *
 * Ink uses 8-connectivity and background 4-connectivity. That pairing is the
 * standard one: it guarantees a closed ink outline encloses its hole, so the
 * two passes never disagree about what is inside what.
 */

export interface ComponentInfo {
  /** Root id per run. */
  readonly rootOfRun: Int32Array;
  readonly runStart: Int32Array;
  readonly runEnd: Int32Array;
  readonly runRow: Int32Array;
  readonly runCount: number;
  /** Area per root id (only meaningful at root indices). */
  readonly area: Float64Array;
  /** 1 if any run of the component touches the image border. */
  readonly touchesBorder: Uint8Array;
}

class Growable {
  data: Int32Array;
  length = 0;
  constructor(initial: number) {
    this.data = new Int32Array(Math.max(16, initial));
  }
  push(v: number): void {
    if (this.length === this.data.length) {
      const next = new Int32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = v;
  }
  view(): Int32Array {
    return this.data.subarray(0, this.length);
  }
}

function find(parent: Int32Array, i: number): number {
  let x = i;
  while (parent[x] !== x) {
    parent[x] = parent[parent[x]];
    x = parent[x];
  }
  return x;
}

function union(parent: Int32Array, a: number, b: number): void {
  const ra = find(parent, a);
  const rb = find(parent, b);
  if (ra === rb) return;
  if (ra < rb) parent[rb] = ra;
  else parent[ra] = rb;
}

/**
 * Label every component of pixels equal to `value`.
 * `connectivity` 8 for ink, 4 for background.
 */
export function analyzeComponents(
  mask: Uint8Array,
  width: number,
  height: number,
  value: 0 | 1,
  connectivity: 4 | 8,
): ComponentInfo {
  const starts = new Growable(width);
  const ends = new Growable(width);
  const rows = new Growable(width);
  const rowFirst = new Int32Array(height + 1);

  for (let y = 0; y < height; y++) {
    rowFirst[y] = starts.length;
    const base = y * width;
    let x = 0;
    while (x < width) {
      if ((mask[base + x] !== 0 ? 1 : 0) !== value) {
        x++;
        continue;
      }
      const s = x;
      while (x < width && (mask[base + x] !== 0 ? 1 : 0) === value) x++;
      starts.push(s);
      ends.push(x);
      rows.push(y);
    }
  }
  rowFirst[height] = starts.length;

  const runCount = starts.length;
  const runStart = starts.view();
  const runEnd = ends.view();
  const runRow = rows.view();
  const parent = new Int32Array(runCount);
  for (let i = 0; i < runCount; i++) parent[i] = i;

  // 8-connected runs touch if their spans overlap after widening by one pixel.
  const reach = connectivity === 8 ? 1 : 0;
  for (let y = 1; y < height; y++) {
    let i = rowFirst[y - 1];
    const iEnd = rowFirst[y];
    let j = rowFirst[y];
    const jEnd = rowFirst[y + 1];
    while (i < iEnd && j < jEnd) {
      const a0 = runStart[i];
      const a1 = runEnd[i];
      const b0 = runStart[j];
      const b1 = runEnd[j];
      if (a0 < b1 + reach && b0 < a1 + reach) union(parent, i, j);
      if (a1 <= b1) i++;
      else j++;
    }
  }

  const rootOfRun = new Int32Array(runCount);
  const area = new Float64Array(runCount);
  const touchesBorder = new Uint8Array(runCount);
  for (let r = 0; r < runCount; r++) {
    const root = find(parent, r);
    rootOfRun[r] = root;
    area[root] += runEnd[r] - runStart[r];
    if (
      runRow[r] === 0 ||
      runRow[r] === height - 1 ||
      runStart[r] === 0 ||
      runEnd[r] === width
    ) {
      touchesBorder[root] = 1;
    }
  }

  return { rootOfRun, runStart, runEnd, runRow, runCount, area, touchesBorder };
}

/** Paint every run of the components selected by `pick` with `value`. */
function paint(
  mask: Uint8Array,
  width: number,
  info: ComponentInfo,
  pick: (root: number) => boolean,
  value: number,
): number {
  let painted = 0;
  const seen = new Set<number>();
  for (let r = 0; r < info.runCount; r++) {
    const root = info.rootOfRun[r];
    if (!pick(root)) continue;
    seen.add(root);
    const base = info.runRow[r] * width;
    mask.fill(value, base + info.runStart[r], base + info.runEnd[r]);
  }
  painted = seen.size;
  return painted;
}

/**
 * Remove ink components smaller than `minArea` pixels. Components touching
 * the border are kept when `keepBorder` is set — in a cropped preview their
 * true size is unknown.
 */
export function removeSmallInk(
  mask: Uint8Array,
  width: number,
  height: number,
  minArea: number,
  keepBorder = false,
): number {
  if (minArea <= 1) return 0;
  const info = analyzeComponents(mask, width, height, 1, 8);
  return paint(
    mask,
    width,
    info,
    (root) => info.area[root] < minArea && !(keepBorder && info.touchesBorder[root] === 1),
    0,
  );
}

/**
 * Fill enclosed transparent holes smaller than `maxArea` pixels. Background
 * that reaches the border is never a hole.
 */
export function fillSmallHoles(
  mask: Uint8Array,
  width: number,
  height: number,
  maxArea: number,
): number {
  if (maxArea <= 1) return 0;
  const info = analyzeComponents(mask, width, height, 0, 4);
  return paint(
    mask,
    width,
    info,
    (root) => info.area[root] < maxArea && info.touchesBorder[root] === 0,
    1,
  );
}

/**
 * Ink components that have no pixel inside `support`. Used to find dots whose
 * white underbase the RIP's choke removes completely. Returns the count, the
 * total area in pixels, and a mask marking those components.
 */
export function unsupportedInk(
  ink: Uint8Array,
  support: Uint8Array,
  width: number,
  height: number,
): { count: number; area: number; mask: Uint8Array } {
  const info = analyzeComponents(ink, width, height, 1, 8);
  const supported = new Uint8Array(info.runCount);
  for (let r = 0; r < info.runCount; r++) {
    const root = info.rootOfRun[r];
    if (supported[root] === 1) continue;
    const base = info.runRow[r] * width;
    for (let x = info.runStart[r]; x < info.runEnd[r]; x++) {
      if (support[base + x] !== 0) {
        supported[root] = 1;
        break;
      }
    }
  }
  const mask = new Uint8Array(width * height);
  let count = 0;
  let area = 0;
  const counted = new Uint8Array(info.runCount);
  for (let r = 0; r < info.runCount; r++) {
    const root = info.rootOfRun[r];
    if (supported[root] === 1) continue;
    if (counted[root] === 0) {
      counted[root] = 1;
      count++;
      area += info.area[root];
    }
    const base = info.runRow[r] * width;
    mask.fill(1, base + info.runStart[r], base + info.runEnd[r]);
  }
  return { count, area, mask };
}
