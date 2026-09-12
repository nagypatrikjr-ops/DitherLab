import { hashNoise2D } from '../rng';
import { blueNoise } from '../dither/ordered/matrices';
import { dotThreshold, type DotShape } from '../dither/halftone/shapes';
import type { PrintDotShape, ScreenSettings } from './types';

/**
 * Turning coverage into printable dots.
 *
 * Three things happen before a single dot is placed, and skipping any of them
 * is why "it looked fine on screen" turns into a muddy shirt:
 *
 *  1. Dot gain compensation. Ink spreads into fabric, so a 50% dot on the film
 *     prints closer to 70%. The film therefore has to carry a *smaller* dot.
 *  2. Tonal clamping. A press cannot hold a 3% dot (it drops out) or a 95% one
 *     (it fills in). Everything that should print is squeezed into the range
 *     the press can actually hold.
 *  3. A true knockout. Coverage below the knockout threshold becomes exactly
 *     zero ink, so the garment shows through cleanly instead of picking up a
 *     haze of stray dots.
 */

/**
 * Inverse of the parabolic gain curve c = f + 2·g·f·(1−f).
 * Solving 2g·f² − (1+2g)·f + c = 0 for the root inside [0,1].
 */
export function compensateDotGain(printed: number, gain: number): number {
  const c = printed < 0 ? 0 : printed > 1 ? 1 : printed;
  if (gain <= 1e-6) return c;
  const b = 1 + 2 * gain;
  const disc = b * b - 8 * gain * c;
  if (disc <= 0) return c;
  const f = (b - Math.sqrt(disc)) / (4 * gain);
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

/** Map coverage into the range the press can hold, keeping a true knockout. */
export function applyTonalRange(coverage: number, s: ScreenSettings): number {
  if (coverage <= s.knockoutBelow) return 0;
  if (coverage >= s.solidAbove) return 1;
  const t = (coverage - s.knockoutBelow) / Math.max(1e-6, s.solidAbove - s.knockoutBelow);
  return s.minDot + t * (s.maxDot - s.minDot);
}

const SHAPE_MAP: Record<PrintDotShape, DotShape> = {
  round: 'round',
  square: 'square',
  ellipse: 'ellipse',
  euclidean: 'euclidean',
  line: 'line',
};

const SHAPE_OPTS = { rings: 3, waveAmplitude: 0, waveFrequency: 1 };

/**
 * Halftone one coverage map into a 1-bit separation.
 *
 * AM places a dot of varying size on a fixed angled grid — predictable on
 * press, the default for textile. FM keeps the dot size fixed and varies how
 * many there are, which cannot moire at all and suits grainy artwork, at the
 * cost of being harder to hold in the highlights.
 */
export function screenCoverage(
  coverage: Uint8Array,
  width: number,
  height: number,
  s: ScreenSettings,
  angleOverride?: number,
): Uint8Array {
  const bits = new Uint8Array(width * height);
  const cellPx = Math.max(1.2, s.dpi / Math.max(1, s.lpi));
  const angle = ((angleOverride ?? s.angle) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const shape = SHAPE_MAP[s.shape];

  // Precompute the coverage transfer curve over the 256 input levels.
  const curve = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    curve[i] = compensateDotGain(applyTonalRange(i / 255, s), s.dotGain);
  }

  if (s.type === 'fm') {
    // Stochastic screening: a blue-noise threshold on a cell lattice, so the
    // micro-dots stay a printable size instead of collapsing to single pixels.
    const noise = blueNoise(64, 1.5, (s.seed % 1024) + 1);
    const fmCell = Math.max(1, cellPx * 0.62);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        const tone = curve[coverage[p]];
        if (tone <= 0) continue;
        if (tone >= 1) {
          bits[p] = 1;
          continue;
        }
        const u = (x * cos + y * sin) / fmCell;
        const v = (-x * sin + y * cos) / fmCell;
        const nx = ((Math.floor(u) % 64) + 64) % 64;
        const ny = ((Math.floor(v) % 64) + 64) % 64;
        // Break the 64-cell tile repeat with a coarse positional hash.
        const jitter =
          (hashNoise2D(Math.floor(u / 64), Math.floor(v / 64), s.seed) - 0.5) / 64;
        bits[p] = tone > noise.data[ny * 64 + nx] + jitter ? 1 : 0;
      }
    }
    return bits;
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const tone = curve[coverage[p]];
      if (tone <= 0) continue;
      if (tone >= 1) {
        bits[p] = 1;
        continue;
      }
      const u = (x * cos + y * sin) / cellPx;
      const v = (-x * sin + y * cos) / cellPx;
      const fu = u - Math.floor(u) - 0.5;
      const fv = v - Math.floor(v) - 0.5;
      bits[p] = tone > dotThreshold(shape, fu, fv, SHAPE_OPTS) ? 1 : 0;
    }
  }
  return bits;
}

/** Fraction of the area carrying ink. Drives the "will this print" hints. */
export function inkCoverage(bits: Uint8Array): number {
  let on = 0;
  for (let i = 0; i < bits.length; i++) on += bits[i];
  return bits.length === 0 ? 0 : on / bits.length;
}
