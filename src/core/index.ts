import { registerErrorDiffusion } from './dither/errorDiffusion';
import { registerOrdered } from './dither/ordered';
import { registerHalftone } from './dither/halftone';
import { registerModulated } from './dither/modulated';
import { registerAdjustments } from './effects/adjustments';
import { registerBlur } from './effects/blur';
import { registerGlitch } from './effects/glitch';
import { registerStylize } from './effects/crt';
import { allProcessors } from './dither/registry';

let done = false;

/** Populate the processor registry. Safe to call more than once. */
export function registerAllProcessors(): void {
  if (done) return;
  done = true;
  registerErrorDiffusion();
  registerOrdered();
  registerHalftone();
  registerModulated();
  registerAdjustments();
  registerBlur();
  registerGlitch();
  registerStylize();
}

export function processorCount(): number {
  registerAllProcessors();
  return allProcessors().length;
}

export * from './types';
export * from './dither/registry';
export * from './pipeline';
export { BLEND_MODES, composite } from './blend';
export * from './buffer';
export { BUILTIN_PALETTES, findBuiltinPalette, paletteCategories, hexToRgb, rgbToHex, paletteFromHex } from './palette/builtin';
export { extractPalette } from './palette/extract';
export * from './palette/io';
