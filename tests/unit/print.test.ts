import { describe, expect, it } from 'vitest';
import { createBuffer } from '../../src/core/buffer';
import {
  applyTonalRange,
  auditSeparations,
  buildSeparations,
  compensateDotGain,
  DEFAULT_SCREEN,
  DEFAULT_UNDERBASE,
  erode,
  inkCoverage,
  outputSize,
  recommendedMesh,
  renderPrintPreview,
  screenCoverage,
  separate,
  separationToBuffer,
  suggestInks,
  type Ink,
  type PrintJob,
} from '../../src/core/print';
import type { PixelBuffer, RGB } from '../../src/core/types';

const BLACK: RGB = { r: 0, g: 0, b: 0 };
const RED: RGB = { r: 0.85, g: 0.05, b: 0.15 };
const WHITE: RGB = { r: 1, g: 1, b: 1 };

const INKS: Ink[] = [
  { id: 'white', name: 'Fehér', color: WHITE, order: 0, needsUnderbase: false, enabled: true },
  { id: 'red', name: 'Piros', color: RED, order: 1, needsUnderbase: true, enabled: true },
];

function flat(color: RGB, w = 32, h = 32): PixelBuffer {
  const b = createBuffer(w, h);
  for (let i = 0; i < b.data.length; i += 4) {
    b.data[i] = color.r;
    b.data[i + 1] = color.g;
    b.data[i + 2] = color.b;
    b.data[i + 3] = 1;
  }
  return b;
}

function meanCoverage(map: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < map.length; i++) s += map[i];
  return s / map.length / 255;
}

describe('spot colour separation', () => {
  it('gives full coverage to the matching ink and none to the others', () => {
    const white = separate(flat(WHITE), BLACK, INKS);
    expect(meanCoverage(white.maps[0])).toBeGreaterThan(0.95);
    expect(meanCoverage(white.maps[1])).toBeLessThan(0.1);

    const red = separate(flat(RED), BLACK, INKS);
    expect(meanCoverage(red.maps[1])).toBeGreaterThan(0.9);
    expect(meanCoverage(red.maps[0])).toBeLessThan(0.1);
  });

  it('puts no ink at all on the garment colour', () => {
    const bare = separate(flat(BLACK), BLACK, INKS);
    expect(meanCoverage(bare.maps[0])).toBeLessThan(0.01);
    expect(meanCoverage(bare.maps[1])).toBeLessThan(0.01);
  });

  it('reads a dim version of an ink as partial coverage', () => {
    // Half-strength red over black should ask for roughly half the dots.
    const dim = separate(flat({ r: RED.r * 0.5, g: RED.g * 0.5, b: RED.b * 0.5 }), BLACK, INKS);
    const c = meanCoverage(dim.maps[1]);
    expect(c).toBeGreaterThan(0.1);
    expect(c).toBeLessThan(0.75);
  });

  it('never asks for more ink than the area can hold', () => {
    const grey = separate(flat({ r: 0.5, g: 0.5, b: 0.5 }), BLACK, INKS);
    for (let p = 0; p < grey.maps[0].length; p++) {
      expect(grey.maps[0][p] + grey.maps[1][p]).toBeLessThanOrEqual(256);
    }
  });

  it('suggests the garment and inks from a flat poster', () => {
    const src = createBuffer(60, 20);
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 60; x++) {
        const c = x < 20 ? BLACK : x < 40 ? RED : WHITE;
        const i = (y * 60 + x) * 4;
        src.data[i] = c.r;
        src.data[i + 1] = c.g;
        src.data[i + 2] = c.b;
        src.data[i + 3] = 1;
      }
    }
    const { garment, inks } = suggestInks(src, 3);
    expect(garment.r).toBeLessThan(0.2);
    expect(inks.length).toBe(2);
    const brightest = inks[inks.length - 1];
    expect(brightest.r).toBeGreaterThan(0.8);
    expect(brightest.g).toBeGreaterThan(0.8);
  });
});

