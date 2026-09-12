/**
 * Glyph rasterisation for the character dither.
 *
 * In a browser or worker an OffscreenCanvas rasterises any font and any
 * character set at the requested cell size. Where that API does not exist
 * (Node, during tests) a built-in 5x7 density ramp is used instead, so the
 * algorithm still produces a correct, deterministic result.
 */

export interface GlyphAtlas {
  readonly cellW: number;
  readonly cellH: number;
  readonly chars: string;
  /** Coverage 0..1 per pixel, `chars.length` cells laid out horizontally. */
  readonly coverage: Float32Array;
}

/** Built-in 5x7 bitmaps, ordered from lightest to heaviest. */
const FALLBACK_FONT: ReadonlyArray<readonly [string, readonly number[]]> = [
  [' ', [0, 0, 0, 0, 0, 0, 0]],
  ['.', [0, 0, 0, 0, 0, 0b00100, 0]],
  [':', [0, 0b00100, 0, 0, 0b00100, 0, 0]],
  ['-', [0, 0, 0, 0b01110, 0, 0, 0]],
  ['=', [0, 0, 0b01110, 0, 0b01110, 0, 0]],
  ['+', [0, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0]],
  ['o', [0, 0b01110, 0b10001, 0b10001, 0b10001, 0b01110, 0]],
  ['*', [0, 0b10101, 0b01110, 0b11111, 0b01110, 0b10101, 0]],
  ['#', [0, 0b01010, 0b11111, 0b01010, 0b11111, 0b01010, 0]],
  ['%', [0b11001, 0b11010, 0b00100, 0b00100, 0b01011, 0b10011, 0]],
  ['@', [0b01110, 0b10001, 0b10111, 0b10101, 0b10111, 0b10000, 0b01110]],
  ['█', [0b11111, 0b11111, 0b11111, 0b11111, 0b11111, 0b11111, 0b11111]],
];

function fallbackAtlas(requested: string): GlyphAtlas {
  const chars = requested.length > 0 ? requested : FALLBACK_FONT.map(([c]) => c).join('');
  const cellW = 5;
  const cellH = 7;
  const coverage = new Float32Array(chars.length * cellW * cellH);
  for (let ci = 0; ci < chars.length; ci++) {
    const ch = chars[ci];
    let entry = FALLBACK_FONT.find(([c]) => c === ch);
    if (!entry) {
      // Unknown character: pick the ramp step closest to its code point density.
      const idx = Math.min(
        FALLBACK_FONT.length - 1,
        Math.floor((ch.charCodeAt(0) % 12)),
      );
      entry = FALLBACK_FONT[idx];
    }
    const rows = entry[1];
    for (let y = 0; y < cellH; y++) {
      for (let x = 0; x < cellW; x++) {
        const on = (rows[y] >> (cellW - 1 - x)) & 1;
        coverage[(ci * cellH + y) * cellW + x] = on;
      }
    }
  }
  return { cellW, cellH, chars, coverage };
}

interface OffscreenCanvasLike {
  width: number;
  height: number;
  getContext(id: '2d'): OffscreenCanvasRenderingContext2D | null;
}

function hasOffscreenCanvas(): boolean {
  return typeof globalThis !== 'undefined' && 'OffscreenCanvas' in globalThis;
}

const atlasCache = new Map<string, GlyphAtlas>();

export function getGlyphAtlas(
  chars: string,
  cellW: number,
  cellH: number,
  fontFamily: string,
): GlyphAtlas {
  const key = `${chars}|${cellW}x${cellH}|${fontFamily}`;
  const hit = atlasCache.get(key);
  if (hit) return hit;

  let atlas: GlyphAtlas;
  if (!hasOffscreenCanvas() || chars.length === 0) {
    atlas = fallbackAtlas(chars);
  } else {
    const Ctor = (globalThis as unknown as {
      OffscreenCanvas: new (w: number, h: number) => OffscreenCanvasLike;
    }).OffscreenCanvas;
    const w = Math.max(2, Math.round(cellW));
    const h = Math.max(2, Math.round(cellH));
    const canvas = new Ctor(w * chars.length, h);
    const g = canvas.getContext('2d');
    if (g === null) {
      atlas = fallbackAtlas(chars);
    } else {
      g.fillStyle = '#000';
      g.fillRect(0, 0, w * chars.length, h);
      g.fillStyle = '#fff';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.font = `${Math.round(h * 0.92)}px ${fontFamily}`;
      for (let i = 0; i < chars.length; i++) {
        g.fillText(chars[i], i * w + w / 2, h / 2);
      }
      const img = g.getImageData(0, 0, w * chars.length, h);
      const coverage = new Float32Array(chars.length * w * h);
      for (let i = 0; i < chars.length; i++) {
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const s = (y * w * chars.length + i * w + x) * 4;
            coverage[(i * h + y) * w + x] = img.data[s] / 255;
          }
        }
      }
      atlas = { cellW: w, cellH: h, chars, coverage };
    }
  }

  if (atlasCache.size > 12) {
    const first = atlasCache.keys().next();
    if (!first.done) atlasCache.delete(first.value);
  }
  atlasCache.set(key, atlas);
  return atlas;
}

/** Mean ink of each glyph, used to order an arbitrary charset by density. */
export function glyphDensities(atlas: GlyphAtlas): Float32Array {
  const per = atlas.cellW * atlas.cellH;
  const out = new Float32Array(atlas.chars.length);
  for (let i = 0; i < atlas.chars.length; i++) {
    let sum = 0;
    for (let p = 0; p < per; p++) sum += atlas.coverage[i * per + p];
    out[i] = sum / per;
  }
  return out;
}
