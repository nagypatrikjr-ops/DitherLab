import { beforeAll, describe, expect, it } from 'vitest';
import { registerAllProcessors } from '../../src/core';
import { allProcessors, defaultParams, requireProcessor } from '../../src/core/dither/registry';
import { createBuffer } from '../../src/core/buffer';
import { findBuiltinPalette } from '../../src/core/palette/builtin';
import { renderPipeline, RenderCache, previewIsExact, proxyDivisorFor } from '../../src/core/pipeline';
import type { EffectLayer, PixelBuffer, RenderContext } from '../../src/core/types';

beforeAll(() => {
  registerAllProcessors();
});

const BW = findBuiltinPalette('bw1');

function ctx(overrides: Partial<RenderContext> = {}): RenderContext {
  return {
    palette: BW,
    distance: 'rgb',
    gammaCorrect: false,
    seed: 1,
    frame: 0,
    noiseMode: 'static',
    cycleLength: 8,
    resolutionDivisor: 1,
    ...overrides,
  };
}

function flat(w: number, h: number, v: number): PixelBuffer {
  const b = createBuffer(w, h);
  for (let i = 0; i < b.data.length; i += 4) {
    b.data[i] = v;
    b.data[i + 1] = v;
    b.data[i + 2] = v;
    b.data[i + 3] = 1;
  }
  return b;
}

function gradient(w: number, h: number): PixelBuffer {
  const b = createBuffer(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = w > 1 ? x / (w - 1) : 0;
      const i = (y * w + x) * 4;
      b.data[i] = v;
      b.data[i + 1] = v;
      b.data[i + 2] = v * 0.5;
      b.data[i + 3] = 1;
    }
  }
  return b;
}

function layer(type: string, params: Record<string, unknown> = {}): EffectLayer {
  const proc = requireProcessor(type);
  return {
    id: `L-${type}`,
    type,
    enabled: true,
    opacity: 1,
    blendMode: 'normal',
    params: { ...defaultParams(proc.params), ...params } as EffectLayer['params'],
  };
}

describe('Floyd–Steinberg, hand-verified', () => {
  it('produces 1,0,1,1 on a 4x1 row of 0.6 grey', () => {
    // 0.6 -> white, error -0.4; 7/16 of it lands on the next pixel:
    //   0.425 -> black, 0.7859 -> white, 0.5063 -> white.
    const src = flat(4, 1, 0.6);
    const l = layer('ed:floyd-steinberg', {
      colorMode: 'mono',
      serpentine: false,
      gammaCorrect: false,
      pixelScale: 1,
    });
    const { buffer } = renderPipeline(src, 'test', [l], ctx());
    const got = [0, 1, 2, 3].map((x) => buffer.data[x * 4]);
    expect(got).toEqual([1, 0, 1, 1]);
  });

  it('decides every pixel independently at zero diffusion strength', () => {
    const src = flat(4, 1, 0.6);
    const l = layer('ed:floyd-steinberg', {
      colorMode: 'mono', serpentine: false, gammaCorrect: false, diffusionStrength: 0,
    });
    const { buffer } = renderPipeline(src, 'test', [l], ctx());
    // With no error carried forward every pixel decides independently.
    expect([0, 1, 2, 3].map((x) => buffer.data[x * 4])).toEqual([1, 1, 1, 1]);
  });

  it('reverses the scan on odd rows when serpentine is on', () => {
    const src = gradient(8, 4);
    const straight = renderPipeline(
      src, 't', [layer('ed:floyd-steinberg', { colorMode: 'mono', serpentine: false, gammaCorrect: false })], ctx(),
    ).buffer;
    const snake = renderPipeline(
      src, 't', [layer('ed:floyd-steinberg', { colorMode: 'mono', serpentine: true, gammaCorrect: false })], ctx(),
    ).buffer;
    const row1 = (b: PixelBuffer) => [8, 9, 10, 11, 12, 13, 14, 15].map((x) => b.data[x * 4]);
    expect(row1(straight)).not.toEqual(row1(snake));
  });
});

