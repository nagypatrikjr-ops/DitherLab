import { registerAllProcessors } from '../src/core';
import { defaultParams, requireProcessor } from '../src/core/dither/registry';
import { createBuffer } from '../src/core/buffer';
import { findBuiltinPalette } from '../src/core/palette/builtin';
import { renderPipeline } from '../src/core/pipeline';
import { srgbToLinear, linearToSrgb } from '../src/core/color/space';
import type { EffectLayer, RenderContext } from '../src/core/types';

registerAllProcessors();

function flat(v: number, n = 256) {
  const b = createBuffer(n, n);
  for (let i = 0; i < b.data.length; i += 4) {
    b.data[i] = v; b.data[i + 1] = v; b.data[i + 2] = v; b.data[i + 3] = 1;
  }
  return b;
}

function run(id: string, gamma: boolean, input: number, extra: Record<string, unknown> = {}) {
  const proc = requireProcessor(id);
  const layer: EffectLayer = {
    id: 'x', type: id, enabled: true, opacity: 1, blendMode: 'normal',
    params: { ...defaultParams(proc.params), colorMode: 'mono', gammaCorrect: gamma, ...extra } as EffectLayer['params'],
  };
  const ctx: RenderContext = {
    palette: findBuiltinPalette('bw1'), distance: 'rgb', gammaCorrect: true,
    seed: 3, frame: 0, noiseMode: 'static', cycleLength: 12, resolutionDivisor: 1,
  };
  const { buffer } = renderPipeline(flat(input), 's', [layer], ctx);
  let white = 0;
  const n = buffer.width * buffer.height;
  for (let i = 0; i < buffer.data.length; i += 4) if (buffer.data[i] > 0.5) white++;
  return white / n;
}

const inputs = [0.25, 0.5, 0.75];
const algos = ['ed:floyd-steinberg', 'ord:bayer8', 'ord:blue-noise', 'mod:threshold'];

console.log('\n  Mekkora fehér-arányt ad egy egyenletes sRGB szürke felület?\n');
console.log('  ' + 'algoritmus'.padEnd(22) + 'sRGB be'.padStart(9)
  + 'lin.helyes'.padStart(12) + 'gamma BE'.padStart(11) + 'gamma KI'.padStart(11)
  + 'megjelenő sRGB (BE / KI)'.padStart(28));
console.log('  ' + '-'.repeat(93));
for (const id of algos) {
  for (const v of inputs) {
    const ideal = srgbToLinear(v);
    const on = run(id, true, v);
    const off = run(id, false, v);
    const seenOn = linearToSrgb(on);
    const seenOff = linearToSrgb(off);
    console.log('  ' + id.padEnd(22)
      + v.toFixed(2).padStart(9)
      + ideal.toFixed(3).padStart(12)
      + on.toFixed(3).padStart(11)
      + off.toFixed(3).padStart(11)
      + `${seenOn.toFixed(3)} / ${seenOff.toFixed(3)}`.padStart(28));
  }
  console.log();
}
