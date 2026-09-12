import { describe, expect, it } from 'vitest';
import { createBuffer } from '../../src/core/buffer';
import { registerAllProcessors } from '../../src/core';
import type { PixelBuffer, RGB } from '../../src/core/types';
import {
  DEFAULT_TRANSFER,
  PLACEMENTS,
  SHIRT_SIZES,
  analyzeTransfer,
  renderTransfer,
  type TransferSettings,
} from '../../src/core/transfer';
import { autoTune } from '../../src/core/transfer/tune';
import { DEFAULT_SCREEN, DEFAULT_UNDERBASE, auditSeparations, buildSeparations, type Ink, type PrintJob } from '../../src/core/print';
import { collectCoreStrings } from '../../src/i18n/coreStrings';
import { CORE_EN } from '../../src/i18n/core-en';
import { translateDynamicEn } from '../../src/i18n/dynamic-en';
import { MESSAGES } from '../../src/i18n/messages';
import { coreText, formatNumber, translate } from '../../src/i18n';

registerAllProcessors();

const HUNGARIAN_LETTERS = /[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/;

function hasEnglish(hu: string): boolean {
  return CORE_EN[hu] !== undefined || translateDynamicEn(hu) !== null;
}

function settings(over: Partial<TransferSettings> = {}): TransferSettings {
  return {
    ...DEFAULT_TRANSFER,
    ...over,
    knockout: { ...DEFAULT_TRANSFER.knockout, ...(over.knockout ?? {}) },
    screen: { ...DEFAULT_TRANSFER.screen, ...(over.screen ?? {}) },
    edgeFade: { ...DEFAULT_TRANSFER.edgeFade, ...(over.edgeFade ?? {}) },
  };
}

/** Dark-red glow on black, a bright subject and a white bar — like a poster. */
function poster(w = 160, h = 120): PixelBuffer {
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

function flat(c: RGB, w = 120, h = 90): PixelBuffer {
  const b = createBuffer(w, h);
  for (let i = 0; i < b.data.length; i += 4) {
    b.data[i] = c.r;
    b.data[i + 1] = c.g;
    b.data[i + 2] = c.b;
    b.data[i + 3] = 1;
  }
  return b;
}

/** Every check title and detail the preflight produces over a spread of settings. */
function checkMessages(): string[] {
  const out = new Set<string>();
  const shirtS = SHIRT_SIZES.find((x) => x.id === 'S');
  const front = PLACEMENTS.find((p) => p.id === 'full-front');
  const chest = PLACEMENTS.find((p) => p.id === 'left-chest');
  const cases: { src: PixelBuffer; s: TransferSettings; ctx?: Parameters<typeof analyzeTransfer>[2] }[] = [
    { src: poster(), s: settings({ widthMm: 10 }) },
    { src: poster(), s: settings({ widthMm: 17 }) },
    { src: poster(), s: settings({ widthMm: 40 }) },
    { src: poster(), s: settings({ widthMm: 120, screen: { ...DEFAULT_TRANSFER.screen, lpi: 60 } }) },
    { src: poster(), s: settings({ widthMm: 60, screen: { ...DEFAULT_TRANSFER.screen, lpi: 50 } }) },
    { src: poster(), s: settings({ widthMm: 60, screen: { ...DEFAULT_TRANSFER.screen, lpi: 20 } }) },
    { src: poster(), s: settings({ widthMm: 60, screen: { ...DEFAULT_TRANSFER.screen, lpi: 55, minDotMm: 1.1 } }) },
    { src: poster(), s: settings({ widthMm: 60, screen: { ...DEFAULT_TRANSFER.screen, minDotMm: 0.3 } }) },
    { src: poster(), s: settings({ widthMm: 60, chokeMm: 0.05 }) },
    { src: poster(), s: settings({ widthMm: 60, chokeMm: 0.1 }) },
    { src: poster(), s: settings({ widthMm: 60, mirror: true }) },
    { src: poster(), s: settings({ widthMm: 60, knockout: { ...DEFAULT_TRANSFER.knockout, enabled: false } }) },
    { src: flat({ r: 0.6, g: 0.6, b: 0.6 }), s: settings({ widthMm: 60 }) },
    { src: poster(), s: settings({ widthMm: 280 }), ctx: { shirt: shirtS, placement: front } },
    { src: poster(), s: settings({ widthMm: 280 }), ctx: { placement: chest } },
    { src: poster(), s: settings({ widthMm: 100 }), ctx: { placement: chest } },
  ];
  for (const c of cases) {
    const r = renderTransfer(c.src, c.s);
    for (const check of analyzeTransfer(r, c.s, c.ctx).checks) {
      out.add(check.title);
      out.add(check.detail);
    }
  }
  return [...out];
}

function tuneMessages(): string[] {
  const out = new Set<string>();
  const variants = [
    settings(),
    settings({ chokeMm: 0.05 }),
    settings({ knockout: { ...DEFAULT_TRANSFER.knockout, tolerance: 0.3, solidPoint: 0.9, density: 1.4 } }),
  ];
  for (const s of variants) {
    for (const src of [poster(), flat({ r: 0.2, g: 0.02, b: 0.03 })]) {
      const r = autoTune(src, s);
      for (const n of r.notes) out.add(n);
      for (const c of r.candidates) out.add(c.label);
    }
  }
  return [...out];
}

function printMessages(): string[] {
  const inks: Ink[] = [
    { id: 'white', name: 'Fehér', color: { r: 1, g: 1, b: 1 }, order: 0, needsUnderbase: false, enabled: true },
    { id: 'red', name: 'Szín 2', color: { r: 0.85, g: 0.05, b: 0.15 }, order: 1, needsUnderbase: true, enabled: true },
  ];
  const job: PrintJob = {
    widthMm: 200,
    garment: { r: 0, g: 0, b: 0 },
    inks,
    screen: { ...DEFAULT_SCREEN },
    underbase: { ...DEFAULT_UNDERBASE },
  };
  const out = new Set<string>();
  const jobs: PrintJob[] = [
    job,
    { ...job, screen: { ...job.screen, lpi: 85, minDot: 0.03, maxDot: 0.97 } },
    { ...job, screen: { ...job.screen, lpi: 20, dpi: 60 } },
  ];
  for (const j of jobs) {
    for (const src of [poster(), flat({ r: 1, g: 1, b: 1 })]) {
      const result = buildSeparations(src, j, 300);
      for (const n of auditSeparations(result, j)) out.add(n.text);
      for (const sep of result.separations) out.add(sep.name);
    }
  }
  return [...out];
}

describe('English translations of core strings', () => {
  it('cover every name and label the core defines', () => {
    const missing = collectCoreStrings().filter((s) => CORE_EN[s] === undefined);
    expect(missing).toEqual([]);
  });

  it('cover every preflight message across a spread of settings', () => {
    const messages = checkMessages();
    expect(messages.length).toBeGreaterThan(30);
    const missing = messages.filter((m) => !hasEnglish(m));
    expect(missing).toEqual([]);
    for (const m of messages) expect(coreText('en', m)).not.toMatch(HUNGARIAN_LETTERS);
  });

  it('cover every auto-tune note and candidate label', () => {
    const messages = tuneMessages();
    expect(messages.length).toBeGreaterThan(4);
    expect(messages.filter((m) => !hasEnglish(m))).toEqual([]);
    for (const m of messages) expect(coreText('en', m)).not.toMatch(HUNGARIAN_LETTERS);
  });

  it('cover every screen-print note', () => {
    const messages = printMessages();
    expect(messages.filter((m) => !hasEnglish(m))).toEqual([]);
    for (const m of messages) expect(coreText('en', m)).not.toMatch(HUNGARIAN_LETTERS);
  });

  it('translate numbers and names inside messages', () => {
    expect(coreText('en', 'Pontsúly 1,00 → 1,20.')).toBe('Dot weight 1.00 → 1.20.');
    expect(coreText('en', 'Ráfér: Asztali DTF (30 cm), Szabványos gang sheet (22")')).toBe(
      'Fits: Desktop DTF (30 cm), Standard gang sheet (22")',
    );
    expect(coreText('en', 'Egyik szabványos filmszélességre sem fér rá')).toBe('Does not fit any standard film width');
    expect(coreText('en', 'Monokróm (szerkesztett)')).toBe('Monochrome (edited)');
    expect(coreText('en', 'something the core never says')).toBe('something the core never says');
  });

  it('leave Hungarian untouched', () => {
    for (const s of ['Nem lesz tejes', 'Pontsúly 1,00 → 1,20.', 'Floyd–Steinberg']) {
      expect(coreText('hu', s)).toBe(s);
    }
  });
});

describe('interface messages', () => {
  const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  it('have the same keys and the same placeholders in both languages', () => {
    const en = MESSAGES.en;
    const hu = MESSAGES.hu;
    expect(Object.keys(hu).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(en[key].trim(), key).not.toBe('');
      expect(hu[key].trim(), key).not.toBe('');
      expect(placeholders(hu[key]), key).toEqual(placeholders(en[key]));
    }
  });

  it('fill placeholders and format numbers per language', () => {
    expect(translate('en', 'dtf.dims', { w: '28.0', h: '28.0', wi: '11.0', hi: '11.0' })).toBe('28.0 × 28.0 cm (11.0" × 11.0")');
    expect(translate('hu', 'app.bigImage', { mp: 61 })).toBe('Nagy kép (61 megapixel) — a renderelés lassú lehet.');
    expect(formatNumber(1.5, 'hu', 2)).toBe('1,50');
    expect(formatNumber(1.5, 'en', 2)).toBe('1.50');
  });
});
