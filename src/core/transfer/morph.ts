/**
 * Isotropic morphology via the exact Euclidean distance transform.
 *
 * A square structuring element is not good enough here: it judges a 45°
 * stroke as ~41% thinner than it is, which would flag perfectly printable
 * diagonal lines and choke diagonal edges harder than a real RIP does. The
 * Felzenszwalb–Huttenlocher squared distance transform gives true disk
 * erosion and dilation in linear time.
 */

const INF = 1e20;

/** 1D squared distance transform of sampled function f (lower envelope of parabolas). */
function edt1d(
  f: Float64Array,
  n: number,
  d: Float64Array,
  v: Int32Array,
  z: Float64Array,
): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/**
 * Squared Euclidean distance from every pixel to the nearest pixel whose mask
 * value equals `feature`. With `outsideIsFeature` the area beyond the image
 * border counts as feature too — correct when eroding artwork, whose
 * surroundings are transparent.
 */
export function squaredDistance(
  mask: Uint8Array,
  width: number,
  height: number,
  feature: 0 | 1,
  outsideIsFeature: boolean,
): Float32Array {
  const out = new Float32Array(width * height);
  const n = Math.max(width, height);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);

  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      f[y] = (mask[y * width + x] !== 0 ? 1 : 0) === feature ? 0 : INF;
    }
    edt1d(f, height, d, v, z);
    for (let y = 0; y < height; y++) out[y * width + x] = d[y];
  }
  for (let y = 0; y < height; y++) {
    const base = y * width;
    for (let x = 0; x < width; x++) f[x] = out[base + x];
    edt1d(f, width, d, v, z);
    for (let x = 0; x < width; x++) out[base + x] = d[x];
  }

  if (outsideIsFeature) {
    for (let y = 0; y < height; y++) {
      const dy = Math.min(y + 1, height - y);
      for (let x = 0; x < width; x++) {
        const edge = Math.min(dy, x + 1, width - x);
        const e2 = edge * edge;
        if (e2 < out[y * width + x]) out[y * width + x] = e2;
      }
    }
  }
  return out;
}

/** Keep pixels whose distance to the background exceeds `radius`. */
export function erodeDisk(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const out = new Uint8Array(width * height);
  if (radius <= 0) {
    for (let i = 0; i < out.length; i++) out[i] = mask[i] !== 0 ? 1 : 0;
    return out;
  }
  const dist = squaredDistance(mask, width, height, 0, true);
  const r2 = radius * radius;
  for (let i = 0; i < out.length; i++) out[i] = mask[i] !== 0 && dist[i] > r2 ? 1 : 0;
  return out;
}

/** Every pixel within `radius` of an ink pixel. */
export function dilateDisk(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const out = new Uint8Array(width * height);
  if (radius <= 0) {
    for (let i = 0; i < out.length; i++) out[i] = mask[i] !== 0 ? 1 : 0;
    return out;
  }
  const dist = squaredDistance(mask, width, height, 1, false);
  const r2 = radius * radius;
  for (let i = 0; i < out.length; i++) out[i] = dist[i] <= r2 ? 1 : 0;
  return out;
}

/** Opening: removes every part narrower than the disk of the given radius. */
export function openDisk(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  return dilateDisk(erodeDisk(mask, width, height, radius), width, height, radius);
}
