import type { Palette } from '../types';

/** "#RRGGBB" | "RRGGBB" -> 0..1 triplet, appended to `out`. */
export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.trim().replace(/^#/, '');
  const full = h.length === 3 ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2] : h;
  const n = Number.parseInt(full.slice(0, 6), 16);
  if (Number.isNaN(n)) throw new Error(`Invalid hex colour: "${hex}"`);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number): string => {
    const i = Math.round(Math.min(1, Math.max(0, v)) * 255);
    return i.toString(16).padStart(2, '0');
  };
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

export function paletteFromHex(
  id: string,
  name: string,
  category: string,
  hexes: readonly string[],
): Palette {
  const colors = new Float32Array(hexes.length * 3);
  for (let i = 0; i < hexes.length; i++) {
    const [r, g, b] = hexToRgb(hexes[i]);
    colors[i * 3] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }
  return { id, name, category, colors };
}

function grayRamp(id: string, name: string, steps: number): Palette {
  const colors = new Float32Array(steps * 3);
  for (let i = 0; i < steps; i++) {
    const v = i / (steps - 1);
    colors[i * 3] = v;
    colors[i * 3 + 1] = v;
    colors[i * 3 + 2] = v;
  }
  return { id, name, category: 'Monokróm', colors };
}

/** All combinations of the given per-channel levels. */
function cube(id: string, name: string, category: string, levels: readonly number[]): Palette {
  const n = levels.length;
  const colors = new Float32Array(n * n * n * 3);
  let i = 0;
  for (const r of levels) {
    for (const g of levels) {
      for (const b of levels) {
        colors[i++] = r;
        colors[i++] = g;
        colors[i++] = b;
      }
    }
  }
  return { id, name, category, colors };
}

function ramp332(): Palette {
  // 3-3-2 bit RGB: the classic 8-bit truecolour approximation.
  const colors = new Float32Array(256 * 3);
  let i = 0;
  for (let r = 0; r < 8; r++) {
    for (let g = 0; g < 8; g++) {
      for (let b = 0; b < 4; b++) {
        colors[i++] = r / 7;
        colors[i++] = g / 7;
        colors[i++] = b / 3;
      }
    }
  }
  return { id: 'rgb332', name: 'RGB 3-3-2 (256)', category: 'Rendszer', colors };
}