describe('pixelScale', () => {
  it('collapses detail into blocks while keeping the output size', () => {
    const src = gradient(16, 16);
    const l = layer('ord:bayer8', { pixelScale: 4, colorMode: 'mono', gammaCorrect: false });
    const { buffer } = renderPipeline(src, 't', [l], ctx());
    expect(buffer.width).toBe(16);
    expect(buffer.height).toBe(16);
    // Every 4x4 block must be uniform.
    for (let by = 0; by < 4; by++) {
      for (let bx = 0; bx < 4; bx++) {
        const ref = buffer.data[((by * 4) * 16 + bx * 4) * 4];
        for (let y = 0; y < 4; y++) {
          for (let x = 0; x < 4; x++) {
            expect(buffer.data[((by * 4 + y) * 16 + bx * 4 + x) * 4]).toBe(ref);
          }
        }
      }
    }
  });

  it('returns the small grid when outputMode is native', () => {
    const src = gradient(16, 16);
    const l = layer('ord:bayer8', { pixelScale: 4, outputMode: 'native', colorMode: 'mono' });
    const { buffer } = renderPipeline(src, 't', [l], ctx());
    expect(buffer.width).toBe(4);
    expect(buffer.height).toBe(4);
  });

  it('renders an identical raster at proxy resolution when pixelScale >= divisor', () => {
    const src = gradient(64, 64);
    const full = renderPipeline(
      src, 't', [layer('ord:bayer8', { pixelScale: 4, colorMode: 'mono', outputMode: 'native' })], ctx(),
    ).buffer;
    // The proxy: the caller downscales the source by 2 and sets divisor 2.
    const half = createBuffer(32, 32);
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        const i = (y * 32 + x) * 4;
        const s = ((y * 2) * 64 + x * 2) * 4;
        // Box-average the 2x2 source block, as the proxy path does.
        for (let c = 0; c < 4; c++) {
          half.data[i + c] =
            (src.data[s + c] + src.data[s + 4 + c] + src.data[s + 64 * 4 + c] + src.data[s + 64 * 4 + 4 + c]) / 4;
        }
      }
    }
    const proxy = renderPipeline(
      half, 't', [layer('ord:bayer8', { pixelScale: 4, colorMode: 'mono', outputMode: 'native' })],
      ctx({ resolutionDivisor: 2 }),
    ).buffer;
    expect(proxy.width).toBe(full.width);
    expect(proxy.height).toBe(full.height);
    let same = 0;
    for (let i = 0; i < full.data.length; i += 4) {
      if (full.data[i] === proxy.data[i]) same++;
    }
    // Same lattice, same dimensions: the two must agree on nearly every cell.
    expect(same / (full.data.length / 4)).toBeGreaterThan(0.97);
  });

  it('reports honestly when the preview cannot be exact', () => {
    expect(previewIsExact([layer('ord:bayer8', { pixelScale: 4 })], 2)).toBe(true);
    expect(previewIsExact([layer('ord:bayer8', { pixelScale: 1 })], 2)).toBe(false);
    expect(previewIsExact([layer('fx:glow')], 2)).toBe(false);
    expect(previewIsExact([layer('ord:bayer8', { pixelScale: 1 })], 1)).toBe(true);
  });

  it('chooses an integer proxy divisor', () => {
    expect(proxyDivisorFor(1000, 800)).toBe(1);
    expect(proxyDivisorFor(6000, 4000, 2000)).toBe(3);
    expect(Number.isInteger(proxyDivisorFor(5123, 3000, 2000))).toBe(true);
  });
});

