import type { Palette } from '../types';
import { hexToRgb, rgbToHex } from './builtin';

export type PaletteFormat = 'hex' | 'gpl' | 'ase' | 'pal' | 'unknown';

export function detectFormat(filename: string): PaletteFormat {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  if (ext === 'hex' || ext === 'txt') return 'hex';
  if (ext === 'gpl') return 'gpl';
  if (ext === 'ase') return 'ase';
  if (ext === 'pal') return 'pal';
  return 'unknown';
}

function makePalette(id: string, name: string, rgb: number[]): Palette {
  return { id, name, category: 'Importált', colors: new Float32Array(rgb) };
}

/** One "RRGGBB" (or "#RRGGBB") per line; blank lines and ; / # comments skipped. */
export function parseHexPalette(text: string, name = 'Importált .hex'): Palette {
  const out: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith(';') || line.startsWith('//')) continue;
    const m = line.match(/#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/);
    if (!m) continue;
    const [r, g, b] = hexToRgb(m[1]);
    out.push(r, g, b);
  }
  if (out.length === 0) throw new Error('A .hex fájlban nincs érvényes szín.');
  return makePalette(`hex:${name}`, name, out);
}

/** GIMP palette: "GIMP Palette" header, optional Name:/Columns:, then "R G B name". */
export function parseGpl(text: string, fallbackName = 'Importált .gpl'): Palette {
  const lines = text.split(/\r?\n/);
  let name = fallbackName;
  const out: number[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (/^GIMP Palette$/i.test(line)) continue;
    const nm = line.match(/^Name:\s*(.+)$/i);
    if (nm) {
      name = nm[1].trim();
      continue;
    }
    if (/^Columns:/i.test(line)) continue;
    const m = line.match(/^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})/);
    if (!m) continue;
    out.push(
      Math.min(255, Number(m[1])) / 255,
      Math.min(255, Number(m[2])) / 255,
      Math.min(255, Number(m[3])) / 255,
    );
  }
  if (out.length === 0) throw new Error('A .gpl fájlban nincs érvényes szín.');
  return makePalette(`gpl:${name}`, name, out);
}

/**
 * Microsoft RIFF .pal and JASC-PAL text .pal.
 */
export function parsePal(buffer: ArrayBuffer, name = 'Importált .pal'): Palette {
  const bytes = new Uint8Array(buffer);
  const head = String.fromCharCode(...bytes.subarray(0, 8));

  if (head.startsWith('JASC-PAL')) {
    const text = new TextDecoder('latin1').decode(bytes);
    const lines = text.split(/\r?\n/).slice(3);
    const out: number[] = [];
    for (const raw of lines) {
      const m = raw.trim().match(/^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})/);
      if (!m) continue;
      out.push(Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255);
    }
    if (out.length === 0) throw new Error('A JASC-PAL fájlban nincs érvényes szín.');
    return makePalette(`pal:${name}`, name, out);
  }

  if (head.startsWith('RIFF')) {
    const view = new DataView(buffer);
    // Locate the "data" chunk that follows the "PAL " form type.
    let offset = 12;
    while (offset + 8 <= view.byteLength) {
      const id = String.fromCharCode(
        bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3],
      );
      const size = view.getUint32(offset + 4, true);
      if (id === 'data') {
        const count = view.getUint16(offset + 10, true);
        const out: number[] = [];
        for (let i = 0; i < count; i++) {
          const p = offset + 12 + i * 4;
          if (p + 3 > view.byteLength) break;
          out.push(bytes[p] / 255, bytes[p + 1] / 255, bytes[p + 2] / 255);
        }
        if (out.length === 0) throw new Error('A RIFF PAL fájl üres.');
        return makePalette(`pal:${name}`, name, out);
      }
      offset += 8 + size + (size & 1);
    }
  }
  throw new Error('Ismeretlen .pal formátum.');
}

/**
 * Adobe Swatch Exchange (.ase).
 *
 * Layout: "ASEF", u16 major, u16 minor, u32 blockCount; then blocks of
 * u16 type / u32 length. Colour entries (type 0x0001) carry a UTF-16BE name,
 * a four character colour model and big-endian float components.
 */