export const BUILTIN_PALETTES: readonly Palette[] = [
  // --- Monochrome ---------------------------------------------------------
  paletteFromHex('bw1', '1-bit fekete-fehér', 'Monokróm', ['#000000', '#FFFFFF']),
  paletteFromHex('ink-paper', '1-bit tinta / papír', 'Monokróm', ['#1A1A1A', '#F2EFE6']),
  paletteFromHex('newsprint', 'Újságnyomat', 'Monokróm', ['#111111', '#EDE8DC']),
  paletteFromHex('blueprint', 'Kékmásolat', 'Monokróm', ['#0B3D91', '#E8EEF7']),
  paletteFromHex('phosphor-green', 'Zöld foszfor', 'Monokróm', ['#001100', '#33FF33']),
  paletteFromHex('phosphor-amber', 'Borostyán terminál', 'Monokróm', ['#150800', '#FFB000']),
  grayRamp('gray4', 'Szürke 4', 4),
  grayRamp('gray8', 'Szürke 8', 8),
  grayRamp('gray16', 'Szürke 16', 16),
  paletteFromHex('sepia4', 'Szépia 4', 'Monokróm', ['#2B1B0E', '#6B4A2B', '#B08D57', '#F0E2C8']),

  // --- Vintage hardware ---------------------------------------------------
  paletteFromHex('gb-dmg', 'Game Boy (DMG)', 'Retró', [
    '#0F380F', '#306230', '#8BAC0F', '#9BBC0F',
  ]),
  paletteFromHex('gb-pocket', 'Game Boy Pocket', 'Retró', [
    '#000000', '#545454', '#A9A9A9', '#FFFFFF',
  ]),
  paletteFromHex('cga-p0', 'CGA 4. mód, 0. paletta', 'Retró', [
    '#000000', '#55FF55', '#FF5555', '#FFFF55',
  ]),
  paletteFromHex('cga-p1', 'CGA 4. mód, 1. paletta', 'Retró', [
    '#000000', '#55FFFF', '#FF55FF', '#FFFFFF',
  ]),
  paletteFromHex('cga16', 'CGA / EGA 16', 'Retró', [
    '#000000', '#0000AA', '#00AA00', '#00AAAA', '#AA0000', '#AA00AA', '#AA5500', '#AAAAAA',
    '#555555', '#5555FF', '#55FF55', '#55FFFF', '#FF5555', '#FF55FF', '#FFFF55', '#FFFFFF',
  ]),
  cube('ega64', 'EGA 64 (2 bit/csatorna)', 'Retró', [0, 85 / 255, 170 / 255, 1]),
  paletteFromHex('c64', 'Commodore 64', 'Retró', [
    '#000000', '#FFFFFF', '#880000', '#AAFFEE', '#CC44CC', '#00CC55', '#0000AA', '#EEEE77',
    '#DD8855', '#664400', '#FF7777', '#333333', '#777777', '#AAFF66', '#0088FF', '#BBBBBB',
  ]),
  paletteFromHex('zx-spectrum', 'ZX Spectrum', 'Retró', [
    '#000000', '#0000D7', '#D70000', '#D700D7', '#00D700', '#00D7D7', '#D7D700', '#D7D7D7',
    '#0000FF', '#FF0000', '#FF00FF', '#00FF00', '#00FFFF', '#FFFF00', '#FFFFFF',
  ]),
  paletteFromHex('teletext', 'Teletext', 'Retró', [
    '#000000', '#FF0000', '#00FF00', '#FFFF00', '#0000FF', '#FF00FF', '#00FFFF', '#FFFFFF',
  ]),
  paletteFromHex('pico8', 'PICO-8', 'Retró', [
    '#000000', '#1D2B53', '#7E2553', '#008751', '#AB5236', '#5F574F', '#C2C3C7', '#FFF1E8',
    '#FF004D', '#FFA300', '#FFEC27', '#00E436', '#29ADFF', '#83769C', '#FF77A8', '#FFCCAA',
  ]),
  paletteFromHex('sweetie16', 'Sweetie 16', 'Retró', [
    '#1A1C2C', '#5D275D', '#B13E53', '#EF7D57', '#FFCD75', '#A7F070', '#38B764', '#257179',
    '#29366F', '#3B5DC9', '#41A6F6', '#73EFF7', '#F4F4F4', '#94B0C2', '#566C86', '#333C57',
  ]),

  // --- System / generated -------------------------------------------------
  cube('websafe', 'Web-safe 216', 'Rendszer', [0, 0.2, 0.4, 0.6, 0.8, 1]),
  ramp332(),

  // --- Print --------------------------------------------------------------
  paletteFromHex('cmyk-process', 'CMYK nyomdafestékek', 'Nyomda', [
    '#FFFFFF', '#00AEEF', '#EC008C', '#FFF200', '#000000',
  ]),
  paletteFromHex('riso-full', 'Risograph tinták (közelítés)', 'Nyomda', [
    '#FFFFFF', '#FF48B0', '#0078BF', '#00A95C', '#FFE800', '#FF665E', '#FF6C2F', '#765BA7',
    '#00838A', '#000000',
  ]),
  paletteFromHex('riso-pink-blue', 'Riso: rózsaszín + kék', 'Nyomda', [
    '#FFFFFF', '#FF48B0', '#0078BF', '#5C3B8E',
  ]),
  paletteFromHex('riso-fluo-black', 'Riso: fluo rózsaszín + fekete', 'Nyomda', [
    '#F5F2EA', '#FF48B0', '#000000',
  ]),
  paletteFromHex('duotone-cm', 'Duotone: ciánkék / bíbor', 'Nyomda', [
    '#0B1026', '#00AEEF', '#EC008C', '#FFF2FB',
  ]),
  paletteFromHex('spot-warm', 'Spot: meleg nyomdaszettek', 'Nyomda', [
    '#F4EFE6', '#E8552D', '#F2B441', '#2E4756', '#1A1A1A',
  ]),

  // --- Editorial / abstract ----------------------------------------------
  paletteFromHex('solarized', 'Solarized', 'Absztrakt', [
    '#002B36', '#073642', '#586E75', '#657B83', '#839496', '#93A1A1', '#EEE8D5', '#FDF6E3',
    '#B58900', '#CB4B16', '#DC322F', '#D33682', '#6C71C4', '#268BD2', '#2AA198', '#859900',
  ]),
  paletteFromHex('plasma', 'Plazma', 'Absztrakt', [
    '#19191C', '#32CD32', '#FF4500', '#9400D3', '#0080FF', '#FFD700', '#FF00FF', '#FFFFFF',
  ]),
  paletteFromHex('vapor', 'Vapor', 'Absztrakt', [
    '#0D0221', '#261447', '#FF2A6D', '#D1F7FF', '#05D9E8', '#7A04EB',
  ]),
  paletteFromHex('thermal', 'Hőkamera', 'Absztrakt', [
    '#000018', '#3B0F70', '#8C2981', '#DE4968', '#FE9F6D', '#FCFDBF',
  ]),
  paletteFromHex('acid', 'Sav', 'Absztrakt', [
    '#0A0A0A', '#00FF66', '#CCFF00', '#FF00AA', '#00E5FF', '#FFFFFF',
  ]),
  paletteFromHex('dune', 'Dűne', 'Absztrakt', [
    '#2B1A12', '#7A4B29', '#C08552', '#E8C39E', '#F6EBDD',
  ]),
];

export function findBuiltinPalette(id: string): Palette | null {
  return BUILTIN_PALETTES.find((p) => p.id === id) ?? null;
}

export function paletteCategories(): string[] {
  const set = new Set<string>();
  for (const p of BUILTIN_PALETTES) set.add(p.category);
  return [...set];
}
