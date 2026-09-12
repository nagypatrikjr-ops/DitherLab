/**
 * Renders the sample image through a selection of algorithms and writes a
 * contact sheet PNG, so the visual output can be eyeballed outside the app.
 *
 *   npx vite-node scripts/contact-sheet.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { decodePng } from './pngread';
import { registerAllProcessors } from '../src/core';
import { defaultParams, requireProcessor } from '../src/core/dither/registry';
import { bufferFromRgba, bufferToRgba, createBuffer, resampleBox } from '../src/core/buffer';
import { findBuiltinPalette } from '../src/core/palette/builtin';
import { renderPipeline } from '../src/core/pipeline';
import { encodePngRgba } from '../src/io/png';
import type { EffectLayer, PixelBuffer, RenderContext } from '../src/core/types';

registerAllProcessors();

const CELLS: { id: string; label: string; palette: string; params: Record<string, unknown> }[] = [
  { id: 'ed:floyd-steinberg', label: 'Floyd–Steinberg', palette: 'bw1', params: { colorMode: 'mono', pixelScale: 2 } },
  { id: 'ed:atkinson', label: 'Atkinson', palette: 'bw1', params: { colorMode: 'mono', pixelScale: 2 } },
  { id: 'ed:jarvis', label: 'Jarvis', palette: 'bw1', params: { colorMode: 'mono', pixelScale: 2 } },
  { id: 'ed:riemersma', label: 'Riemersma', palette: 'bw1', params: { colorMode: 'mono', pixelScale: 2 } },
  { id: 'ord:bayer8', label: 'Bayer 8', palette: 'bw1', params: { colorMode: 'mono', pixelScale: 3 } },
  { id: 'ord:blue-noise', label: 'Kék zaj', palette: 'bw1', params: { colorMode: 'mono', pixelScale: 3 } },
  { id: 'ord:clustered8', label: 'Tömör pont 8', palette: 'bw1', params: { colorMode: 'mono', pixelScale: 2 } },
  { id: 'ord:line-diagonal8', label: '45° vonal', palette: 'bw1', params: { colorMode: 'mono', pixelScale: 2 } },
  { id: 'ht:halftone', label: 'CMYK halftone', palette: 'bw1', params: { frequency: 28, separation: 'cmyk' } },
  { id: 'ht:halftone', label: 'Újságnyomat', palette: 'bw1', params: { frequency: 26, separation: 'mono', dotShape: 'newsprint' } },
  { id: 'mod:threshold', label: 'Perlin küszöb', palette: 'bw1', params: { colorMode: 'mono', modulation: 'perlin', frequency: 12, pixelScale: 2 } },
  { id: 'mod:threshold', label: 'Hullám küszöb', palette: 'bw1', params: { colorMode: 'mono', modulation: 'wave', frequency: 20, pixelScale: 2 } },
  { id: 'mod:ascii', label: 'ASCII', palette: 'bw1', params: {} },
  { id: 'mod:shape', label: 'Alakzat (kör)', palette: 'bw1', params: { cellSize: 9 } },
  { id: 'mod:contour', label: 'Szintvonal', palette: 'bw1', params: { levels: 14 } },
  { id: 'mod:quadtree', label: 'Quadtree', palette: 'c64', params: { colorMode: 'palette' } },
  { id: 'ed:floyd-steinberg', label: 'C64 paletta', palette: 'c64', params: { colorMode: 'palette', pixelScale: 3 } },
  { id: 'ed:atkinson', label: 'Game Boy', palette: 'gb-dmg', params: { colorMode: 'palette', pixelScale: 4 } },
  { id: 'ord:bayer4', label: 'PICO-8 Bayer', palette: 'pico8', params: { colorMode: 'palette', pixelScale: 3 } },
  { id: 'ed:stucki', label: 'Riso duotone', palette: 'riso-pink-blue', params: { colorMode: 'palette', pixelScale: 2 } },
];

const COLS = 5;
const CELL_W = 280;
const CELL_H = 184;
const LABEL_H = 16;

function main(): void {
  const png = decodePng(new Uint8Array(readFileSync('public/sample.png')));
  const full = bufferFromRgba(png.rgba, png.width, png.height);
  const src = resampleBox(full, CELL_W, CELL_H);

  const rows = Math.ceil(CELLS.length / COLS);
  const sheet = createBuffer(COLS * CELL_W, rows * (CELL_H + LABEL_H));
  for (let i = 0; i < sheet.data.length; i += 4) {
    sheet.data[i] = 0.08;
    sheet.data[i + 1] = 0.08;
    sheet.data[i + 2] = 0.09;
    sheet.data[i + 3] = 1;
  }

  CELLS.forEach((cell, index) => {
    const proc = requireProcessor(cell.id);
    const layer: EffectLayer = {
      id: `sheet-${index}`,
      type: cell.id,
      enabled: true,
      opacity: 1,
      blendMode: 'normal',
      params: { ...defaultParams(proc.params), ...cell.params } as EffectLayer['params'],
    };
    const ctx: RenderContext = {
      palette: findBuiltinPalette(cell.palette),
      distance: 'weightedRgb',
      gammaCorrect: true,
      seed: 7,
      frame: 0,
      noiseMode: 'static',
      cycleLength: 12,
      resolutionDivisor: 1,
    };
    const { buffer } = renderPipeline(src, 'sheet', [layer], ctx);
    blit(sheet, buffer, (index % COLS) * CELL_W, Math.floor(index / COLS) * (CELL_H + LABEL_H));
    process.stdout.write(`${String(index + 1).padStart(2)}. ${cell.label} — ${cell.id}\n`);
  });

  mkdirSync('tests/golden/output', { recursive: true });
  void encodePngRgba(bufferToRgba(sheet), sheet.width, sheet.height).then((bytes) => {
    writeFileSync('tests/golden/output/contact-sheet.png', bytes);
    process.stdout.write(`\nMentve: tests/golden/output/contact-sheet.png (${sheet.width}×${sheet.height})\n`);
  });
}

function blit(dst: PixelBuffer, src: PixelBuffer, x0: number, y0: number): void {
  for (let y = 0; y < src.height; y++) {
    const dy = y0 + y;
    if (dy >= dst.height) break;
    for (let x = 0; x < src.width; x++) {
      const dx = x0 + x;
      if (dx >= dst.width) break;
      const s = (y * src.width + x) * 4;
      const d = (dy * dst.width + dx) * 4;
      dst.data[d] = src.data[s];
      dst.data[d + 1] = src.data[s + 1];
      dst.data[d + 2] = src.data[s + 2];
      dst.data[d + 3] = 1;
    }
  }
}

main();