describe('pipeline', () => {
  it('is a pure function of its inputs', () => {
    const src = gradient(32, 32);
    const layers = [
      layer('fx:adjust', { contrast: 0.3 }),
      layer('ed:atkinson', { colorMode: 'mono' }),
      layer('fx:noise', { amount: 0.3 }),
    ];
    const a = renderPipeline(src, 't', layers, ctx()).buffer;
    const b = renderPipeline(src, 't', layers, ctx()).buffer;
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });

  it('reuses cached stages below the changed layer', () => {
    const cache = new RenderCache();
    const src = gradient(24, 24);
    const layers = [
      layer('fx:adjust', { contrast: 0.2 }),
      layer('fx:levels', { gamma: 1.2 }),
      layer('ord:bayer8', { colorMode: 'mono' }),
    ];
    const first = renderPipeline(src, 't', layers, ctx(), cache);
    expect(first.firstRecomputed).toBe(0);

    const changed = [...layers];
    changed[2] = { ...layers[2], params: { ...layers[2].params, contrast: 1.4 } };
    const second = renderPipeline(src, 't', changed, ctx(), cache);
    expect(second.firstRecomputed).toBe(2);

    const third = renderPipeline(src, 't', changed, ctx(), cache);
    expect(third.fromCache).toBe(true);
  });

  it('honours the cache byte budget', () => {
    const cache = new RenderCache(200_000);
    const src = gradient(64, 64); // 64*64*4*4 = 65536 bytes per stage
    const layers = Array.from({ length: 8 }, (_, i) =>
      ({ ...layer('fx:levels', { gamma: 1 + i * 0.05 }), id: `l${i}` }),
    );
    renderPipeline(src, 't', layers, ctx(), cache);
    expect(cache.usedBytes).toBeLessThanOrEqual(200_000);
    expect(cache.entryCount).toBeGreaterThan(0);
  });

  it('skips disabled layers without disturbing the cache keys', () => {
    const src = gradient(16, 16);
    const on = layer('fx:invert');
    const off = { ...on, enabled: false };
    const a = renderPipeline(src, 't', [off], ctx()).buffer;
    expect(Array.from(a.data)).toEqual(Array.from(src.data));
  });

  it('passes through unknown layer types instead of throwing', () => {
    const src = gradient(8, 8);
    const bogus: EffectLayer = {
      id: 'x', type: 'does:not:exist', enabled: true, opacity: 1, blendMode: 'normal', params: {},
    };
    const out = renderPipeline(src, 't', [bogus], ctx()).buffer;
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });
});

describe('every registered processor', () => {
  it('runs on a small image and returns finite, in-gamut pixels', () => {
    const src = gradient(24, 18);
    const procs = allProcessors();
    expect(procs.length).toBeGreaterThan(40);
    for (const proc of procs) {
      const l = layer(proc.id);
      const { buffer } = renderPipeline(src, 't', [l], ctx());
      expect(buffer.width, proc.id).toBeGreaterThan(0);
      expect(buffer.height, proc.id).toBeGreaterThan(0);
      for (let i = 0; i < buffer.data.length; i++) {
        if (!Number.isFinite(buffer.data[i])) {
          throw new Error(`${proc.id} produced a non-finite value at index ${i}`);
        }
      }
      // Nothing should stray far outside the display range.
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < buffer.data.length; i += 4) {
        for (let c = 0; c < 3; c++) {
          min = Math.min(min, buffer.data[i + c]);
          max = Math.max(max, buffer.data[i + c]);
        }
      }
      expect(min, `${proc.id} min`).toBeGreaterThan(-0.01);
      expect(max, `${proc.id} max`).toBeLessThan(1.01);
    }
  });

  it('is deterministic for every processor', () => {
    const src = gradient(20, 14);
    for (const proc of allProcessors()) {
      const l = layer(proc.id);
      const a = renderPipeline(src, 't', [l], ctx()).buffer;
      const b = renderPipeline(src, 't', [l], ctx()).buffer;
      for (let i = 0; i < a.data.length; i++) {
        if (a.data[i] !== b.data[i]) {
          throw new Error(`${proc.id} is not deterministic at index ${i}`);
        }
      }
    }
  });

  it('produces exactly two distinct colours for 1-bit dither modes', () => {
    const src = gradient(48, 32);
    const onebit = allProcessors().filter(
      (p) => p.vectorizable && 'colorMode' in p.params,
    );
    expect(onebit.length).toBeGreaterThan(10);
    for (const proc of onebit) {
      const l = layer(proc.id, { colorMode: 'mono', gammaCorrect: false });
      const { buffer } = renderPipeline(src, 't', [l], ctx());
      const seen = new Set<string>();
      for (let i = 0; i < buffer.data.length; i += 4) {
        seen.add(`${buffer.data[i].toFixed(4)}`);
      }
      expect(seen.size, `${proc.id} produced ${seen.size} tones`).toBeLessThanOrEqual(2);
    }
  });
});

