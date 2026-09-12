import type { DistanceMetric } from '../types';
import { srgbToLab } from './space';

/**
 * Colour difference metrics. All return a *squared-ish* magnitude suitable for
 * ranking only — never mix values from different metrics.
 */

/** Plain Euclidean distance in sRGB, squared. */
export function distRgb(
  r1: number, g1: number, b1: number,
  r2: number, g2: number, b2: number,
): number {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return dr * dr + dg * dg + db * db;
}

/**
 * "Low-cost" weighted RGB distance (Thiadmer Riemersma's redmean formulation),
 * which tracks perceived difference far better than plain RGB for little cost.
 */
export function distWeightedRgb(
  r1: number, g1: number, b1: number,
  r2: number, g2: number, b2: number,
): number {
  const rmean = (r1 + r2) * 0.5;
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return (2 + rmean) * dr * dr + 4 * dg * dg + (3 - rmean) * db * db;
}

/** CIE76: Euclidean distance in L*a*b*, squared. */
export function distCie76Lab(
  l1: number, a1: number, b1: number,
  l2: number, a2: number, b2: number,
): number {
  const dl = l1 - l2;
  const da = a1 - a2;
  const db = b1 - b2;
  return dl * dl + da * da + db * db;
}

const DEG = Math.PI / 180;

/**
 * CIEDE2000 (Sharma, Wu & Dalal 2005 formulation), returned squared so that it
 * ranks identically to the other metrics. kL = kC = kH = 1.
 */
export function distCiede2000Lab(
  l1: number, a1: number, b1: number,
  l2: number, a2: number, b2: number,
): number {
  const c1 = Math.sqrt(a1 * a1 + b1 * b1);
  const c2 = Math.sqrt(a2 * a2 + b2 * b2);
  const cBar = (c1 + c2) * 0.5;
  const cBar7 = Math.pow(cBar, 7);
  const g = 0.5 * (1 - Math.sqrt(cBar7 / (cBar7 + 6103515625))); // 25^7

  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const c1p = Math.sqrt(a1p * a1p + b1 * b1);
  const c2p = Math.sqrt(a2p * a2p + b2 * b2);

  let h1p = c1p === 0 ? 0 : Math.atan2(b1, a1p);
  if (h1p < 0) h1p += 2 * Math.PI;
  let h2p = c2p === 0 ? 0 : Math.atan2(b2, a2p);
  if (h2p < 0) h2p += 2 * Math.PI;

  const dLp = l2 - l1;
  const dCp = c2p - c1p;

  let dhp: number;
  if (c1p * c2p === 0) {
    dhp = 0;
  } else {
    dhp = h2p - h1p;
    if (dhp > Math.PI) dhp -= 2 * Math.PI;
    else if (dhp < -Math.PI) dhp += 2 * Math.PI;
  }
  const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin(dhp * 0.5);

  const lBarP = (l1 + l2) * 0.5;
  const cBarP = (c1p + c2p) * 0.5;

  let hBarP: number;
  if (c1p * c2p === 0) {
    hBarP = h1p + h2p;
  } else if (Math.abs(h1p - h2p) <= Math.PI) {
    hBarP = (h1p + h2p) * 0.5;
  } else if (h1p + h2p < 2 * Math.PI) {
    hBarP = (h1p + h2p + 2 * Math.PI) * 0.5;
  } else {
    hBarP = (h1p + h2p - 2 * Math.PI) * 0.5;
  }

  const t =
    1 -
    0.17 * Math.cos(hBarP - 30 * DEG) +
    0.24 * Math.cos(2 * hBarP) +
    0.32 * Math.cos(3 * hBarP + 6 * DEG) -
    0.2 * Math.cos(4 * hBarP - 63 * DEG);

  const dTheta = 30 * DEG * Math.exp(-Math.pow((hBarP / DEG - 275) / 25, 2));
  const cBarP7 = Math.pow(cBarP, 7);
  const rC = 2 * Math.sqrt(cBarP7 / (cBarP7 + 6103515625));
  const lBarP50 = (lBarP - 50) * (lBarP - 50);
  const sL = 1 + (0.015 * lBarP50) / Math.sqrt(20 + lBarP50);
  const sC = 1 + 0.045 * cBarP;
  const sH = 1 + 0.015 * cBarP * t;
  const rT = -Math.sin(2 * dTheta) * rC;

  const termL = dLp / sL;
  const termC = dCp / sC;
  const termH = dHp / sH;

  return termL * termL + termC * termC + termH * termH + rT * termC * termH;
}

export function metricNeedsLab(metric: DistanceMetric): boolean {
  return metric === 'cie76' || metric === 'ciede2000';
}

/** Convert a flat sRGB palette to a flat Lab palette. */
export function paletteToLab(colors: Float32Array): Float32Array {
  const n = colors.length / 3;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const [l, a, b] = srgbToLab(colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]);
    out[i * 3] = l;
    out[i * 3 + 1] = a;
    out[i * 3 + 2] = b;
  }
  return out;
}
