import type { PixelBuffer } from '../types';
import { resampleBox } from '../buffer';
import { linearRgbToLab, lumaSrgb, srgbToLinear } from '../color/space';
import { coverageNeed, inkDirection, knockoutPixel, toPerceptual, type InkDirection } from './engine';
import { SOLID_ALPHA, effectiveMinDotMm, type TransferSettings } from './types';

/**
 * Automatic settings for a DTF transfer on a given garment.
 *
 * The two failures this targets are measurable, so they are measured rather
 * than guessed:
 *
 *  - **Milky print ("tejes").** Ink that is nearly the colour of the shirt
 *    still gets white underbase beneath it, and printed over white it comes
 *    out as a greyish, chalky patch — a dark red turns dusty, black turns
 *    grey. Those tones should come from the shirt showing between dots.
 *  - **Specks.** Faint grain close to the shirt colour becomes a sprinkle of
 *    isolated dots that reads as dirt.
 *
 * Every candidate is judged with the renderer's own knockout model on a
 * reduced copy of the art, so the numbers describe what will actually print.
 * The weights between competing goals are a preference, not physics — they
 * are exposed as `photo` / `balanced` / `vintage` and documented in README.md.
 */

export type TunePreference = 'photo' | 'balanced' | 'vintage';

/** Ink closer than this to the shirt colour (perceptual 0..1) prints milky. */
export const MILKY_DISTANCE = 0.35;
/** Largest acceptable share of the printed area at milky risk. */
export const MILKY_LIMIT = 0.05;
/** Coverage below this is a sparse sprinkle of isolated dots. */
export const SPARSE_ALPHA = 0.12;

export interface TuneMetrics {
  /** Share of the printed area whose ink is milky-close to the shirt colour. */
  milky: number;
  /** Mean colour error (CIE ΔE76 / 100) between what the eye sees and the art. */
  toneError: number;
  /** Share of the design reproduced with dots rather than solid ink. */
  dotShare: number;
  /** Share of the design printed as a sparse sprinkle of isolated dots. */
  sparse: number;
  /** Mean ink coverage over the design — a proxy for weight and hand feel. */
  ink: number;
}

export interface Diagnosis {
  /** Share of the image that is (nearly) the shirt colour — knocked out anyway. */
  garmentShare: number;
  /** Share in the danger zone: not shirt-coloured, but dark enough to go milky. */
  darkToneShare: number;
  /** Mean absolute luminance Laplacian: 0 clean, higher = grainier. */
  grain: number;
  /** Share of pixels on a sharp edge — text and line art push this up. */
  edgeShare: number;
  /** Share of the outer border printed solid — a photo cut as a rectangle. */
  borderSolid: number;
  hasTransparency: boolean;
  sourceDpi: number;
}

export interface TuneCandidate {
  label: string;
  settings: TransferSettings;
  metrics: TuneMetrics;
  score: number;
}

export interface TuneResult {
  settings: TransferSettings;
  metrics: TuneMetrics;
  before: TuneMetrics;
  diagnosis: Diagnosis;
  /** A few distinct good options, best first, for a human or model to review. */
  candidates: TuneCandidate[];
  /** Plain-language account of what was found and changed (Hungarian). */
  notes: string[];
}

interface Sample {
  n: number;
  width: number;
  height: number;
  /** Premultiplied linear source and its alpha — the renderer's input. */
  prem: Float32Array;
  alpha: Float32Array;
  /** Lab of the art composited over the shirt: the target appearance. */
  lab: Float32Array;
  /** Coverage need per pixel (colour-to-alpha against the shirt). */
  need: Float32Array;
  T: [number, number, number];
  Tlab: [number, number, number];
  dir: InkDirection;
}