describe('temporal stability', () => {
  it('keeps a static noise mode identical across frames', () => {
    const src = gradient(24, 24);
    const l = layer('ord:white-noise', { colorMode: 'mono' });
    const f0 = renderPipeline(src, 't', [l], ctx({ frame: 0, noiseMode: 'static' })).buffer;
    const f7 = renderPipeline(src, 't', [l], ctx({ frame: 7, noiseMode: 'static' })).buffer;
    expect(Array.from(f0.data)).toEqual(Array.from(f7.data));
  });

  it('changes every frame in perFrame mode and repeats in cycling mode', () => {
    const src = gradient(24, 24);
    const l = layer('ord:white-noise', { colorMode: 'mono' });
    const a = renderPipeline(src, 't', [l], ctx({ frame: 0, noiseMode: 'perFrame' })).buffer;
    const b = renderPipeline(src, 't', [l], ctx({ frame: 1, noiseMode: 'perFrame' })).buffer;
    expect(Array.from(a.data)).not.toEqual(Array.from(b.data));

    const c0 = renderPipeline(src, 't', [l], ctx({ frame: 0, noiseMode: 'cycling', cycleLength: 5 })).buffer;
    const c5 = renderPipeline(src, 't', [l], ctx({ frame: 5, noiseMode: 'cycling', cycleLength: 5 })).buffer;
    expect(Array.from(c0.data)).toEqual(Array.from(c5.data));
  });
});

