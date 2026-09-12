import type { DitherDocument } from '../state/store';
import type { Palette } from '../core/types';
import { coerceParams, getProcessor } from '../core/dither/registry';

const PRESET_VERSION = 1;

interface SerialisedPalette {
  id: string;
  name: string;
  category: string;
  colors: number[];
}

interface PresetFile {
  format: 'ditherlab-preset';
  version: number;
  name: string;
  document: Omit<DitherDocument, 'customPalettes'> & { customPalettes: SerialisedPalette[] };
}

export function serializePreset(doc: DitherDocument, name = 'Előbeállítás'): string {
  const file: PresetFile = {
    format: 'ditherlab-preset',
    version: PRESET_VERSION,
    name,
    document: {
      ...doc,
      customPalettes: doc.customPalettes.map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        colors: Array.from(p.colors, (v) => Math.round(v * 10000) / 10000),
      })),
    },
  };
  return JSON.stringify(file, null, 2);
}

/**
 * Parse a preset. Unknown layer types and stale parameters are dropped rather
 * than throwing, so a preset written by an older build still loads.
 */
export function parsePreset(text: string): { doc: DitherDocument; name: string; warnings: string[] } {
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== 'object' || parsed === null ||
    (parsed as { format?: string }).format !== 'ditherlab-preset'
  ) {
    throw new Error('Ez nem DitherLab előbeállítás-fájl.');
  }
  const file = parsed as PresetFile;
  const warnings: string[] = [];

  const customPalettes: Palette[] = (file.document.customPalettes ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category,
    colors: new Float32Array(p.colors),
  }));

  const layers = (file.document.layers ?? []).flatMap((layer) => {
    const proc = getProcessor(layer.type);
    if (proc === null) {
      warnings.push(`Ismeretlen réteg kihagyva: ${layer.type}`);
      return [];
    }
    return [{ ...layer, params: coerceParams(proc.params, layer.params) }];
  });

  return {
    name: file.name ?? 'Előbeállítás',
    warnings,
    doc: {
      layers,
      paletteId: file.document.paletteId ?? 'bw1',
      customPalettes,
      distance: file.document.distance ?? 'weightedRgb',
      gammaCorrect: file.document.gammaCorrect ?? true,
      seed: file.document.seed ?? 1,
      noiseMode: file.document.noiseMode ?? 'static',
      cycleLength: file.document.cycleLength ?? 12,
    },
  };
}

/** Compact, URL-safe encoding for sharing a preset as a link fragment. */
export function presetToFragment(doc: DitherDocument, name: string): string {
  const json = serializePreset(doc, name);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function presetFromFragment(fragment: string): { doc: DitherDocument; name: string; warnings: string[] } {
  const b64 = fragment.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return parsePreset(new TextDecoder().decode(bytes));
}
