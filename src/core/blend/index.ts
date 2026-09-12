import type { BlendMode, PixelBuffer } from '../types';
import { likeBuffer } from '../buffer';

/** Separable blend functions, all operating on 0..1 channel pairs. */
function blendChannel(mode: BlendMode, b: number, s: number): number {
  switch (mode) {
    case 'normal': return s;
    case 'multiply': return b * s;
    case 'screen': return b + s - b * s;
    case 'overlay': return b <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s);
    case 'darken': return Math.min(b, s);
    case 'lighten': return Math.max(b, s);
    case 'colorDodge': return s >= 1 ? 1 : Math.min(1, b / (1 - s));
    case 'colorBurn': return s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s);
    case 'hardLight': return s <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s);
    case 'softLight': {
      if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
      const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
      return b + (2 * s - 1) * (d - b);
    }
    case 'difference': return Math.abs(b - s);
    case 'exclusion': return b + s - 2 * b * s;
    case 'linearBurn': return Math.max(0, b + s - 1);
    case 'linearDodge': return Math.min(1, b + s);
    case 'vividLight':
      return s <= 0.5
        ? (s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / (2 * s)))
        : (s >= 1 ? 1 : Math.min(1, b / (2 * (1 - s))));
    case 'pinLight':
      return s <= 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1);
  }
}

export const BLEND_MODES: readonly { value: BlendMode; label: string }[] = [
  { value: 'normal', label: 'Normál' },
  { value: 'multiply', label: 'Szorzás' },
  { value: 'screen', label: 'Ernyő' },
  { value: 'overlay', label: 'Átfedés' },
  { value: 'darken', label: 'Sötétítés' },
  { value: 'lighten', label: 'Világosítás' },
  { value: 'colorDodge', label: 'Színfakítás' },
  { value: 'colorBurn', label: 'Színégetés' },
  { value: 'hardLight', label: 'Erős fény' },
  { value: 'softLight', label: 'Lágy fény' },
  { value: 'difference', label: 'Különbség' },
  { value: 'exclusion', label: 'Kizárás' },
  { value: 'linearBurn', label: 'Lineáris égetés' },
  { value: 'linearDodge', label: 'Lineáris fakítás' },
  { value: 'vividLight', label: 'Élénk fény' },
  { value: 'pinLight', label: 'Pontfény' },
];

/**
 * Composite `top` over `base` with a blend mode and opacity. Both buffers must
 * share geometry; the pipeline guarantees that.
 */
export function composite(
  base: PixelBuffer,
  top: PixelBuffer,
  mode: BlendMode,
  opacity: number,
): PixelBuffer {
  if (mode === 'normal' && opacity >= 1) return top;
  const out = likeBuffer(base);
  const bd = base.data;
  const td = top.data;
  const d = out.data;
  const a = Math.min(1, Math.max(0, opacity));

  for (let i = 0; i < d.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const blended = blendChannel(mode, bd[i + c], td[i + c]);
      d[i + c] = bd[i + c] + (blended - bd[i + c]) * a;
    }
    d[i + 3] = bd[i + 3] + (td[i + 3] - bd[i + 3]) * a;
  }
  return out;
}
