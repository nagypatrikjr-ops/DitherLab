import { allProcessors } from '../core/dither/registry';
import { BLEND_MODES } from '../core/blend';
import { BUILTIN_PALETTES } from '../core/palette/builtin';
import { FILM_WIDTHS, GARMENTS, LOOKS, PLACEMENTS, PRESS_SETTINGS } from '../core/transfer';

/**
 * Every user-visible string the core defines: algorithm names, parameter
 * labels, palette names and print presets. The core keeps its Hungarian
 * wording; the UI translates these by exact match (see core-en.ts), and a
 * test uses this list to make sure nothing is left untranslated.
 *
 * Call after registerAllProcessors().
 */
export function collectCoreStrings(): string[] {
  const out = new Set<string>();
  const add = (s: string | undefined): void => {
    if (s !== undefined && s.trim() !== '') out.add(s);
  };
  for (const p of allProcessors()) {
    add(p.name);
    for (const spec of Object.values(p.params)) {
      add(spec.label);
      add(spec.group);
      if (spec.kind === 'float' || spec.kind === 'int') add(spec.unit);
      if (spec.kind === 'enum') for (const o of spec.options) add(o.label);
    }
  }
  for (const m of BLEND_MODES) add(m.label);
  for (const p of BUILTIN_PALETTES) {
    add(p.name);
    add(p.category);
  }
  for (const g of GARMENTS) add(g.name);
  for (const pl of PLACEMENTS) {
    add(pl.name);
    add(pl.note);
  }
  for (const ps of PRESS_SETTINGS) {
    add(ps.fabric);
    add(ps.pressure);
    add(ps.peel);
    add(ps.finish);
  }
  for (const l of LOOKS) {
    add(l.name);
    add(l.note);
  }
  for (const f of FILM_WIDTHS) add(f.name);
  return [...out];
}
