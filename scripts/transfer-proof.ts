/**
 * DTF proof: renders a design as a print-ready transfer and writes
 *  - the file as it goes to the printer (transparency on a checkerboard),
 *  - the same file on a black shirt,
 *  - a 1:1 crop at true 300 DPI to inspect the dots,
 * plus the preflight report and timings.
 *
 *   npx vite-node scripts/transfer-proof.ts [image.png] [widthMm]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { decodePng } from './pngread';
import { bufferFromRgba } from '../src/core/buffer';
import {
  DEFAULT_TRANSFER,
  PLACEMENTS,
  analyzeTransfer,
  renderTransfer,
  prepareSource,
  type TransferSettings,
} from '../src/core/transfer';
import { encodePngRgba } from '../src/io/png';

const file = process.argv[2] ?? 'public/poster-test.png';
const widthMm = Number(process.argv[3] ?? 280);

const png = decodePng(new Uint8Array(readFileSync(file)));
const src = bufferFromRgba(png.rgba, png.width, png.height);
const s: TransferSettings = { ...DEFAULT_TRANSFER, widthMm };

function onShirt(rgba: Uint8ClampedArray): Uint8ClampedArray {
  const g = s.garment;
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const on = rgba[i + 3] !== 0;
    out[i] = on ? rgba[i] : Math.round(g.r * 255);
    out[i + 1] = on ? rgba[i + 1] : Math.round(g.g * 255);
    out[i + 2] = on ? rgba[i + 2] : Math.round(g.b * 255);
    out[i + 3] = 255;
  }
  return out;
}

function onChecker(rgba: Uint8ClampedArray, w: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length);
  for (let p = 0; p < rgba.length / 4; p++) {
    const x = p % w;
    const y = Math.floor(p / w);
    const c = ((x >> 3) + (y >> 3)) & 1 ? 205 : 235;
    const i = p * 4;
    const on = rgba[i + 3] !== 0;
    out[i] = on ? rgba[i] : c;
    out[i + 1] = on ? rgba[i + 1] : c;
    out[i + 2] = on ? rgba[i + 2] : c;
    out[i + 3] = 255;
  }
  return out;
}

async function main(): Promise<void> {
  mkdirSync('tests/golden/output', { recursive: true });

  let t = performance.now();
  const prepared = prepareSource(src, s);
  const tPrep = performance.now() - t;

  t = performance.now();
  const preview = renderTransfer(src, s, { maxDimension: 900, prepared });
  const tPreview = performance.now() - t;

  t = performance.now();
  const full = renderTransfer(src, s, { prepared });
  const tFull = performance.now() - t;

  t = performance.now();
  const analysis = analyzeTransfer(full, s, { placement: PLACEMENTS[0] });
  const tChecks = performance.now() - t;

  t = performance.now();
  const bytes = await encodePngRgba(full.rgba, full.width, full.height, { dpi: s.dpi, srgb: true });
  const tEncode = performance.now() - t;
  writeFileSync('tests/golden/output/dtf-print-ready.png', bytes);

  writeFileSync(
    'tests/golden/output/dtf-on-shirt.png',
    await encodePngRgba(onShirt(preview.rgba), preview.width, preview.height),
  );
  writeFileSync(
    'tests/golden/output/dtf-transparent.png',
    await encodePngRgba(onChecker(preview.rgba, preview.width), preview.width, preview.height),
  );

  // Two 1:1 crops: a glow fading into the shirt (where dots must appear)
  // and a hard edge of solid art (where there must be none).
  const cw = 520;
  const ch = 360;
  const cx = Number(process.argv[4] ?? 0.02);
  const cy = Number(process.argv[5] ?? 0.16);
  const crop = renderTransfer(src, s, {
    prepared,
    crop: { x: Math.round(full.width * cx), y: Math.round(full.height * cy), width: cw, height: ch },
  });
  writeFileSync('tests/golden/output/dtf-crop-1to1.png', await encodePngRgba(onShirt(crop.rgba), cw, ch));
  const edgeCrop = renderTransfer(src, s, {
    prepared,
    crop: { x: Math.round(full.width * 0.37), y: Math.round(full.height * 0.66), width: cw, height: ch },
  });
  writeFileSync('tests/golden/output/dtf-crop-edge.png', await encodePngRgba(onShirt(edgeCrop.rgba), cw, ch));

  const mp = (full.width * full.height) / 1e6;
  console.log(`\n  Forrás: ${file} (${png.width}×${png.height})`);
  console.log(`  Nyomat: ${full.widthMm.toFixed(0)} × ${full.heightMm.toFixed(0)} mm @ ${s.dpi} DPI → ${full.width}×${full.height} px (${mp.toFixed(1)} MP)`);
  console.log(`  Rasztercella ${full.cellPx.toFixed(2)} px, legkisebb pont ${full.minDotPx.toFixed(2)} px`);
  console.log(`  Pöttyszűrés: ${full.removedSpecks} elem törölve, ${full.filledHoles} lyuk kitöltve`);
  console.log(`  PNG: ${(bytes.length / 1e6).toFixed(2)} MB`);
  console.log('\n  Idők');
  console.log(`    előkészítés     ${tPrep.toFixed(0).padStart(6)} ms`);
  console.log(`    előnézet (900)  ${tPreview.toFixed(0).padStart(6)} ms`);
  console.log(`    teljes render   ${tFull.toFixed(0).padStart(6)} ms`);
  console.log(`    ellenőrzés      ${tChecks.toFixed(0).padStart(6)} ms`);
  console.log(`    PNG kódolás     ${tEncode.toFixed(0).padStart(6)} ms`);
  console.log('\n  Ellenőrzés');
  for (const c of analysis.checks) {
    const mark = c.level === 'ok' ? '✓' : c.level === 'info' ? '·' : c.level === 'warn' ? '⚠' : '✕';
    console.log(`    ${mark} ${c.title}`);
  }
  console.log('');
}

void main();
