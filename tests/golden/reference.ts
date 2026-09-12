import { createBuffer } from '../../src/core/buffer';
import { hashNoise2D } from '../../src/core/rng';
import type { PixelBuffer } from '../../src/core/types';

/**
 * A deterministic reference image with the features dithering algorithms are
 * judged on: a full-range horizontal ramp, a vertical ramp, hard edges, a
 * circular gradient, saturated colour patches and a noisy corner.
 */
export function referenceImage(width = 96, height = 64): PixelBuffer {
  const buf = createBuffer(width, height);
  const d = buf.data;
  const cx = width * 0.5;
  const cy = height * 0.5;
  const maxR = Math.sqrt(cx * cx + cy * cy);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const u = x / (width - 1);
      const v = y / (height - 1);

      let r: number;
      let g: number;
      let b: number;

      if (v < 0.25) {
        // Horizontal grey ramp.
        r = g = b = u;
      } else if (v < 0.45) {
        // Saturated colour bars.
        const band = Math.floor(u * 6);
        r = band === 0 || band === 3 || band === 5 ? 1 : 0.05;
        g = band === 1 || band === 3 || band === 4 ? 1 : 0.05;
        b = band === 2 || band === 4 || band === 5 ? 1 : 0.05;
      } else if (v < 0.7) {
        // Radial gradient with a hard-edged square cut into it.
        const dx = x - cx;
        const dy = y - cy;
        const t = 1 - Math.sqrt(dx * dx + dy * dy) / maxR;
        const inSquare = u > 0.4 && u < 0.6 && v > 0.5 && v < 0.65;
        r = g = b = inSquare ? 1 - t : t;
      } else if (v < 0.85) {
        // Fine vertical stripes: the classic aliasing torture test.
        const on = (x % 3) === 0;
        r = g = b = on ? 0.85 : 0.15;
      } else {
        // Seeded noise field.
        r = hashNoise2D(x, y, 12345);
        g = hashNoise2D(x, y, 54321);
        b = hashNoise2D(x, y, 99999);
      }

      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = 1;
    }
  }
  return buf;
}