function buildSample(src: PixelBuffer, s: TransferSettings, maxEdge: number): Sample {
  const k = Math.min(1, maxEdge / Math.max(src.width, src.height));
  const small =
    k < 1
      ? resampleBox(src, Math.max(1, Math.round(src.width * k)), Math.max(1, Math.round(src.height * k)))
      : src;
  const n = small.width * small.height;
  const T: [number, number, number] = [
    srgbToLinear(s.garment.r),
    srgbToLinear(s.garment.g),
    srgbToLinear(s.garment.b),
  ];
  const dir = inkDirection(T);
  const prem = new Float32Array(n * 3);
  const alpha = new Float32Array(n);
  const lab = new Float32Array(n * 3);
  const need = new Float32Array(n);
  const d = small.data;
  for (let p = 0; p < n; p++) {
    const a = Math.min(1, Math.max(0, d[p * 4 + 3]));
    const r = srgbToLinear(Math.min(1, Math.max(0, d[p * 4])));
    const g = srgbToLinear(Math.min(1, Math.max(0, d[p * 4 + 1])));
    const b = srgbToLinear(Math.min(1, Math.max(0, d[p * 4 + 2])));
    prem[p * 3] = r * a;
    prem[p * 3 + 1] = g * a;
    prem[p * 3 + 2] = b * a;
    alpha[p] = a;
    const cr = r * a + (1 - a) * T[0];
    const cg = g * a + (1 - a) * T[1];
    const cb = b * a + (1 - a) * T[2];
    const [L, A, B] = linearRgbToLab(cr, cg, cb);
    lab[p * 3] = L;
    lab[p * 3 + 1] = A;
    lab[p * 3 + 2] = B;
    need[p] = coverageNeed(cr, cg, cb, T, dir);
  }
  return {
    n,
    width: small.width,
    height: small.height,
    prem,
    alpha,
    lab,
    need,
    T,
    Tlab: linearRgbToLab(T[0], T[1], T[2]),
    dir,
  };
}

function deltaE(l1: number, a1: number, b1: number, l2: number, a2: number, b2: number): number {
  const dl = l1 - l2;
  const da = a1 - a2;
  const db = b1 - b2;
  return Math.sqrt(dl * dl + da * da + db * db);
}

/** What these settings would print, judged on the sample. */
function evaluate(sm: Sample, s: TransferSettings): TuneMetrics {
  const out = new Float64Array(7);
  const T = sm.T;
  let ink = 0;
  let milkyInk = 0;
  let err = 0;
  let dots = 0;
  let sparse = 0;
  let design = 0;
  for (let p = 0; p < sm.n; p++) {
    knockoutPixel(sm.prem[p * 3], sm.prem[p * 3 + 1], sm.prem[p * 3 + 2], sm.alpha[p], T, s, out);
    const a = out[0];
    const isDesign = sm.need[p] > 0.02;
    if (isDesign) design++;
    if (a <= 0) {
      if (isDesign) err += deltaE(sm.lab[p * 3], sm.lab[p * 3 + 1], sm.lab[p * 3 + 2], sm.Tlab[0], sm.Tlab[1], sm.Tlab[2]);
      continue;
    }
    const cr = Math.min(1, Math.max(0, out[1]));
    const cg = Math.min(1, Math.max(0, out[2]));
    const cb = Math.min(1, Math.max(0, out[3]));
    if (cr !== out[1] || cg !== out[2] || cb !== out[3]) {
      const [L, A, B] = linearRgbToLab(a * cr + (1 - a) * T[0], a * cg + (1 - a) * T[1], a * cb + (1 - a) * T[2]);
      err += deltaE(sm.lab[p * 3], sm.lab[p * 3 + 1], sm.lab[p * 3 + 2], L, A, B);
    }
    ink += a;
    if (toPerceptual(coverageNeed(cr, cg, cb, T, sm.dir)) < MILKY_DISTANCE) milkyInk += a;
    if (a < SOLID_ALPHA) dots++;
    if (a < SPARSE_ALPHA) sparse++;
  }
  const dn = Math.max(1, design);
  return {
    milky: ink > 1e-9 ? milkyInk / ink : 0,
    toneError: err / sm.n / 100,
    dotShare: dots / dn,
    sparse: sparse / dn,
    ink: ink / dn,
  };
}

const PREF_WEIGHTS: Record<TunePreference, { dots: number; ink: number }> = {
  photo: { dots: 1.2, ink: 0.2 },
  balanced: { dots: 0.6, ink: 0.4 },
  vintage: { dots: 0.15, ink: 0.8 },
};

function scoreOf(m: TuneMetrics, pref: TunePreference): number {
  const w = PREF_WEIGHTS[pref];
  return 4 * m.milky + 3 * m.toneError + w.dots * m.dotShare + 1 * m.sparse + w.ink * m.ink;
}

/**
 * The finest AM ruling at which the effective minimum dot still takes no more
 * than 40% of a cell. Finer than that, most light tones collapse into the
 * sparse minimum-dot regime and the print looks coarser, not finer.
 */
export function recommendedLpi(s: TransferSettings): number {
  const eff = effectiveMinDotMm(s);
  for (const lpi of [45, 40, 35, 30, 25, 20]) {
    const cell = 25.4 / lpi;
    if ((Math.PI / 4) * (eff / cell) ** 2 <= 0.4) return lpi;
  }
  return 20;
}

