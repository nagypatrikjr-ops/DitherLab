import { describe, expect, it } from 'vitest';
import {
  clampPan,
  cropFor,
  centerOn,
  fitViewport,
  rectContains,
  visibleRect,
  wheelAction,
  zoomAround,
} from '../../src/ui/viewport';

const VIEW = { width: 800, height: 600 };
const PRINT = { width: 3307, height: 2205 };

describe('viewport', () => {
  it('fits the whole image with a margin and centres it', () => {
    const v = fitViewport(PRINT, VIEW);
    expect(PRINT.width * v.zoom).toBeLessThanOrEqual(VIEW.width - 40);
    expect(PRINT.height * v.zoom).toBeLessThanOrEqual(VIEW.height - 40);
    expect(v.panX + (PRINT.width * v.zoom) / 2).toBeCloseTo(VIEW.width / 2, 6);
    expect(v.panY + (PRINT.height * v.zoom) / 2).toBeCloseTo(VIEW.height / 2, 6);
    // Small images are not blown up past the limit.
    expect(fitViewport({ width: 10, height: 10 }, VIEW, 8).zoom).toBe(8);
  });

  it('keeps the point under the cursor fixed while zooming', () => {
    const v = fitViewport(PRINT, VIEW);
    const cx = 512;
    const cy = 301;
    const before = { x: (cx - v.panX) / v.zoom, y: (cy - v.panY) / v.zoom };
    const z = zoomAround(v, 3.7, cx, cy, 0.01, 16);
    const after = { x: (cx - z.panX) / z.zoom, y: (cy - z.panY) / z.zoom };
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(z.zoom).toBeCloseTo(v.zoom * 3.7, 6);
  });

  it('respects the zoom limits', () => {
    const v = { zoom: 1, panX: 0, panY: 0 };
    expect(zoomAround(v, 100, 0, 0, 0.1, 16).zoom).toBe(16);
    expect(zoomAround(v, 0.0001, 0, 0, 0.1, 16).zoom).toBe(0.1);
  });

  it('centres on a point of the image', () => {
    const v = centerOn(1000, 500, 2, VIEW);
    expect(v.panX + 1000 * 2).toBeCloseTo(VIEW.width / 2, 6);
    expect(v.panY + 500 * 2).toBeCloseTo(VIEW.height / 2, 6);
  });

  it('never lets the image be dragged off screen', () => {
    const far = clampPan({ zoom: 1, panX: 100000, panY: -100000 }, PRINT, VIEW, 60);
    expect(far.panX).toBeLessThanOrEqual(VIEW.width - 60);
    expect(far.panY + PRINT.height).toBeGreaterThanOrEqual(60);
  });

  it('reports the visible part in image coordinates', () => {
    const v = { zoom: 2, panX: -200, panY: -100 };
    const r = visibleRect(v, PRINT, VIEW);
    expect(r.x).toBeCloseTo(100, 6);
    expect(r.y).toBeCloseTo(50, 6);
    expect(r.width).toBeCloseTo(400, 6);
    expect(r.height).toBeCloseTo(300, 6);
    // Fitted: everything is visible, and nothing outside the image is reported.
    const all = visibleRect(fitViewport(PRINT, VIEW), PRINT, VIEW);
    expect(all).toEqual({ x: 0, y: 0, width: PRINT.width, height: PRINT.height });
  });

  it('builds whole-pixel crops with a margin, inside the image and within the area cap', () => {
    const crop = cropFor({ x: 500.4, y: 400.6, width: 300, height: 200 }, PRINT, 96, 4_000_000);
    expect(crop).not.toBeNull();
    if (crop === null) return;
    expect(Number.isInteger(crop.x) && Number.isInteger(crop.width)).toBe(true);
    expect(rectContains(crop, { x: 500.4, y: 400.6, width: 300, height: 200 })).toBe(true);
    expect(crop.x).toBeLessThan(500);

    // The whole image with a generous cap: clamped to the image, nothing cut off.
    const whole = cropFor({ x: 0, y: 0, width: PRINT.width, height: PRINT.height }, PRINT, 96, 50_000_000);
    expect(whole).toEqual({ x: 0, y: 0, width: PRINT.width, height: PRINT.height });

    // Too much to render at once: shrunk around the middle of what is visible.
    const capped = cropFor({ x: 0, y: 0, width: PRINT.width, height: PRINT.height }, PRINT, 96, 4_000_000);
    expect(capped).not.toBeNull();
    if (capped === null) return;
    expect(capped.width * capped.height).toBeLessThanOrEqual(4_000_000);
    expect(capped.x).toBeGreaterThanOrEqual(0);
    expect(capped.x + capped.width).toBeLessThanOrEqual(PRINT.width);
    expect(capped.y + capped.height).toBeLessThanOrEqual(PRINT.height);
    expect(capped.x + capped.width / 2).toBeCloseTo(PRINT.width / 2, 0);
    expect(capped.y + capped.height / 2).toBeCloseTo(PRINT.height / 2, 0);

    expect(cropFor({ x: 0, y: 0, width: 0, height: 10 }, PRINT, 0, 4_000_000)).toBeNull();
  });

  it('turns wheel events into zooming or moving', () => {
    const mouse = { deltaX: 0, deltaY: 100, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false };
    expect(wheelAction(mouse, 'zoom')).toEqual({ kind: 'zoom', factor: Math.exp(-0.15) });
    expect(wheelAction(mouse, 'pan')).toEqual({ kind: 'pan', dx: -0, dy: -100 });
    // A pinch (Ctrl + wheel with small deltas) always zooms, in either mode.
    const pinch = { ...mouse, deltaY: 4, ctrlKey: true };
    expect(wheelAction(pinch, 'pan')).toEqual({ kind: 'zoom', factor: Math.exp(-0.04) });
    // Sideways scrolling moves even in zoom mode.
    expect(wheelAction({ ...mouse, deltaX: 60, deltaY: 4 }, 'zoom')).toEqual({ kind: 'pan', dx: -60, dy: 0 });
    // Line-based wheels (Firefox) are converted to pixels.
    expect(wheelAction({ ...mouse, deltaY: 3, deltaMode: 1 }, 'pan')).toEqual({ kind: 'pan', dx: -0, dy: -48 });
  });
});
