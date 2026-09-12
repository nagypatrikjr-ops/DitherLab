import { mkdirSync, writeFileSync } from 'node:fs';
import { encodePngRgba } from '../src/io/png';

/**
 * Draws the DitherLab app icon: a lit sphere rendered with an 8×8 Bayer
 * threshold in coarse blocks, on a rounded square. Written to build/icon.png
 * (1024², electron-builder derives .icns/.ico from it) and public/favicon.png.
 *
 *   npx vite-node scripts/make-icon.ts
 */

const SIZE = 1024;
const BAYER8 = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
];
const BG: [number, number, number] = [22, 22, 26];
const INK: [number, number, number] = [232, 116, 63];
const BLOCK = 20;

/** Coverage of the macOS-style rounded square (824² with 185 px corners). */
function squareCoverage(px: number, py: number): number {
  const inset = 100;
  const r = 185;
  let hits = 0;
  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) {
      const x = px + (sx + 0.5) / 4;
      const y = py + (sy + 0.5) / 4;
      const cx = Math.min(Math.max(x, inset + r), SIZE - inset - r);
      const cy = Math.min(Math.max(y, inset + r), SIZE - inset - r);
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= inset && x <= SIZE - inset && y >= inset && y <= SIZE - inset) hits++;
    }
  }
  return hits / 16;
}

/** Lambert-lit sphere tone at a block centre, 0..1, or -1 outside. */
function sphereTone(x: number, y: number): number {
  const radius = 300;
  const nx = (x - SIZE / 2) / radius;
  const ny = (y - SIZE / 2) / radius;
  const d2 = nx * nx + ny * ny;
  if (d2 > 1) return -1;
  const nz = Math.sqrt(1 - d2);
  const lx = -0.5;
  const ly = -0.62;
  const lz = 0.6;
  const len = Math.hypot(lx, ly, lz);
  const lambert = Math.max(0, (nx * lx + ny * ly + nz * lz) / len);
  return Math.min(1, 0.08 + 0.95 * lambert);
}

function draw(): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const cover = squareCoverage(x, y);
      if (cover === 0) continue;
      const bx = Math.floor(x / BLOCK);
      const by = Math.floor(y / BLOCK);
      const tone = sphereTone((bx + 0.5) * BLOCK, (by + 0.5) * BLOCK);
      const on = tone >= 0 && tone > (BAYER8[(by % 8) * 8 + (bx % 8)] + 0.5) / 64;
      const c = on ? INK : BG;
      const i = (y * SIZE + x) * 4;
      rgba[i] = c[0];
      rgba[i + 1] = c[1];
      rgba[i + 2] = c[2];
      rgba[i + 3] = Math.round(cover * 255);
    }
  }
  return rgba;
}

/** Premultiplied box reduction so the transparent corners stay clean. */
function reduce(src: Uint8ClampedArray, size: number, target: number): Uint8ClampedArray {
  const k = size / target;
  const out = new Uint8ClampedArray(target * target * 4);
  for (let y = 0; y < target; y++) {
    for (let x = 0; x < target; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = Math.floor(y * k); sy < Math.floor((y + 1) * k); sy++) {
        for (let sx = Math.floor(x * k); sx < Math.floor((x + 1) * k); sx++) {
          const i = (sy * size + sx) * 4;
          const w = src[i + 3] / 255;
          r += src[i] * w;
          g += src[i + 1] * w;
          b += src[i + 2] * w;
          a += w;
        }
      }
      const o = (y * target + x) * 4;
      const n = Math.floor((y + 1) * k) - Math.floor(y * k);
      const count = n * (Math.floor((x + 1) * k) - Math.floor(x * k));
      out[o] = a > 0 ? r / a : 0;
      out[o + 1] = a > 0 ? g / a : 0;
      out[o + 2] = a > 0 ? b / a : 0;
      out[o + 3] = Math.round((a / count) * 255);
    }
  }
  return out;
}

const full = draw();
mkdirSync('build', { recursive: true });
writeFileSync('build/icon.png', await encodePngRgba(full, SIZE, SIZE));
writeFileSync('public/favicon.png', await encodePngRgba(reduce(full, SIZE, 64), 64, 64));
console.log('wrote build/icon.png (1024²) and public/favicon.png (64²)');