export function diagnose(src: PixelBuffer, s: TransferSettings, chosen?: TransferSettings): Diagnosis {
  const sm = buildSample(src, s, 256);
  let garment = 0;
  let dark = 0;
  for (let p = 0; p < sm.n; p++) {
    const dist = toPerceptual(sm.need[p]);
    if (dist <= 0.05) garment++;
    else if (dist < 0.45) dark++;
  }

  // Grain and edges on a larger copy: downscaling averages grain away.
  const k = Math.min(1, 768 / Math.max(src.width, src.height));
  const mid =
    k < 1 ? resampleBox(src, Math.max(1, Math.round(src.width * k)), Math.max(1, Math.round(src.height * k))) : src;
  const w = mid.width;
  const h = mid.height;
  const lum = new Float32Array(w * h);
  let transparent = false;
  for (let p = 0; p < w * h; p++) {
    const a = mid.data[p * 4 + 3];
    if (a < 0.99) transparent = true;
    lum[p] = lumaSrgb(mid.data[p * 4], mid.data[p * 4 + 1], mid.data[p * 4 + 2]) * a;
  }
  let lap = 0;
  let edges = 0;
  let inner = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const avg = (lum[i - 1] + lum[i + 1] + lum[i - w] + lum[i + w]) / 4;
      lap += Math.abs(lum[i] - avg);
      const gx = lum[i + 1] - lum[i - 1];
      const gy = lum[i + w] - lum[i - w];
      if (Math.sqrt(gx * gx + gy * gy) > 0.5) edges++;
      inner++;
    }
  }

  const judge = chosen ?? s;
  const out = new Float64Array(7);
  let border = 0;
  let borderSolid = 0;
  for (let y = 0; y < sm.height; y++) {
    for (let x = 0; x < sm.width; x++) {
      if (x !== 0 && y !== 0 && x !== sm.width - 1 && y !== sm.height - 1) continue;
      const p = y * sm.width + x;
      knockoutPixel(sm.prem[p * 3], sm.prem[p * 3 + 1], sm.prem[p * 3 + 2], sm.alpha[p], sm.T, judge, out);
      border++;
      if (out[0] >= 0.5) borderSolid++;
    }
  }

  return {
    garmentShare: garment / sm.n,
    darkToneShare: dark / sm.n,
    grain: inner > 0 ? lap / inner : 0,
    edgeShare: inner > 0 ? edges / inner : 0,
    borderSolid: border > 0 ? borderSolid / border : 0,
    hasTransparency: transparent,
    sourceDpi: src.width / (s.widthMm / 25.4),
  };
}

