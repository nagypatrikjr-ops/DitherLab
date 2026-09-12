import type { PixelBuffer } from '../types';
import { ringArea, simplifyRing, toMask, traceRings, type Ring } from './trace';

export * from './trace';

export interface VectorOptions {
  /** Ink threshold on luminance. */
  threshold: number;
  invert: boolean;
  /** Drop rings whose absolute area is below this, in square pixels. */
  minPathArea: number;
  /** Douglas–Peucker tolerance in pixels. 0 keeps every corner. */
  simplifyTolerance: number;
  /** Merge touching dots into a single outline instead of separate squares. */
  mergeAdjacent: boolean;
  /** Outline instead of fill. */
  strokeMode: boolean;
  strokeWidth: number;
  /** Uniform scale applied to the output coordinates. */
  scale: number;
  fill: string;
  background: string | null;
}

export const DEFAULT_VECTOR_OPTIONS: VectorOptions = {
  threshold: 0.5,
  invert: false,
  minPathArea: 0.5,
  simplifyTolerance: 0,
  mergeAdjacent: true,
  strokeMode: false,
  strokeWidth: 0.5,
  scale: 1,
  fill: '#000000',
  background: null,
};

export interface VectorResult {
  rings: Ring[];
  width: number;
  height: number;
  /** Total point count, useful for warning before an unopenable export. */
  pointCount: number;
}

/**
 * Trace a rendered 1-bit buffer into closed rings.
 *
 * With `mergeAdjacent` off, each ink pixel is emitted as its own square, which
 * is what a cutting machine sometimes wants; with it on (the default) touching
 * pixels share one outline, which is what keeps the file openable.
 */
export function vectorize(src: PixelBuffer, options: Partial<VectorOptions> = {}): VectorResult {
  const opt = { ...DEFAULT_VECTOR_OPTIONS, ...options };
  const mask = toMask(src, opt.threshold, opt.invert);

  let rings: Ring[];
  if (opt.mergeAdjacent) {
    rings = traceRings(mask, src.width, src.height);
  } else {
    rings = [];
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        if (mask[y * src.width + x] === 0) continue;
        rings.push([[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1], [x, y]]);
      }
    }
  }

  const kept: Ring[] = [];
  let pointCount = 0;
  for (const ring of rings) {
    const simplified = simplifyRing(ring, opt.simplifyTolerance);
    if (Math.abs(ringArea(simplified)) < opt.minPathArea) continue;
    const scaled: Ring =
      opt.scale === 1
        ? simplified
        : simplified.map(([x, y]) => [x * opt.scale, y * opt.scale] as const);
    kept.push(scaled);
    pointCount += scaled.length;
  }

  return {
    rings: kept,
    width: src.width * opt.scale,
    height: src.height * opt.scale,
    pointCount,
  };
}

function fmt(v: number): string {
  const r = Math.round(v * 1000) / 1000;
  return Number.isInteger(r) ? String(r) : String(r);
}

function ringToPath(ring: Ring): string {
  if (ring.length === 0) return '';
  const parts: string[] = [`M${fmt(ring[0][0])} ${fmt(ring[0][1])}`];
  for (let i = 1; i < ring.length; i++) {
    const [x, y] = ring[i];
    const [px, py] = ring[i - 1];
    if (x === px) parts.push(`V${fmt(y)}`);
    else if (y === py) parts.push(`H${fmt(x)}`);
    else parts.push(`L${fmt(x)} ${fmt(y)}`);
  }
  parts.push('Z');
  return parts.join('');
}

/**
 * SVG output.
 *
 * Everything goes into a single path with `fill-rule="evenodd"`, so nested
 * rings become holes without needing correct winding order. Both Illustrator
 * and Inkscape honour even-odd, and a single path keeps the DOM small enough
 * to actually open when a dither produces tens of thousands of dots.
 */
export function toSvg(result: VectorResult, options: Partial<VectorOptions> = {}): string {
  const opt = { ...DEFAULT_VECTOR_OPTIONS, ...options };
  const d = result.rings.map(ringToPath).join('');
  const bg =
    opt.background === null
      ? ''
      : `<rect width="${fmt(result.width)}" height="${fmt(result.height)}" fill="${opt.background}"/>`;
  const paint = opt.strokeMode
    ? `fill="none" stroke="${opt.fill}" stroke-width="${fmt(opt.strokeWidth)}" stroke-linejoin="miter"`
    : `fill="${opt.fill}" fill-rule="evenodd"`;

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" ` +
      `width="${fmt(result.width)}" height="${fmt(result.height)}" ` +
      `viewBox="0 0 ${fmt(result.width)} ${fmt(result.height)}">`,
    bg,
    d.length > 0 ? `<path ${paint} d="${d}"/>` : '',
    '</svg>',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

function pdfEscape(s: string): string {
  return s.replace(/([\\()])/g, '\\$1');
}

/**
 * Minimal but valid PDF 1.4 with a single page and one content stream.
 *
 * PDF's y axis points up, so the content stream is emitted with a flipped
 * transform. Even-odd fill (`f*`) matches the SVG output exactly.
 */
export function toPdf(result: VectorResult, options: Partial<VectorOptions> = {}): Uint8Array {
  const opt = { ...DEFAULT_VECTOR_OPTIONS, ...options };
  const w = result.width;
  const h = result.height;

  const hexToRgb01 = (hex: string): [number, number, number] => {
    const n = Number.parseInt(hex.replace('#', ''), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  };
  const [fr, fg, fb] = hexToRgb01(opt.fill);

  const ops: string[] = [];
  if (opt.background !== null) {
    const [br, bg2, bb] = hexToRgb01(opt.background);
    ops.push(`${br} ${bg2} ${bb} rg`, `0 0 ${w} ${h} re`, 'f');
  }
  ops.push(`${fr} ${fg} ${fb} ${opt.strokeMode ? 'RG' : 'rg'}`);
  if (opt.strokeMode) ops.push(`${opt.strokeWidth} w`);

  for (const ring of result.rings) {
    if (ring.length === 0) continue;
    ops.push(`${fmt(ring[0][0])} ${fmt(h - ring[0][1])} m`);
    for (let i = 1; i < ring.length; i++) {
      ops.push(`${fmt(ring[i][0])} ${fmt(h - ring[i][1])} l`);
    }
    ops.push('h');
  }
  ops.push(opt.strokeMode ? 'S' : 'f*');

  const content = ops.join('\n');
  const encoder = new TextEncoder();
  const contentBytes = encoder.encode(content);

  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(w)} ${fmt(h)}] /Contents 4 0 R /Resources << >> >>`,
    `<< /Length ${contentBytes.length} >>\nstream\n${content}\nendstream`,
    `<< /Producer (${pdfEscape('DitherLab')}) /Creator (${pdfEscape('DitherLab')}) >>`,
  ];

  let pdf = '%PDF-1.4\n%âãÏÓ\n';
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\n`;
  pdf += `startxref\n${xrefStart}\n%%EOF\n`;

  // Latin-1 encode: the content is ASCII apart from the binary comment marker.
  const out = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) out[i] = pdf.charCodeAt(i) & 0xff;
  return out;
}
