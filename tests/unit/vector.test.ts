import { describe, expect, it } from 'vitest';
import { createBuffer } from '../../src/core/buffer';
import {
  DEFAULT_VECTOR_OPTIONS,
  ringArea,
  simplifyRing,
  toPdf,
  toSvg,
  traceRings,
  vectorize,
} from '../../src/core/vector';

function maskBuffer(width: number, height: number, cells: number[]) {
  const b = createBuffer(width, height);
  for (let i = 0; i < width * height; i++) {
    const v = cells[i] ? 0 : 1; // 1 = ink -> black
    b.data[i * 4] = v;
    b.data[i * 4 + 1] = v;
    b.data[i * 4 + 2] = v;
    b.data[i * 4 + 3] = 1;
  }
  return b;
}

describe('contour tracing', () => {
  it('traces a single pixel as a unit square', () => {
    const mask = new Uint8Array([0, 0, 0, 0, 1, 0, 0, 0, 0]);
    const rings = traceRings(mask, 3, 3);
    expect(rings.length).toBe(1);
    expect(Math.abs(ringArea(simplifyRing(rings[0], 0)))).toBeCloseTo(1, 6);
  });

  it('traces a 2x2 block as one ring of area 4', () => {
    const mask = new Uint8Array([
      0, 0, 0, 0,
      0, 1, 1, 0,
      0, 1, 1, 0,
      0, 0, 0, 0,
    ]);
    const rings = traceRings(mask, 4, 4);
    expect(rings.length).toBe(1);
    const simplified = simplifyRing(rings[0], 0);
    expect(Math.abs(ringArea(simplified))).toBeCloseTo(4, 6);
    // A square needs four corners plus the repeated closing point.
    expect(simplified.length).toBe(5);
  });

  it('emits an outer ring and a hole for a donut', () => {
    const mask = new Uint8Array([
      1, 1, 1,
      1, 0, 1,
      1, 1, 1,
    ]);
    const rings = traceRings(mask, 3, 3);
    expect(rings.length).toBe(2);
    const areas = rings.map((r) => ringArea(r)).sort((a, b) => Math.abs(b) - Math.abs(a));
    expect(Math.abs(areas[0])).toBeCloseTo(9, 6);
    expect(Math.abs(areas[1])).toBeCloseTo(1, 6);
    // The hole must wind the other way from the outer ring.
    expect(Math.sign(areas[0])).not.toBe(Math.sign(areas[1]));
  });

  it('keeps diagonally touching pixels as separate rings', () => {
    const mask = new Uint8Array([
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
    ]);
    const rings = traceRings(mask, 3, 3);
    expect(rings.length).toBe(3);
    for (const r of rings) expect(Math.abs(ringArea(r))).toBeCloseTo(1, 6);
  });

  it('total ink area equals the pixel count', () => {
    const cells = [
      1, 1, 0, 1,
      1, 0, 0, 1,
      0, 0, 1, 1,
      1, 1, 1, 0,
    ];
    const rings = traceRings(new Uint8Array(cells), 4, 4);
    const total = rings.reduce((a, r) => a + ringArea(r), 0);
    const inkPixels = cells.reduce((a: number, b) => a + b, 0);
    expect(Math.abs(total)).toBeCloseTo(inkPixels, 6);
  });
});

describe('simplification', () => {
  it('removes collinear points at tolerance 0', () => {
    const ring = [
      [0, 0], [1, 0], [2, 0], [3, 0], [3, 1], [3, 2], [0, 2], [0, 0],
    ] as const;
    const out = simplifyRing(ring.map((p) => [p[0], p[1]] as const) as never, 0);
    expect(out.length).toBe(5);
    expect(Math.abs(ringArea(out))).toBeCloseTo(6, 6);
  });

  it('drops detail as the tolerance grows', () => {
    const ring: [number, number][] = [];
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      ring.push([50 + Math.cos(a) * 20, 50 + Math.sin(a) * 20]);
    }
    ring.push(ring[0]);
    const tight = simplifyRing(ring, 0.05);
    const loose = simplifyRing(ring, 3);
    expect(loose.length).toBeLessThan(tight.length);
    expect(loose.length).toBeGreaterThanOrEqual(4);
  });
});

/**
 * Scanline fill of the traced rings with the even-odd rule — the same rule the
 * SVG and PDF output declare. Re-rasterising the vector must reproduce the mask
 * it came from; if it does not, the export is lying about the image.
 */
function rasterizeEvenOdd(rings: readonly (readonly (readonly [number, number])[])[], w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const scan = y + 0.5;
    const crossings: number[] = [];
    for (const ring of rings) {
      for (let i = 1; i < ring.length; i++) {
        const [x0, y0] = ring[i - 1];
        const [x1, y1] = ring[i];
        if (y0 === y1) continue;
        const lo = Math.min(y0, y1);
        const hi = Math.max(y0, y1);
        if (scan < lo || scan >= hi) continue;
        crossings.push(x0 + ((scan - y0) / (y1 - y0)) * (x1 - x0));
      }
    }
    crossings.sort((a, b) => a - b);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const from = Math.ceil(crossings[i] - 0.5);
      const to = Math.floor(crossings[i + 1] - 0.5);
      for (let x = Math.max(0, from); x <= Math.min(w - 1, to); x++) out[y * w + x] = 1;
    }
  }
  return out;
}

