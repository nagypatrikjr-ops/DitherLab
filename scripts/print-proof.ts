/**
 * Renders a print proof: the simulated garment plus every separation film,
 * laid out on one sheet so the whole job can be checked at a glance.
 *
 *   npx vite-node scripts/print-proof.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { decodePng } from './pngread';
import { bufferFromRgba, bufferToRgba, createBuffer, resampleBox } from '../src/core/buffer';
import {
  buildSeparations,
  DEFAULT_SCREEN,
  DEFAULT_UNDERBASE,
  renderPrintPreview,
  separationToBuffer,
  suggestInks,
  type Ink,
  type PrintJob,
} from '../src/core/print';
import { encodePngRgba } from '../src/io/png';
import type { PixelBuffer, RGB } from '../src/core/types';

const GARMENT: RGB = { r: 0.055, g: 0.055, b: 0.06 };

const png = decodePng(new Uint8Array(readFileSync('public/poster-test.png')));
const src = bufferFromRgba(png.rgba, png.width, png.height);

const guess = suggestInks(src, 3);
const inks: Ink[] = guess.inks.map((c, i) => {
  const luma = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
  return {
    id: `ink-${i}`,
    name: luma > 0.75 ? 'Fehér' : 'Piros',
    color: c,
    order: i,
    needsUnderbase: luma <= 0.75,
    enabled: true,
  };
});

const job: PrintJob = {
  widthMm: 280,
  garment: GARMENT,
  inks,
  screen: { ...DEFAULT_SCREEN, dpi: 600, lpi: 45 },
  underbase: { ...DEFAULT_UNDERBASE, chokePx: 3 },
};

const result = buildSeparations(src, job, 900);
const preview = renderPrintPreview(result, GARMENT);

const CELL = 440;
const LABEL = 0;
const cols = 1 + result.separations.length;
const sheet = createBuffer(cols * CELL, CELL + LABEL);
sheet.data.fill(0.1);
for (let i = 3; i < sheet.data.length; i += 4) sheet.data[i] = 1;

function blit(dst: PixelBuffer, s: PixelBuffer, x0: number, y0: number): void {
  for (let y = 0; y < s.height; y++) {
    for (let x = 0; x < s.width; x++) {
      const a = (y * s.width + x) * 4;
      const b = ((y0 + y) * dst.width + x0 + x) * 4;
      dst.data[b] = s.data[a];
      dst.data[b + 1] = s.data[a + 1];
      dst.data[b + 2] = s.data[a + 2];
      dst.data[b + 3] = 1;
    }
  }
}

blit(sheet, resampleBox(preview, CELL, CELL), 0, 0);
result.separations.forEach((sep, i) => {
  blit(sheet, resampleBox(separationToBuffer(sep), CELL, CELL), (i + 1) * CELL, 0);
  process.stdout.write(
    `  ${String(i + 1)}. ${sep.name.padEnd(18)} fedettség ${(sep.coverage * 100).toFixed(1).padStart(5)}%\n`,
  );
});

mkdirSync('tests/golden/output', { recursive: true });
void encodePngRgba(bufferToRgba(sheet), sheet.width, sheet.height).then((b) => {
  writeFileSync('tests/golden/output/print-proof.png', b);
  process.stdout.write(`\n  Lap: ${sheet.width}×${sheet.height} -> tests/golden/output/print-proof.png\n`);
});

// A 1:1 crop so the dot structure is visible without any downscaling.
const crop = createBuffer(420, 420);
const full = buildSeparations(src, job, 1400);
const fullPreview = renderPrintPreview(full, GARMENT);
for (let y = 0; y < 420; y++) {
  for (let x = 0; x < 420; x++) {
    const sx = Math.min(fullPreview.width - 1, x + 430);
    const sy = Math.min(fullPreview.height - 1, y + 250);
    const a = (sy * fullPreview.width + sx) * 4;
    const b = (y * 420 + x) * 4;
    crop.data[b] = fullPreview.data[a];
    crop.data[b + 1] = fullPreview.data[a + 1];
    crop.data[b + 2] = fullPreview.data[a + 2];
    crop.data[b + 3] = 1;
  }
}
void encodePngRgba(bufferToRgba(crop), 420, 420).then((b) => {
  writeFileSync('tests/golden/output/print-crop.png', b);
});
