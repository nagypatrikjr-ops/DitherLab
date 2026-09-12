/**
 * Pure viewport math shared by the image viewers: screen = pan + zoom · image.
 * Kept free of the DOM so it can be tested directly.
 */

export interface Viewport {
  readonly zoom: number;
  readonly panX: number;
  readonly panY: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Breathing room around a fitted image, in screen pixels. */
export const FIT_MARGIN = 24;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function fitViewport(content: Size, view: Size, maxZoom = 8): Viewport {
  const zx = (view.width - 2 * FIT_MARGIN) / Math.max(1, content.width);
  const zy = (view.height - 2 * FIT_MARGIN) / Math.max(1, content.height);
  const zoom = clamp(Math.min(zx, zy), 1e-4, maxZoom);
  return {
    zoom,
    panX: (view.width - content.width * zoom) / 2,
    panY: (view.height - content.height * zoom) / 2,
  };
}

/** Zoom by `factor`, keeping the image point under (cx, cy) where it is. */
export function zoomAround(v: Viewport, factor: number, cx: number, cy: number, min: number, max: number): Viewport {
  const zoom = clamp(v.zoom * factor, min, max);
  const k = zoom / v.zoom;
  return { zoom, panX: cx - (cx - v.panX) * k, panY: cy - (cy - v.panY) * k };
}

/** Put image point (x, y) in the middle of the view. */
export function centerOn(x: number, y: number, zoom: number, view: Size): Viewport {
  return { zoom, panX: view.width / 2 - x * zoom, panY: view.height / 2 - y * zoom };
}

/** Keep at least `keep` screen pixels of the image on screen, so it can never be lost. */
export function clampPan(v: Viewport, content: Size, view: Size, keep = 60): Viewport {
  const w = content.width * v.zoom;
  const h = content.height * v.zoom;
  const k = Math.min(keep, w / 2, h / 2);
  return {
    zoom: v.zoom,
    panX: clamp(v.panX, k - w, view.width - k),
    panY: clamp(v.panY, k - h, view.height - k),
  };
}

/** The part of the image currently on screen, in image coordinates. */
export function visibleRect(v: Viewport, content: Size, view: Size): Rect {
  const x0 = clamp(-v.panX / v.zoom, 0, content.width);
  const y0 = clamp(-v.panY / v.zoom, 0, content.height);
  const x1 = clamp((view.width - v.panX) / v.zoom, 0, content.width);
  const y1 = clamp((view.height - v.panY) / v.zoom, 0, content.height);
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

/**
 * Whole-pixel crop covering `visible` plus `margin` on every side, inside the
 * image, and no larger than `maxArea` (shrunk around its centre if needed).
 */
export function cropFor(visible: Rect, content: Size, margin: number, maxArea: number): Rect | null {
  if (visible.width <= 0 || visible.height <= 0) return null;
  let x0 = visible.x - margin;
  let y0 = visible.y - margin;
  let w = visible.width + 2 * margin;
  let h = visible.height + 2 * margin;
  if (w * h > maxArea) {
    const k = Math.sqrt(maxArea / (w * h));
    const cx = x0 + w / 2;
    const cy = y0 + h / 2;
    w *= k;
    h *= k;
    x0 = cx - w / 2;
    y0 = cy - h / 2;
  }
  let x = Math.max(0, Math.floor(x0));
  let y = Math.max(0, Math.floor(y0));
  let width = Math.min(content.width, Math.ceil(x0 + w)) - x;
  let height = Math.min(content.height, Math.ceil(y0 + h)) - y;
  // Rounding outwards to whole pixels must not push the crop over the cap.
  const over = (width * height) / maxArea;
  if (over > 1) {
    const k = Math.sqrt(1 / over);
    const nw = Math.max(1, Math.floor(width * k));
    const nh = Math.max(1, Math.floor(height * k));
    x += Math.floor((width - nw) / 2);
    y += Math.floor((height - nh) / 2);
    width = nw;
    height = nh;
  }
  if (width < 1 || height < 1) return null;
  return { x, y, width, height };
}

export function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

export type WheelMode = 'zoom' | 'pan';

export type WheelAction = { readonly kind: 'zoom'; readonly factor: number } | { readonly kind: 'pan'; readonly dx: number; readonly dy: number };

export interface WheelInput {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaMode: number;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

/**
 * What a wheel event should do. A trackpad pinch arrives as Ctrl+wheel and
 * always zooms, as does Ctrl/⌘ + wheel. Otherwise the user's setting decides;
 * in zoom mode a sideways swipe (or Shift + wheel) still moves the image.
 */
export function wheelAction(e: WheelInput, mode: WheelMode): WheelAction {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  const dx = e.deltaX * unit;
  const dy = e.deltaY * unit;
  if (e.ctrlKey || e.metaKey) {
    // Pinch gestures send small deltas; a Ctrl + mouse wheel notch is ~100.
    const rate = Math.abs(dy) < 50 ? 0.01 : 0.0015;
    return { kind: 'zoom', factor: Math.exp(-dy * rate) };
  }
  const sideways = e.shiftKey && dx === 0 ? { dx: -dy, dy: 0 } : null;
  if (mode === 'pan') return sideways ? { kind: 'pan', ...sideways } : { kind: 'pan', dx: -dx, dy: -dy };
  if (sideways) return { kind: 'pan', ...sideways };
  if (Math.abs(dx) > Math.abs(dy)) return { kind: 'pan', dx: -dx, dy: 0 };
  return { kind: 'zoom', factor: Math.exp(-dy * 0.0015) };
}
