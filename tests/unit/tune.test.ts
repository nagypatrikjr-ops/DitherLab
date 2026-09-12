import { describe, expect, it } from 'vitest';
import { createBuffer } from '../../src/core/buffer';
import type { PixelBuffer, RGB } from '../../src/core/types';
import {
  DEFAULT_TRANSFER,
  LOOKS,
  analyzeTransfer,
  renderTransfer,
  type TransferSettings,
} from '../../src/core/transfer';
import {
  MILKY_LIMIT,
  autoTune,
  diagnose,
  evaluateSettings,
  recommendedLpi,
} from '../../src/core/transfer/tune';

function settings(over: Partial<TransferSettings> = {}): TransferSettings {
  return {
    ...DEFAULT_TRANSFER,
    ...over,
    knockout: { ...DEFAULT_TRANSFER.knockout, ...(over.knockout ?? {}) },
    screen: { ...DEFAULT_TRANSFER.screen, ...(over.screen ?? {}) },
  };
}

/** A poster-like image: dark-red glow over black, a bright subject, white text bar. */
function darkPoster(w = 160, h = 120): PixelBuffer {
  const b = createBuffer(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const v = y / h;
      const glow = Math.max(0, 1 - Math.hypot(u - 0.5, v - 0.45) * 1.6);
      let c: RGB = { r: 0.06 + 0.5 * glow, g: 0.02 + 0.03 * glow, b: 0.03 + 0.08 * glow };
      if (Math.hypot(u - 0.5, v - 0.45) < 0.14) c = { r: 0.9, g: 0.12, b: 0.2 };
      if (v > 0.78 && v < 0.86 && u > 0.2 && u < 0.8) c = { r: 0.97, g: 0.97, b: 0.97 };
      const i = (y * w + x) * 4;
      b.data[i] = c.r;
      b.data[i + 1] = c.g;
      b.data[i + 2] = c.b;
      b.data[i + 3] = 1;
    }
  }
  return b;
}

describe('auto-tune', () => {
  it('pulls a milky print under the limit without losing the image', () => {
    const photo = LOOKS.find((l) => l.id === 'photo');
    expect(photo).toBeDefined();
    const base = settings({ knockout: photo!.knockout });
    const src = darkPoster();
    const r = autoTune(src, base);
    expect(r.before.milky).toBeGreaterThan(MILKY_LIMIT);
    expect(r.metrics.milky).toBeLessThanOrEqual(MILKY_LIMIT);
    expect(r.metrics.toneError).toBeLessThan(0.02);
    expect(r.notes.join(' ')).toContain('Tejes kockázat');
  });

  it('leaves clean solid art solid', () => {
    const src = createBuffer(80, 60);
    for (let i = 0; i < src.data.length; i += 4) {
      src.data[i] = 1;
      src.data[i + 1] = 1;
      src.data[i + 2] = 1;
      src.data[i + 3] = 1;
    }
    const r = autoTune(src, settings());
    expect(r.metrics.milky).toBe(0);
    expect(r.metrics.dotShare).toBeLessThan(0.01);
  });

  it('raises the tolerance to stop grain sprinkling the shirt', () => {
    const w = 160;
    const h = 120;
    const src = createBuffer(w, h);
    let seed = 3;
    for (let p = 0; p < w * h; p++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const n = (seed / 4294967296) * 0.14; // faint grain just above black
      src.data[p * 4] = 0.055 + n;
      src.data[p * 4 + 1] = 0.055 + n;
      src.data[p * 4 + 2] = 0.06 + n;
      src.data[p * 4 + 3] = 1;
    }
    const base = settings({ knockout: { ...DEFAULT_TRANSFER.knockout, tolerance: 0.03 } });
    const r = autoTune(src, base);
    expect(r.metrics.sparse).toBeLessThan(r.before.sparse);
    expect(r.settings.knockout.tolerance).toBeGreaterThan(0.03);
  });

  it('picks the finest ruling the minimum dot allows', () => {
    expect(recommendedLpi(settings({ chokeMm: 0.17 }))).toBe(30);
    expect(recommendedLpi(settings({ chokeMm: 0.085 }))).toBe(40);
    expect(recommendedLpi(settings({ chokeMm: 0.3 }))).toBeLessThanOrEqual(25);
  });

  it('is deterministic', () => {
    const a = autoTune(darkPoster(), settings());
    const b = autoTune(darkPoster(), settings());
    expect(JSON.stringify(a.settings)).toBe(JSON.stringify(b.settings));
  });

  it('offers distinct candidates, the chosen one first', () => {
    const r = autoTune(darkPoster(), settings());
    expect(r.candidates.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(r.candidates[0].settings.knockout)).toBe(JSON.stringify(r.settings.knockout));
    const keys = new Set(r.candidates.map((c) => JSON.stringify(c.settings.knockout)));
    expect(keys.size).toBe(r.candidates.length);
  });

  it('agrees with the milky check on the real render', () => {
    // The tuner judges a reduced copy with the renderer's model; the check
    // measures the finished file. They must tell the same story.
    const src = darkPoster(200, 150);
    for (const look of LOOKS) {
      const s = settings({ widthMm: 60, knockout: look.knockout });
      const predicted = evaluateSettings(src, s).milky;
      const r = renderTransfer(src, s);
      const measured = analyzeTransfer(r, s).stats.milkyShare;
      expect(Math.abs(predicted - measured), look.id).toBeLessThan(0.06);
    }
  });

  it('diagnoses the image honestly', () => {
    const d = diagnose(darkPoster(), settings());
    expect(d.darkToneShare).toBeGreaterThan(0.2);
    expect(d.hasTransparency).toBe(false);
    expect(d.sourceDpi).toBeCloseTo(160 / (280 / 25.4), 6);
  });
});

describe('milky and halo checks', () => {
  it('flags a print that puts dark ink on white underbase', () => {
    const s = settings({ widthMm: 60, knockout: { enabled: true, tolerance: 0.05, solidPoint: 0.3, density: 1 } });
    const r = renderTransfer(darkPoster(), s);
    const a = analyzeTransfer(r, s);
    expect(a.checks.find((c) => c.id === 'milky')?.level).toBe('warn');
  });

  it('warns when the choke is too small to hide the white', () => {
    const r = renderTransfer(darkPoster(80, 60), settings({ widthMm: 30 }));
    const level = (chokeMm: number) =>
      analyzeTransfer(r, settings({ chokeMm })).checks.find((c) => c.id === 'halo')?.level;
    expect(level(0.04)).toBe('warn');
    expect(level(0.1)).toBe('info');
    expect(level(0.2)).toBe('ok');
  });
});
