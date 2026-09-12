import type { PixelBuffer, RGB } from '../types';
import { createBuffer } from '../buffer';
import { erode } from './morphology';
import { resizeCoverage, separate } from './separate';
import { inkCoverage, screenCoverage } from './screen';
import { outputSize, type PrintJob, type Separation } from './types';

export * from './types';
export * from './separate';
export * from './screen';
export { erode, dilate } from './morphology';

export interface SeparationResult {
  separations: Separation[];
  width: number;
  height: number;
  /** Output resolution actually used, which a preview lowers. */
  dpi: number;
  /** Physical size the numbers refer to. */
  widthMm: number;
  heightMm: number;
}

/**
 * Full separation pass: image in, one 1-bit screen per ink out.
 *
 * Coverage is solved at source resolution — it is a colour problem, not a
 * resolution problem — and only then scaled up to film resolution, where the
 * halftone runs. Doing it this way keeps memory sane: the source stays small
 * and each film-resolution buffer is a single byte per pixel.
 */
export function buildSeparations(
  src: PixelBuffer,
  job: PrintJob,
  /** Cap the long edge; used for the interactive preview. */
  maxDimension?: number,
): SeparationResult {
  const aspect = src.width / src.height;
  const full = outputSize(job.widthMm, job.screen.dpi, aspect);

  let width = full.width;
  let height = full.height;
  let dpi = job.screen.dpi;
  if (maxDimension !== undefined && Math.max(full.width, full.height) > maxDimension) {
    const scale = maxDimension / Math.max(full.width, full.height);
    width = Math.max(1, Math.round(full.width * scale));
    height = Math.max(1, Math.round(full.height * scale));
    // The screen ruling is physical, so the effective DPI has to follow the
    // pixel count or the preview would show a different dot pitch.
    dpi = job.screen.dpi * scale;
  }

  const active = job.inks.filter((i) => i.enabled).sort((a, b) => a.order - b.order);
  const cov = separate(src, job.garment, active);

  const separations: Separation[] = [];
  const scaled: Uint8Array[] = [];

  for (let i = 0; i < active.length; i++) {
    scaled.push(resizeCoverage(cov.maps[i], cov.width, cov.height, width, height));
  }

  if (job.underbase.enabled) {
    const needs = active.map((ink) => ink.needsUnderbase);
    if (needs.some(Boolean)) {
      const union = new Uint8Array(width * height);
      for (let i = 0; i < active.length; i++) {
        if (!needs[i]) continue;
        const m = scaled[i];
        for (let p = 0; p < union.length; p++) if (m[p] > union[p]) union[p] = m[p];
      }
      // Choke shrinks the *silhouette*, not the tonality. Eroding the
      // greyscale coverage directly would let a min filter chew the grain out
      // of the middle of the base and leave the colours sitting on bare fabric.
      const cut = Math.round(job.underbase.threshold * 255);
      const silhouette = new Uint8Array(width * height);
      for (let p = 0; p < silhouette.length; p++) silhouette[p] = union[p] > cut ? 255 : 0;
      const choked = erode(silhouette, width, height, job.underbase.chokePx);

      const baseCoverage = new Uint8Array(width * height);
      for (let p = 0; p < baseCoverage.length; p++) {
        if (choked[p] === 0) continue;
        baseCoverage[p] = job.underbase.halftoned ? union[p] : 255;
      }

      const bits = job.underbase.halftoned
        ? screenCoverage(baseCoverage, width, height, job.screen)
        : Uint8Array.from(baseCoverage, (v) => (v > 127 ? 1 : 0));
      separations.push({
        id: 'underbase',
        name: 'Fehér aláfestés',
        color: job.underbase.color,
        width,
        height,
        bits,
        coverage: inkCoverage(bits),
        isUnderbase: true,
      });
    }
  }

  for (let i = 0; i < active.length; i++) {
    const bits = screenCoverage(scaled[i], width, height, job.screen);
    separations.push({
      id: active[i].id,
      name: active[i].name,
      color: active[i].color,
      width,
      height,
      bits,
      coverage: inkCoverage(bits),
      isUnderbase: false,
    });
  }

  return {
    separations,
    width,
    height,
    dpi,
    widthMm: job.widthMm,
    heightMm: job.widthMm / aspect,
  };
}

