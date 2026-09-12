import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerAllProcessors } from '../../src/core';
import { allProcessors, defaultParams } from '../../src/core/dither/registry';
import { bufferToRgba } from '../../src/core/buffer';
import { findBuiltinPalette } from '../../src/core/palette/builtin';
import { renderPipeline } from '../../src/core/pipeline';
import type { EffectLayer, RenderContext } from '../../src/core/types';
import { referenceImage } from './reference';

const here = dirname(fileURLToPath(import.meta.url));
const snapshotPath = join(here, 'snapshots.json');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

/** FNV-1a over the rendered bytes: small, stable, order sensitive. */
function hashBytes(bytes: Uint8ClampedArray): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** A few coarse statistics, so a failure says *how* the output changed. */
function stats(bytes: Uint8ClampedArray): { mean: number; tones: number } {
  let sum = 0;
  const seen = new Set<number>();
  for (let i = 0; i < bytes.length; i += 4) {
    sum += bytes[i];
    if (seen.size < 64) seen.add((bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]);
  }
  return {
    mean: Math.round((sum / (bytes.length / 4)) * 100) / 100,
    tones: seen.size,
  };
}

interface Snapshot {
  hash: string;
  mean: number;
  tones: number;
}

beforeAll(() => {
  registerAllProcessors();
});

describe('golden images', () => {
  it('every processor matches its stored snapshot', () => {
    const source = referenceImage(96, 64);
    const palette = findBuiltinPalette('c64');
    const ctx: RenderContext = {
      palette,
      distance: 'weightedRgb',
      gammaCorrect: true,
      seed: 20240101,
      frame: 0,
      noiseMode: 'static',
      cycleLength: 12,
      resolutionDivisor: 1,
    };

    const current: Record<string, Snapshot> = {};
    for (const proc of allProcessors()) {
      const layer: EffectLayer = {
        id: `golden-${proc.id}`,
        type: proc.id,
        enabled: true,
        opacity: 1,
        blendMode: 'normal',
        params: defaultParams(proc.params),
      };
      const { buffer } = renderPipeline(source, 'golden-reference', [layer], ctx);
      const bytes = bufferToRgba(buffer);
      const s = stats(bytes);
      current[proc.id] = { hash: hashBytes(bytes), mean: s.mean, tones: s.tones };
    }

    if (UPDATE || !existsSync(snapshotPath)) {
      mkdirSync(dirname(snapshotPath), { recursive: true });
      writeFileSync(snapshotPath, `${JSON.stringify(current, null, 2)}\n`);
      expect(Object.keys(current).length).toBeGreaterThan(40);
      return;
    }

    const stored = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Record<string, Snapshot>;
    const missing = Object.keys(current).filter((id) => !(id in stored));
    const removed = Object.keys(stored).filter((id) => !(id in current));
    const changed = Object.keys(current)
      .filter((id) => id in stored && stored[id].hash !== current[id].hash)
      .map((id) => ({
        id,
        stored: stored[id],
        got: current[id],
      }));

    if (changed.length > 0) {
      const detail = changed
        .slice(0, 8)
        .map(
          (c) =>
            `${c.id}: hash ${c.stored.hash} -> ${c.got.hash}, ` +
            `átlag ${c.stored.mean} -> ${c.got.mean}, tónusok ${c.stored.tones} -> ${c.got.tones}`,
        )
        .join('\n');
      throw new Error(
        `${changed.length} algoritmus kimenete megváltozott.\n${detail}\n` +
          'Ha szándékos: UPDATE_GOLDEN=1 npx vitest run tests/golden',
      );
    }

    expect(removed, 'eltűnt algoritmusok').toEqual([]);
    // A new algorithm is not a regression, but it must be recorded.
    if (missing.length > 0) {
      writeFileSync(snapshotPath, `${JSON.stringify({ ...stored, ...current }, null, 2)}\n`);
    }
  });

  it('the reference image itself is stable', () => {
    const a = bufferToRgba(referenceImage(96, 64));
    const b = bufferToRgba(referenceImage(96, 64));
    expect(hashBytes(a)).toBe(hashBytes(b));
    expect(hashBytes(a)).toBe(hashBytes(bufferToRgba(referenceImage(96, 64))));
  });
});
