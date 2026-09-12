import { describe, expect, it } from 'vitest';
import { dotThreshold, type DotShape } from '../../src/core/dither/halftone/shapes';

const OPTS = { rings: 3, waveAmplitude: 0.2, waveFrequency: 2 };
const REGULAR: DotShape[] = ['round', 'square', 'ellipse', 'diamond', 'euclidean', 'line', 'cross'];

/** Inked share of one cell at tone a, sampled on an n x n grid of pixels. */
function coverage(shape: DotShape, a: number, n: number, offset = 0.37): number {
  let on = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      // Sample off the table grid so the check is not circular.
      const u = (i + offset) / n - 0.5;
      const v = (j + offset) / n - 0.5;
      if (dotThreshold(shape, u, v, OPTS) < a) on++;
    }
  }
  return on / (n * n);
}

describe('dot shapes', () => {
  for (const shape of REGULAR) {
    it(`${shape}: inks exactly the requested share of the cell`, () => {
      for (const a of [0.05, 0.2, 0.4, 0.5, 0.6, 0.8, 0.9, 0.97]) {
        expect(Math.abs(coverage(shape, a, 301) - a), `${shape} @ ${a}`).toBeLessThan(0.01);
      }
    });

    it(`${shape}: is empty at 0 and full at 1`, () => {
      expect(coverage(shape, 0, 101)).toBe(0);
      expect(coverage(shape, 1.0000001, 101)).toBe(1);
    });
  }

  it('round: keeps adding ink after the dots merge (no shortfall in the shadows)', () => {
    // A closed-form πr² threshold prints ~86% when 90% is asked for.
    expect(coverage('round', 0.9, 401)).toBeGreaterThan(0.89);
  });

  it('euclidean: a dot at 30% does not reach the middle of the cell edge', () => {
    // The regression: an area formula switched on the wrong boundary and
    // inked the edge midpoints long before the dot got there.
    expect(dotThreshold('euclidean', 0.45, 0, OPTS)).toBeGreaterThan(0.3);
    expect(dotThreshold('euclidean', 0.45, 0, OPTS)).toBeLessThan(0.7);
  });

  it('euclidean: forms a checkerboard at exactly 50%', () => {
    // Inside the centre diamond at 50%, outside it not.
    expect(dotThreshold('euclidean', 0.2, 0.2, OPTS)).toBeLessThan(0.5);
    expect(dotThreshold('euclidean', 0.3, 0.3, OPTS)).toBeGreaterThan(0.5);
  });

  it('grows monotonically from the centre for the round dot', () => {
    let prev = -1;
    for (let r = 0; r <= 0.7; r += 0.01) {
      const t = dotThreshold('round', r / Math.SQRT2, r / Math.SQRT2, OPTS);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });
});
