import { describe, expect, it } from 'vitest';
import { fillHoleColors } from '../../src/core/transfer/engine';

describe('fillHoleColors at print resolution', () => {
  it('handles more unresolved hole pixels than a call can take as arguments', () => {
    // 3×3 holes on a 4-pixel pitch: every hole's centre has no inked neighbour
    // in the first pass, so ~250 000 pixels are carried into the second one.
    // A 600 DPI file of a large print has this many; the old code spread them
    // into Array.prototype.push and died with "Maximum call stack size exceeded".
    const w = 2000;
    const h = 2000;
    const ink = new Uint8Array(w * h).fill(1);
    const before = new Uint8Array(w * h).fill(1);
    const cmap = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (x % 4 === 3 || y % 4 === 3) {
          cmap[p * 3] = 200; // the surrounding ink is red
        } else {
          before[p] = 0; // a pinhole that cleanup filled
        }
      }
    }
    expect(() => fillHoleColors(ink, before, cmap, w, h)).not.toThrow();
    // Every filled pixel took the colour of the ink around it.
    for (let p = 0; p < w * h; p++) {
      if (before[p] === 0 && cmap[p * 3] !== 200) {
        throw new Error(`pixel ${p} left without a colour`);
      }
    }
  });
});
