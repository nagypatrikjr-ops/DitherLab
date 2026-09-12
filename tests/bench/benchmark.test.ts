import { describe, expect, it, beforeAll } from 'vitest';
import { registerAllProcessors } from '../../src/core';
import { allProcessors, defaultParams } from '../../src/core/dither/registry';
import { createBuffer } from '../../src/core/buffer';
import { hashNoise2D } from '../../src/core/rng';
import { findBuiltinPalette } from '../../src/core/palette/builtin';
import { renderPipeline } from '../../src/core/pipeline';
import type { EffectLayer, PixelBuffer, RenderContext } from '../../src/core/types';

const WIDTH = Number(process.env.BENCH_WIDTH ?? 4000);
const HEIGHT = Number(process.env.BENCH_HEIGHT ?? 3000);
const BUDGET_MS = 3000;

function testImage(width: number, height: number): PixelBuffer {
  const buf = createBuffer(width, height);
  const d = buf.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const u = x / width;
      const v = y / height;
      d[i] = u * 0.8 + hashNoise2D(x, y, 1) * 0.2;
      d[i + 1] = v * 0.8 + hashNoise2D(x, y, 2) * 0.2;
      d[i + 2] = (1 - u) * 0.6 + v * 0.4;
      d[i + 3] = 1;
    }
  }
  return buf;
}

beforeAll(() => {
  registerAllProcessors();
});

describe(`benchmark ${WIDTH}x${HEIGHT}`, () => {
  it('reports per-algorithm timings and flags anything over 3 s', () => {
    const source = testImage(WIDTH, HEIGHT);
    const ctx: RenderContext = {
      palette: findBuiltinPalette('c64'),
      distance: 'weightedRgb',
      gammaCorrect: true,
      seed: 1,
      frame: 0,
      noiseMode: 'static',
      cycleLength: 12,
      resolutionDivisor: 1,
    };

    const rows: { id: string; name: string; ms: number }[] = [];
    for (const proc of allProcessors()) {
      const layer: EffectLayer = {
        id: `bench-${proc.id}`,
        type: proc.id,
        enabled: true,
        opacity: 1,
        blendMode: 'normal',
        params: defaultParams(proc.params),
      };
      const t0 = performance.now();
      renderPipeline(source, 'bench', [layer], ctx);
      rows.push({ id: proc.id, name: proc.name, ms: Math.round(performance.now() - t0) });
    }

    rows.sort((a, b) => b.ms - a.ms);
    const mp = ((WIDTH * HEIGHT) / 1e6).toFixed(1);
    const lines = [
      '',
      `  Benchmark — ${WIDTH}×${HEIGHT} (${mp} MP), alapértelmezett paraméterek`,
      `  ${'algoritmus'.padEnd(34)}${'ms'.padStart(8)}   ${'MP/s'.padStart(7)}`,
      `  ${'-'.repeat(34)}${'-'.repeat(8)}   ${'-'.repeat(7)}`,
    ];
    for (const r of rows) {
      const mps = r.ms > 0 ? ((WIDTH * HEIGHT) / 1e6 / (r.ms / 1000)).toFixed(1) : '∞';
      const flag = r.ms > BUDGET_MS ? '  ⚠ 3 s felett' : '';
      lines.push(`  ${r.id.padEnd(34)}${String(r.ms).padStart(8)}   ${mps.padStart(7)}${flag}`);
    }
    const slow = rows.filter((r) => r.ms > BUDGET_MS);
    lines.push('');
    lines.push(
      slow.length === 0
        ? `  Minden algoritmus a ${BUDGET_MS} ms-os kereten belül maradt.`
        : `  ${slow.length} algoritmus lépte túl a ${BUDGET_MS} ms-os keretet: ` +
          slow.map((s) => s.id).join(', '),
    );
    lines.push('');
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));

    expect(rows.length).toBeGreaterThan(40);
  }, 900_000);
});