describe('dot gain compensation', () => {
  it('is the exact inverse of the press gain curve', () => {
    const gain = 0.22;
    const press = (f: number): number => f + 2 * gain * f * (1 - f);
    for (const target of [0.05, 0.2, 0.4, 0.5, 0.7, 0.9]) {
      const film = compensateDotGain(target, gain);
      expect(press(film)).toBeCloseTo(target, 5);
      expect(film).toBeLessThanOrEqual(target + 1e-9);
    }
  });

  it('is a no-op when there is no gain', () => {
    expect(compensateDotGain(0.37, 0)).toBeCloseTo(0.37, 6);
  });

  it('keeps the endpoints pinned', () => {
    expect(compensateDotGain(0, 0.3)).toBeCloseTo(0, 6);
    expect(compensateDotGain(1, 0.3)).toBeCloseTo(1, 6);
  });
});

describe('tonal range', () => {
  const s = DEFAULT_SCREEN;

  it('knocks out completely below the threshold', () => {
    expect(applyTonalRange(0, s)).toBe(0);
    expect(applyTonalRange(s.knockoutBelow, s)).toBe(0);
  });

  it('goes fully solid above the threshold', () => {
    expect(applyTonalRange(1, s)).toBe(1);
    expect(applyTonalRange(s.solidAbove, s)).toBe(1);
  });

  it('squeezes everything between the two ends into the holdable range', () => {
    // Outside the ends the answer is 0 or 1 by design; in between it must land
    // where the press can actually hold a dot.
    for (const c of [s.knockoutBelow + 0.001, 0.25, 0.5, 0.8, s.solidAbove - 0.001]) {
      const v = applyTonalRange(c, s);
      expect(v, `c=${c}`).toBeGreaterThanOrEqual(s.minDot - 1e-9);
      expect(v, `c=${c}`).toBeLessThanOrEqual(s.maxDot + 1e-9);
    }
    expect(applyTonalRange(s.solidAbove + 0.001, s)).toBe(1);
  });

  it('stays monotonic', () => {
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const v = applyTonalRange(i / 100, s);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe('screening', () => {
  const size = 240;

  it('lays down the compensated amount of ink', () => {
    const cov = new Uint8Array(size * size).fill(128);
    const bits = screenCoverage(cov, size, size, DEFAULT_SCREEN);
    const expected = compensateDotGain(applyTonalRange(128 / 255, DEFAULT_SCREEN), DEFAULT_SCREEN.dotGain);
    expect(Math.abs(inkCoverage(bits) - expected)).toBeLessThan(0.05);
  });

  it('leaves knocked-out areas completely bare', () => {
    const cov = new Uint8Array(size * size).fill(0);
    for (const type of ['am', 'fm'] as const) {
      const bits = screenCoverage(cov, size, size, { ...DEFAULT_SCREEN, type });
      expect(inkCoverage(bits)).toBe(0);
    }
  });

  it('fills solid areas completely', () => {
    const cov = new Uint8Array(size * size).fill(255);
    for (const type of ['am', 'fm'] as const) {
      const bits = screenCoverage(cov, size, size, { ...DEFAULT_SCREEN, type });
      expect(inkCoverage(bits)).toBe(1);
    }
  });

  it('produces separated dots rather than a smear', () => {
    // The point of screening: a flat midtone must become isolated dots with
    // bare garment between them, not a solid or a blur.
    const cov = new Uint8Array(size * size).fill(110);
    const bits = screenCoverage(cov, size, size, DEFAULT_SCREEN);
    let transitions = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 1; x < size; x++) {
        if (bits[y * size + x] !== bits[y * size + x - 1]) transitions++;
      }
    }
    // A solid or empty field has zero transitions; real dots have many.
    expect(transitions).toBeGreaterThan(size * 4);
  });

  it('makes dots whose pitch follows the LPI', () => {
    const cov = new Uint8Array(size * size).fill(128);
    const coarse = screenCoverage(cov, size, size, { ...DEFAULT_SCREEN, lpi: 20, angle: 0 });
    const fine = screenCoverage(cov, size, size, { ...DEFAULT_SCREEN, lpi: 60, angle: 0 });
    const runs = (bits: Uint8Array): number => {
      let n = 0;
      for (let y = 0; y < size; y++) {
        for (let x = 1; x < size; x++) {
          if (bits[y * size + x] === 1 && bits[y * size + x - 1] === 0) n++;
        }
      }
      return n;
    };
    // Finer ruling means more, smaller dots for the same tone.
    expect(runs(fine)).toBeGreaterThan(runs(coarse) * 1.8);
  });

  it('is deterministic', () => {
    const cov = new Uint8Array(size * size).fill(90);
    for (const type of ['am', 'fm'] as const) {
      const a = screenCoverage(cov, size, size, { ...DEFAULT_SCREEN, type });
      const b = screenCoverage(cov, size, size, { ...DEFAULT_SCREEN, type });
      expect(Array.from(a)).toEqual(Array.from(b));
    }
  });
});

describe('morphology', () => {
  it('erodes a block by the given radius', () => {
    const w = 11;
    const src = new Uint8Array(w * w);
    for (let y = 2; y <= 8; y++) for (let x = 2; x <= 8; x++) src[y * w + x] = 255;
    const out = erode(src, w, w, 1);
    let on = 0;
    for (let i = 0; i < out.length; i++) if (out[i] > 0) on++;
    expect(on).toBe(5 * 5);
    expect(out[3 * w + 3]).toBe(255);
    expect(out[2 * w + 2]).toBe(0);
  });
});

describe('end to end separation', () => {
  const job: PrintJob = {
    widthMm: 250,
    garment: BLACK,
    inks: INKS,
    screen: { ...DEFAULT_SCREEN, dpi: 300 },
    underbase: { ...DEFAULT_UNDERBASE, chokePx: 2 },
  };

  function poster(): PixelBuffer {
    const w = 90;
    const h = 60;
    const src = createBuffer(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // Left third garment, middle a red gradient, right white.
        let c: RGB;
        if (x < 30) c = BLACK;
        else if (x < 60) {
          const t = (x - 30) / 30;
          c = { r: RED.r * t, g: RED.g * t, b: RED.b * t };
        } else c = WHITE;
        const i = (y * w + x) * 4;
        src.data[i] = c.r;
        src.data[i + 1] = c.g;
        src.data[i + 2] = c.b;
        src.data[i + 3] = 1;
      }
    }
    return src;
  }

  it('produces one screen per ink plus the underbase', () => {
    const result = buildSeparations(poster(), job, 600);
    expect(result.separations.map((s) => s.id)).toEqual(['underbase', 'white', 'red']);
    expect(result.separations[0].isUnderbase).toBe(true);
  });

  it('leaves the garment area untouched on every screen', () => {
    const result = buildSeparations(poster(), job, 600);
    const w = result.width;
    // Sample well inside the left third, away from any edge transition.
    for (const sep of result.separations) {
      let on = 0;
      for (let y = 10; y < result.height - 10; y++) {
        for (let x = 5; x < Math.floor(w * 0.28); x++) {
          on += sep.bits[y * w + x];
        }
      }
      expect(on, `${sep.name} tintát tett a kihagyott területre`).toBe(0);
    }
  });

  it('scales the film to the requested physical size', () => {
    const full = buildSeparations(poster(), { ...job, widthMm: 254 });
    // 254 mm = 10 inch, at 300 dpi that is 3000 px.
    expect(full.width).toBe(3000);
    expect(full.widthMm).toBe(254);
  });

  it('chokes the underbase so it stays inside the colours', () => {
    const withChoke = buildSeparations(poster(), job, 600);
    const noChoke = buildSeparations(
      poster(),
      { ...job, underbase: { ...job.underbase, chokePx: 0 } },
      600,
    );
    const base = (r: typeof withChoke): number =>
      r.separations.find((s) => s.isUnderbase)?.coverage ?? 0;
    expect(base(withChoke)).toBeLessThan(base(noChoke));
  });

  it('chokes the outline without thinning the middle of the base', () => {
    // A choke must shrink the silhouette. Eroding the greyscale coverage
    // instead would also eat the tonality inside, leaving the colours on bare
    // fabric where the artwork is grainy.
    const w = 80;
    const h = 40;
    const src = createBuffer(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // A solid red block with heavy grain, surrounded by garment.
        const inside = x > 20 && x < 60 && y > 8 && y < 32;
        const n = inside ? ((x * 7 + y * 13) % 5) * 0.03 : 0;
        const c: RGB = inside
          ? { r: RED.r - n, g: RED.g, b: RED.b - n * 0.4 }
          : BLACK;
        const i = (y * w + x) * 4;
        src.data[i] = c.r;
        src.data[i + 1] = c.g;
        src.data[i + 2] = c.b;
        src.data[i + 3] = 1;
      }
    }
    const solidBase: PrintJob = {
      ...job,
      screen: { ...job.screen, dpi: 300 },
      underbase: { ...job.underbase, chokePx: 3, halftoned: false },
    };
    const result = buildSeparations(src, solidBase, 320);
    const base = result.separations.find((s) => s.isUnderbase);
    expect(base).toBeDefined();
    if (!base) return;

    // The middle of the block must be continuous ink, not eaten by the choke.
    const cx = Math.round(base.width * 0.5);
    const cy = Math.round(base.height * 0.5);
    let solidRun = 0;
    for (let x = cx - 5; x <= cx + 5; x++) solidRun += base.bits[cy * base.width + x];
    expect(solidRun, 'a choke kilyukasztotta az aláfestés közepét').toBe(11);

    // ...while the edge is pulled in relative to no choke at all.
    const noChoke = buildSeparations(
      src,
      { ...solidBase, underbase: { ...solidBase.underbase, chokePx: 0 } },
      320,
    );
    const nb = noChoke.separations.find((s) => s.isUnderbase);
    expect(nb).toBeDefined();
    if (nb) expect(base.coverage).toBeLessThan(nb.coverage);
  });

  it('can be turned off entirely', () => {
    const result = buildSeparations(
      poster(),
      { ...job, underbase: { ...job.underbase, enabled: false } },
      600,
    );
    expect(result.separations.some((s) => s.isUnderbase)).toBe(false);
  });

  it('renders a preview on the garment colour', () => {
    const result = buildSeparations(poster(), job, 400);
    const preview = renderPrintPreview(result, BLACK);
    expect(preview.width).toBe(result.width);
    // The left third must still be garment colour.
    const i = (Math.floor(result.height / 2) * result.width + 5) * 4;
    expect(preview.data[i]).toBeCloseTo(BLACK.r, 5);
    expect(preview.data[i + 1]).toBeCloseTo(BLACK.g, 5);
  });

  it('writes film positives with ink as black', () => {
    const result = buildSeparations(poster(), job, 300);
    const sep = result.separations[result.separations.length - 1];
    const film = separationToBuffer(sep);
    let black = 0;
    for (let p = 0; p < sep.bits.length; p++) {
      if (film.data[p * 4] < 0.5) black++;
    }
    let ink = 0;
    for (let p = 0; p < sep.bits.length; p++) ink += sep.bits[p];
    expect(black).toBe(ink);
  });

  it('raises the warnings a print shop would', () => {
    const bad = buildSeparations(poster(), { ...job, screen: { ...job.screen, lpi: 85 } }, 300);
    const notes = auditSeparations(bad, { ...job, screen: { ...job.screen, lpi: 85 } });
    expect(notes.some((n) => n.level === 'warn' && n.text.includes('85 LPI'))).toBe(true);
    expect(notes.some((n) => n.text.includes('szitasűrűség'))).toBe(true);
  });
});

describe('print maths', () => {
  it('converts millimetres to film pixels', () => {
    expect(outputSize(254, 300, 1).width).toBe(3000);
    expect(outputSize(254, 600, 1).width).toBe(6000);
    expect(outputSize(100, 300, 2).height).toBe(Math.round((100 / 25.4) * 300 / 2));
  });

  it('recommends the 4-5x mesh count', () => {
    expect(recommendedMesh(45)).toEqual({ min: 180, max: 225 });
    expect(recommendedMesh(35)).toEqual({ min: 140, max: 175 });
  });
});