export function parseAse(buffer: ArrayBuffer, name = 'Importált .ase'): Palette {
  const view = new DataView(buffer);
  const sig = String.fromCharCode(
    view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3),
  );
  if (sig !== 'ASEF') throw new Error('Nem ASE fájl (hiányzó ASEF aláírás).');

  const blocks = view.getUint32(8, false);
  const out: number[] = [];
  let offset = 12;

  for (let i = 0; i < blocks && offset + 6 <= view.byteLength; i++) {
    const type = view.getUint16(offset, false);
    const length = view.getUint32(offset + 2, false);
    const body = offset + 6;
    if (type === 0x0001) {
      const nameLen = view.getUint16(body, false);
      let p = body + 2 + nameLen * 2;
      const model = String.fromCharCode(
        view.getUint8(p), view.getUint8(p + 1), view.getUint8(p + 2), view.getUint8(p + 3),
      );
      p += 4;
      if (model === 'RGB ') {
        out.push(view.getFloat32(p, false), view.getFloat32(p + 4, false), view.getFloat32(p + 8, false));
      } else if (model === 'Gray') {
        const g = view.getFloat32(p, false);
        out.push(g, g, g);
      } else if (model === 'CMYK') {
        const c = view.getFloat32(p, false);
        const m = view.getFloat32(p + 4, false);
        const y = view.getFloat32(p + 8, false);
        const k = view.getFloat32(p + 12, false);
        out.push((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k));
      } else if (model === 'LAB ') {
        // ASE stores L in 0..1 and a/b in -128..127.
        const l = view.getFloat32(p, false) * 100;
        const a = view.getFloat32(p + 4, false);
        const b = view.getFloat32(p + 8, false);
        out.push(...labToSrgb(l, a, b));
      }
    }
    offset = body + length;
  }
  if (out.length === 0) throw new Error('Az ASE fájlban nincs kiolvasható szín.');
  return makePalette(`ase:${name}`, name, out);
}

function labToSrgb(l: number, a: number, b: number): [number, number, number] {
  const fy = (l + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const inv = (t: number): number => (t > 0.20689655172413793 ? t * t * t : (t - 16 / 116) / 7.787037037037035);
  const x = inv(fx) * 0.95047;
  const y = inv(fy);
  const z = inv(fz) * 1.08883;
  const lr = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const lg = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
  const lb = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
  const enc = (c: number): number => {
    const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(0, c), 1 / 2.4) - 0.055;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  };
  return [enc(lr), enc(lg), enc(lb)];
}

/** Accepts a Lospec palette page URL or a bare slug and returns the JSON URL. */
export function lospecJsonUrl(input: string): string | null {
  const slugMatch = input.trim().match(/lospec\.com\/palette-list\/([a-z0-9-]+)/i);
  const slug = slugMatch ? slugMatch[1] : /^[a-z0-9-]+$/i.test(input.trim()) ? input.trim() : null;
  return slug ? `https://lospec.com/palette-list/${slug}.json` : null;
}

interface LospecJson {
  name?: string;
  colors?: string[];
}

/** Fetch a public Lospec palette. Network-only; no user data is transmitted. */
export async function fetchLospecPalette(input: string): Promise<Palette> {
  const url = lospecJsonUrl(input);
  if (url === null) throw new Error('Nem ismerhető fel Lospec paletta-hivatkozás.');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Lospec válasz: ${res.status}`);
  const json = (await res.json()) as LospecJson;
  const colors = json.colors ?? [];
  if (colors.length === 0) throw new Error('A Lospec paletta üres.');
  const out: number[] = [];
  for (const c of colors) {
    const [r, g, b] = hexToRgb(c);
    out.push(r, g, b);
  }
  return makePalette(`lospec:${url}`, json.name ?? 'Lospec paletta', out);
}

// --- Export ---------------------------------------------------------------

export function paletteToHexText(p: Palette): string {
  const lines: string[] = [];
  for (let i = 0; i < p.colors.length; i += 3) {
    lines.push(rgbToHex(p.colors[i], p.colors[i + 1], p.colors[i + 2]).slice(1));
  }
  return lines.join('\n') + '\n';
}

export function paletteToGpl(p: Palette): string {
  const lines = ['GIMP Palette', `Name: ${p.name}`, 'Columns: 0', '#'];
  for (let i = 0; i < p.colors.length; i += 3) {
    const r = Math.round(p.colors[i] * 255);
    const g = Math.round(p.colors[i + 1] * 255);
    const b = Math.round(p.colors[i + 2] * 255);
    const hex = rgbToHex(p.colors[i], p.colors[i + 1], p.colors[i + 2]);
    lines.push(
      `${String(r).padStart(3)} ${String(g).padStart(3)} ${String(b).padStart(3)}\t${hex}`,
    );
  }
  return lines.join('\n') + '\n';
}