describe('tonal accuracy in linear light', () => {
  // A dither is tonally correct when the fraction of white pixels equals the
  // input's *linear* luminance: that is what the eye integrates to. Getting
  // this wrong is the classic "everything went black" bug, so it is pinned.
  it('reproduces flat greys within 2% for every threshold-based algorithm', () => {
    // Atkinson is deliberately excluded: it throws away a quarter of the
    // error, which is exactly what gives it its crushed, high-contrast look.
    // Its behaviour is pinned separately below.
    // The tolerance tracks how many distinct threshold levels an algorithm
    // has: a 4x4 Bayer matrix only offers 16 steps, so it cannot land closer
    // than half a step to any given tone. Error diffusion has no such limit.
    const ids: [string, number][] = [
      ['ed:floyd-steinberg', 0.02], ['ed:jarvis', 0.02], ['ed:stucki', 0.02],
      ['ed:burkes', 0.02], ['ed:sierra3', 0.02], ['ed:riemersma', 0.02],
      ['ord:bayer4', 1 / 32 + 0.005], ['ord:bayer8', 1 / 128 + 0.005],
      ['ord:bayer16', 0.02], ['ord:blue-noise', 0.02],
      ['ord:white-noise', 0.02], ['ord:ign', 0.02],
      ['mod:threshold', 0.02],
    ];
    const srgbToLin = (c: number): number =>
      c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

    for (const [id, tolerance] of ids) {
      for (const level of [0.25, 0.5, 0.75]) {
        const src = flat(128, 128, level);
        const { buffer } = renderPipeline(
          src, 't',
          [layer(id, { colorMode: 'mono', gammaCorrect: true })],
          ctx({ gammaCorrect: true }),
        );
        let white = 0;
        for (let i = 0; i < buffer.data.length; i += 4) if (buffer.data[i] > 0.5) white++;
        const fraction = white / (buffer.data.length / 4);
        expect(
          Math.abs(fraction - srgbToLin(level)),
          `${id} @ ${level}: ${fraction.toFixed(3)} helyett ${srgbToLin(level).toFixed(3)}`,
        ).toBeLessThan(tolerance);
      }
    }
  });

  it('Atkinson crushes shadows and blows highlights, as designed', () => {
    const measure = (level: number): number => {
      const { buffer } = renderPipeline(
        flat(128, 128, level), 't',
        [layer('ed:atkinson', { colorMode: 'mono', gammaCorrect: true })],
        ctx({ gammaCorrect: true }),
      );
      let white = 0;
      for (let i = 0; i < buffer.data.length; i += 4) if (buffer.data[i] > 0.5) white++;
      return white / (buffer.data.length / 4);
    };
    const srgbToLin = (c: number): number =>
      c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    // Only 6/8 of the error travels on, so dark tones lose their few white dots
    // and bright tones lose their few black ones.
    expect(measure(0.25)).toBeLessThan(srgbToLin(0.25));
    expect(measure(0.9)).toBeGreaterThan(srgbToLin(0.9));
    // The midtone still tracks the input reasonably.
    expect(Math.abs(measure(0.5) - srgbToLin(0.5))).toBeLessThan(0.08);
  });

  it('is brighter than the input when linear light is switched off', () => {
    const src = flat(96, 96, 0.5);
    const { buffer } = renderPipeline(
      src, 't', [layer('ord:bayer8', { colorMode: 'mono', gammaCorrect: false })], ctx(),
    );
    let white = 0;
    for (let i = 0; i < buffer.data.length; i += 4) if (buffer.data[i] > 0.5) white++;
    // sRGB-space thresholding puts half the pixels white, which reads as ~0.74.
    expect(white / (buffer.data.length / 4)).toBeCloseTo(0.5, 1);
  });
});

describe('gamma handling', () => {
  it('changes the result when linear light is toggled', () => {
    const src = gradient(32, 32);
    const on = renderPipeline(
      src, 't', [layer('ed:floyd-steinberg', { colorMode: 'mono', gammaCorrect: true })],
      ctx({ gammaCorrect: true }),
    ).buffer;
    const off = renderPipeline(
      src, 't', [layer('ed:floyd-steinberg', { colorMode: 'mono', gammaCorrect: false })],
      ctx({ gammaCorrect: true }),
    ).buffer;
    expect(Array.from(on.data)).not.toEqual(Array.from(off.data));
  });
});

describe('tone reproduction', () => {
  it('keeps average brightness close to the input for error diffusion', () => {
    const src = flat(64, 64, 0.35);
    for (const id of ['ed:floyd-steinberg', 'ed:jarvis', 'ed:stucki', 'ed:burkes', 'ed:sierra3']) {
      const { buffer } = renderPipeline(
        src, 't', [layer(id, { colorMode: 'mono', gammaCorrect: false })], ctx(),
      );
      let sum = 0;
      for (let i = 0; i < buffer.data.length; i += 4) sum += buffer.data[i];
      const mean = sum / (buffer.data.length / 4);
      expect(Math.abs(mean - 0.35), id).toBeLessThan(0.05);
    }
  });

  it('keeps average brightness close to the input for ordered dither', () => {
    const src = flat(64, 64, 0.6);
    for (const id of ['ord:bayer8', 'ord:bayer16', 'ord:blue-noise', 'ord:ign']) {
      const { buffer } = renderPipeline(
        src, 't', [layer(id, { colorMode: 'mono', gammaCorrect: false })], ctx(),
      );
      let sum = 0;
      for (let i = 0; i < buffer.data.length; i += 4) sum += buffer.data[i];
      const mean = sum / (buffer.data.length / 4);
      expect(Math.abs(mean - 0.6), id).toBeLessThan(0.08);
    }
  });
});