/**
 * Composite the separations onto the garment, in print order, to show what
 * comes off the press. Ink is opaque where a dot lands: that is what actually
 * happens with plastisol on fabric.
 */
export function renderPrintPreview(
  result: SeparationResult,
  garment: RGB,
): PixelBuffer {
  const buf = createBuffer(result.width, result.height, 'srgb');
  const d = buf.data;
  for (let p = 0; p < result.width * result.height; p++) {
    const i = p * 4;
    d[i] = garment.r;
    d[i + 1] = garment.g;
    d[i + 2] = garment.b;
    d[i + 3] = 1;
  }
  for (const sep of result.separations) {
    for (let p = 0; p < sep.bits.length; p++) {
      if (sep.bits[p] === 0) continue;
      const i = p * 4;
      d[i] = sep.color.r;
      d[i + 1] = sep.color.g;
      d[i + 2] = sep.color.b;
    }
  }
  return buf;
}

/**
 * One separation as a film positive: black where ink goes, white elsewhere.
 * That is the polarity every imagesetter and inkjet film workflow expects.
 */
export function separationToBuffer(sep: Separation, invert = false): PixelBuffer {
  const buf = createBuffer(sep.width, sep.height, 'srgb');
  const d = buf.data;
  for (let p = 0; p < sep.bits.length; p++) {
    const ink = invert ? sep.bits[p] === 0 : sep.bits[p] === 1;
    const v = ink ? 0 : 1;
    const i = p * 4;
    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
    d[i + 3] = 1;
  }
  return buf;
}

/** Warnings a print shop would raise looking at these films. */
export function auditSeparations(
  result: SeparationResult,
  job: PrintJob,
): { level: 'info' | 'warn'; text: string }[] {
  const out: { level: 'info' | 'warn'; text: string }[] = [];
  const mesh = { min: Math.round(job.screen.lpi * 4), max: Math.round(job.screen.lpi * 5) };
  out.push({
    level: 'info',
    text: `${job.screen.lpi} LPI-hez ${mesh.min}–${mesh.max} szitasűrűség ajánlott.`,
  });

  if (job.screen.lpi > 55) {
    out.push({
      level: 'warn',
      text: `${job.screen.lpi} LPI textilre sok — 35 és 55 között a biztonságos sáv.`,
    });
  }
  if (job.screen.lpi < 25) {
    out.push({ level: 'warn', text: 'A raszter ilyen durván már szabad szemmel pöttyös lesz.' });
  }
  if (job.screen.minDot < 0.06) {
    out.push({
      level: 'warn',
      text: `${Math.round(job.screen.minDot * 100)}%-os pont nem tartható; 6–8% a reális alsó határ.`,
    });
  }
  if (job.screen.maxDot > 0.92) {
    out.push({
      level: 'warn',
      text: `${Math.round(job.screen.maxDot * 100)}% fölött a pontok összefolynak.`,
    });
  }

  const dotPx = job.screen.dpi / job.screen.lpi;
  if (dotPx < 4) {
    out.push({
      level: 'warn',
      text: `A film felbontása kevés: egy rasztercella ${dotPx.toFixed(1)} pixel. Emeld a DPI-t.`,
    });
  }

  for (const sep of result.separations) {
    if (sep.coverage === 0) {
      out.push({ level: 'warn', text: `„${sep.name}” üres — erre a szitára nem kerül semmi.` });
    } else if (sep.coverage > 0.97) {
      out.push({
        level: 'warn',
        text: `„${sep.name}” gyakorlatilag teljes felület — biztos, hogy nem fordítva van?`,
      });
    }
  }

  const screens = result.separations.length;
  out.push({
    level: 'info',
    text: `${screens} szita kell (${result.separations.map((s) => s.name).join(', ')}).`,
  });
  return out;
}