describe('vector round-trip', () => {
  const cases: { name: string; w: number; h: number; cells: number[] }[] = [
    {
      name: 'donut with a hole',
      w: 5, h: 5,
      cells: [
        0, 0, 0, 0, 0,
        0, 1, 1, 1, 0,
        0, 1, 0, 1, 0,
        0, 1, 1, 1, 0,
        0, 0, 0, 0, 0,
      ],
    },
    {
      name: 'diagonal chain',
      w: 6, h: 6,
      cells: [
        1, 0, 0, 0, 0, 1,
        0, 1, 0, 0, 1, 0,
        0, 0, 1, 1, 0, 0,
        0, 0, 1, 1, 0, 0,
        0, 1, 0, 0, 1, 0,
        1, 0, 0, 0, 0, 1,
      ],
    },
    {
      name: 'ink touching every edge',
      w: 4, h: 4,
      cells: [
        1, 1, 1, 1,
        1, 0, 0, 1,
        1, 0, 0, 1,
        1, 1, 1, 1,
      ],
    },
  ];

  for (const c of cases) {
    it(`re-rasterises to the original mask: ${c.name}`, () => {
      const buf = maskBuffer(c.w, c.h, c.cells);
      const result = vectorize(buf, { minPathArea: 0, simplifyTolerance: 0, mergeAdjacent: true });
      const back = rasterizeEvenOdd(result.rings, c.w, c.h);
      expect(Array.from(back)).toEqual(c.cells);
    });
  }

  it('re-rasterises a full dither field exactly', () => {
    // A pseudo-random field exercises every neighbour configuration.
    const w = 41;
    const h = 29;
    const cells: number[] = [];
    let seed = 12345;
    for (let i = 0; i < w * h; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      cells.push(seed % 100 < 42 ? 1 : 0);
    }
    const result = vectorize(maskBuffer(w, h, cells), {
      minPathArea: 0, simplifyTolerance: 0, mergeAdjacent: true,
    });
    const back = rasterizeEvenOdd(result.rings, w, h);
    let diff = 0;
    for (let i = 0; i < cells.length; i++) if (back[i] !== cells[i]) diff++;
    expect(diff, `${diff} pixel tér el ${result.rings.length} görbében`).toBe(0);
  });
});

describe('export formats', () => {
  const buf = maskBuffer(4, 4, [
    0, 0, 0, 0,
    0, 1, 1, 0,
    0, 1, 1, 0,
    0, 0, 0, 0,
  ]);

  it('produces a well-formed SVG with even-odd fill', () => {
    const result = vectorize(buf);
    const svg = toSvg(result);
    expect(svg.startsWith('<?xml')).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('viewBox="0 0 4 4"');
    expect(svg).toContain('fill-rule="evenodd"');
    expect(svg).toContain('<path');
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    // One path element only, however many rings there are.
    expect(svg.split('<path').length - 1).toBe(1);
  });

  it('honours strokeMode', () => {
    const svg = toSvg(vectorize(buf), { strokeMode: true, strokeWidth: 0.25 });
    expect(svg).toContain('fill="none"');
    expect(svg).toContain('stroke-width="0.25"');
  });

  it('filters small paths with minPathArea', () => {
    const speckled = maskBuffer(8, 8, Array.from({ length: 64 }, (_, i) => (i % 9 === 0 ? 1 : 0)));
    const all = vectorize(speckled, { minPathArea: 0 });
    const filtered = vectorize(speckled, { minPathArea: 2 });
    expect(all.rings.length).toBeGreaterThan(0);
    expect(filtered.rings.length).toBe(0);
  });

  it('mergeAdjacent changes the ring count', () => {
    const merged = vectorize(buf, { mergeAdjacent: true });
    const separate = vectorize(buf, { mergeAdjacent: false });
    expect(merged.rings.length).toBe(1);
    expect(separate.rings.length).toBe(4);
  });

  it('produces a PDF with a valid header, xref and trailer', () => {
    const pdf = toPdf(vectorize(buf), DEFAULT_VECTOR_OPTIONS);
    const text = new TextDecoder('latin1').decode(pdf);
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('/Type /Catalog');
    expect(text).toContain('/MediaBox [0 0 4 4]');
    expect(text).toContain('f*');
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);

    // The startxref offset must point at the xref keyword.
    const m = text.match(/startxref\n(\d+)\n%%EOF/);
    expect(m).not.toBeNull();
    const offset = Number(m![1]);
    expect(text.slice(offset, offset + 4)).toBe('xref');
  });

  it('scales the output coordinates', () => {
    const result = vectorize(buf, { scale: 10 });
    expect(result.width).toBe(40);
    const svg = toSvg(result, { scale: 10 });
    expect(svg).toContain('viewBox="0 0 40 40"');
  });
});