function withKnockout(
  base: TransferSettings,
  tolerance: number,
  solidPoint: number,
  density: number,
): TransferSettings {
  return { ...base, knockout: { enabled: true, tolerance, solidPoint, density } };
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function dec(v: number, digits: number): string {
  return v.toFixed(digits).replace('.', ',');
}

/**
 * Search the knockout settings and pick the ruling.
 *
 * Hard rule first: at most MILKY_LIMIT of the printed area may be milky-close
 * to the shirt, whenever any candidate achieves it. Among those, the lowest
 * score wins. The screen ruling follows from the dot the choke allows.
 */
export function autoTune(
  src: PixelBuffer,
  base: TransferSettings,
  pref: TunePreference = 'balanced',
): TuneResult {
  const sm = buildSample(src, base, 192);
  const before = evaluate(sm, base);

  const tolerances = [0.03, 0.05, 0.07, 0.09, 0.12, 0.15];
  const solids = [0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 1];
  const densities = [0.85, 0.92, 1, 1.1, 1.2];

  const all: TuneCandidate[] = [];
  for (const t of tolerances) {
    for (const sp of solids) {
      if (sp < t + 0.05) continue;
      for (const d of densities) {
        const cand = withKnockout(base, t, sp, d);
        const metrics = evaluate(sm, cand);
        all.push({ label: '', settings: cand, metrics, score: scoreOf(metrics, pref) });
      }
    }
  }

  const pick = (pool: TuneCandidate[], p: TunePreference): TuneCandidate => {
    const feasible = pool.filter((c) => c.metrics.milky <= MILKY_LIMIT);
    const rank = (c: TuneCandidate): number => scoreOf(c.metrics, p);
    if (feasible.length > 0) return feasible.reduce((a, b) => (rank(b) < rank(a) ? b : a));
    return pool.reduce((a, b) =>
      b.metrics.milky < a.metrics.milky || (b.metrics.milky === a.metrics.milky && rank(b) < rank(a)) ? b : a,
    );
  };

  const best = pick(all, pref);
  const lpi = recommendedLpi(base);
  const settings: TransferSettings = {
    ...best.settings,
    screen: { ...best.settings.screen, lpi: base.screen.kind === 'am' ? lpi : base.screen.lpi },
  };
  const metrics = evaluate(sm, settings);

  const labels: Record<TunePreference, string> = {
    photo: 'Tömörebb (fotó)',
    balanced: 'Kiegyensúlyozott',
    vintage: 'Légáteresztőbb (vintage)',
  };
  const candidates: TuneCandidate[] = [];
  for (const p of [pref, ...(['photo', 'balanced', 'vintage'] as TunePreference[]).filter((x) => x !== pref)]) {
    const c = pick(all, p);
    const k = c.settings.knockout;
    if (candidates.some((x) => JSON.stringify(x.settings.knockout) === JSON.stringify(k))) continue;
    candidates.push({
      label: labels[p],
      settings: { ...c.settings, screen: { ...c.settings.screen, lpi: settings.screen.lpi } },
      metrics: c.metrics,
      score: c.score,
    });
  }

  const diagnosis = diagnose(src, base, settings);
  const notes: string[] = [];
  if (before.milky > MILKY_LIMIT || metrics.milky < before.milky - 0.01) {
    notes.push(
      `Tejes kockázat: ${pct(before.milky)} → ${pct(metrics.milky)} a nyomott felületből. ` +
        'A pólóhoz közeli sötét tónusokat most a póló adja a pontok között, nem sötét festék fehér alapon.',
    );
  } else {
    notes.push(`Tejes kockázat: ${pct(metrics.milky)} — a sötét részeket már eddig is a póló adta.`);
  }
  if (metrics.milky > MILKY_LIMIT) {
    notes.push(
      `A ${pct(MILKY_LIMIT)}-os cél ezen a képen nem érhető el teljesen: sok a pólóhoz közeli, de tömörnek szánt sötét rész.`,
    );
  }
  const k0 = base.knockout;
  const k1 = settings.knockout;
  if (Math.abs(k1.solidPoint - k0.solidPoint) > 1e-6) {
    notes.push(
      `Tömör határ ${pct(k0.solidPoint)} → ${pct(k1.solidPoint)}: ennél sötétebb tónusok pontokból állnak.`,
    );
  }
  if (Math.abs(k1.tolerance - k0.tolerance) > 1e-6) {
    notes.push(
      `Tolerancia ${pct(k0.tolerance)} → ${pct(k1.tolerance)}` +
        (k1.tolerance > k0.tolerance ? ' — a halvány szemcse nem szórja tele pöttyökkel a pólót.' : ' — több halvány részlet marad meg.'),
    );
  }
  if (Math.abs(k1.density - k0.density) > 1e-6) {
    notes.push(`Pontsúly ${dec(k0.density, 2)} → ${dec(k1.density, 2)}.`);
  }
  if (base.screen.kind === 'am' && settings.screen.lpi !== base.screen.lpi) {
    notes.push(
      `Rasztersűrűség ${base.screen.lpi} → ${settings.screen.lpi} LPI: ez a legsűrűbb, amin a ` +
        `${dec(effectiveMinDotMm(base), 2)} mm-es legkisebb pont még elfér.`,
    );
  }
  if (base.chokeMm < 0.08) {
    notes.push(
      `A ${dec(base.chokeMm, 2)} mm-es choke kevés: a fehér alap kilátszhat a színek szélén. 0,17–0,25 mm ajánlott.`,
    );
  }
  if (diagnosis.borderSolid > 0.6 && base.edgeFade.shape === 'none') {
    notes.push('A kép széle tömören nyomódna, mint egy matrica — fotónál érdemes a szél elhalványítása.');
  }
  if (metrics.sparse > 0.15) {
    notes.push(`A minta ${pct(metrics.sparse)}-a ritka, szórt pontokból áll — szemcsés hatás lesz.`);
  }

  return { settings, metrics, before, diagnosis, candidates, notes };
}

/** Evaluate arbitrary settings the same way the tuner does (for reviews). */
export function evaluateSettings(src: PixelBuffer, s: TransferSettings): TuneMetrics {
  return evaluate(buildSample(src, s, 192), s);
}
