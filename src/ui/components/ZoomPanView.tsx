import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useI18n } from '../../i18n';
import { usePrefs } from '../../state/prefs';
import {
  centerOn as centerView,
  clampPan,
  fitViewport,
  visibleRect,
  wheelAction,
  zoomAround,
  type Rect,
  type Size,
  type Viewport,
} from '../viewport';

/** A bitmap placed in content coordinates. */
export interface ViewLayer {
  readonly source: HTMLCanvasElement;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Smooth even when magnified (drawings such as the shirt mockup). */
  readonly smooth?: boolean;
}

export type Backdrop =
  | { readonly kind: 'checker' }
  | { readonly kind: 'color'; readonly color: string }
  | { readonly kind: 'plain' };

export interface ViewInfo {
  readonly zoom: number;
  readonly visible: Rect;
}

export interface ZoomPanHandle {
  fit(): void;
  actual(): void;
  zoomBy(factor: number): void;
  panBy(dx: number, dy: number): void;
  centerOn(x: number, y: number, zoom?: number): void;
}

interface Props {
  label: string;
  /** Size of what is shown, in content pixels (100% = one content pixel per screen pixel). */
  content: Size;
  layers: readonly ViewLayer[];
  backdrop: Backdrop;
  /** The view is fitted again whenever this changes, or the content size does. */
  fitKey: string;
  maxZoom?: number;
  /** Dashed outline around the content (useful on a plain colour). */
  outline?: boolean;
  badge?: string | null;
  onViewChange?: (view: ViewInfo) => void;
}

const MINI_W = 150;
const MINI_H = 110;

export function canvasFromImage(img: ImageData): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')?.putImageData(img, 0, 0);
  return c;
}

let checkerTile: HTMLCanvasElement | null = null;
function checker(): HTMLCanvasElement {
  if (checkerTile === null) {
    const c = document.createElement('canvas');
    c.width = 16;
    c.height = 16;
    const ctx = c.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#d9d9d9';
      ctx.fillRect(0, 0, 16, 16);
      ctx.fillStyle = '#f2f2f2';
      ctx.fillRect(0, 0, 8, 8);
      ctx.fillRect(8, 8, 8, 8);
    }
    checkerTile = c;
  }
  return checkerTile;
}

/** Arrow keys move, + / − zoom. Returns true when the key was used. */
export function handleViewerKey(e: KeyboardEvent, view: ZoomPanHandle | null): boolean {
  if (view === null || e.ctrlKey || e.metaKey || e.altKey) return false;
  const step = e.shiftKey ? 240 : 60;
  switch (e.key) {
    case '+':
    case '=':
      view.zoomBy(1.25);
      return true;
    case '-':
    case '_':
      view.zoomBy(0.8);
      return true;
    case 'ArrowLeft':
      view.panBy(step, 0);
      return true;
    case 'ArrowRight':
      view.panBy(-step, 0);
      return true;
    case 'ArrowUp':
      view.panBy(0, step);
      return true;
    case 'ArrowDown':
      view.panBy(0, -step);
      return true;
    default:
      return false;
  }
}

/**
 * Image viewer: drag to move, wheel or pinch to zoom at the cursor, double-click
 * for a close-up and back, on-screen zoom controls and an overview map while
 * zoomed in. Layers are drawn in content coordinates, so a full-resolution
 * crop can sit exactly on top of a smaller preview.
 */
export const ZoomPanView = forwardRef<ZoomPanHandle, Props>(function ZoomPanView(
  { label, content, layers, backdrop, fitKey, maxZoom = 16, outline = false, badge = null, onViewChange },
  ref,
) {
  const { t } = useI18n();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const miniRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const [vp, setVp] = useState<Viewport>({ zoom: 1, panX: 0, panY: 0 });
  const [dragging, setDragging] = useState(false);

  const vpRef = useRef(vp);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const contentRef = useRef(content);
  contentRef.current = content;
  const maxZoomRef = useRef(maxZoom);
  maxZoomRef.current = maxZoom;
  const fitted = useRef({ key: '', w: 0, h: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; midX: number; midY: number } | null>(null);

  const limits = useCallback((): { min: number; max: number } => {
    const fit = fitViewport(contentRef.current, sizeRef.current, maxZoomRef.current).zoom;
    return { min: Math.min(1, fit * 0.25), max: maxZoomRef.current };
  }, []);

  const apply = useCallback((next: Viewport) => {
    const clamped = clampPan(next, contentRef.current, sizeRef.current);
    vpRef.current = clamped;
    setVp(clamped);
  }, []);

  const fit = useCallback(() => {
    apply(fitViewport(contentRef.current, sizeRef.current, maxZoomRef.current));
  }, [apply]);

  const closeUp = useCallback((): number => {
    const fitZoom = fitViewport(contentRef.current, sizeRef.current, maxZoomRef.current).zoom;
    return Math.min(maxZoomRef.current, Math.max(1, fitZoom * 2.5));
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      fit,
      actual: () => {
        const s = sizeRef.current;
        const v = vpRef.current;
        apply(zoomAround(v, 1 / v.zoom, s.width / 2, s.height / 2, 0, maxZoomRef.current));
      },
      zoomBy: (factor) => {
        const s = sizeRef.current;
        const lim = limits();
        apply(zoomAround(vpRef.current, factor, s.width / 2, s.height / 2, lim.min, lim.max));
      },
      panBy: (dx, dy) => {
        const v = vpRef.current;
        apply({ zoom: v.zoom, panX: v.panX + dx, panY: v.panY + dy });
      },
      centerOn: (x, y, zoom) => apply(centerView(x, y, zoom ?? vpRef.current.zoom, sizeRef.current)),
    }),
    [apply, fit, limits],
  );

  // Track the element's size.
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return undefined;
    const update = (): void => setSize({ width: wrap.clientWidth, height: wrap.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  // Fit when the kind of view or the content size changes.
  useLayoutEffect(() => {
    if (size.width === 0 || size.height === 0 || content.width <= 0 || content.height <= 0) return;
    const f = fitted.current;
    if (f.key === fitKey && f.w === content.width && f.h === content.height) return;
    fitted.current = { key: fitKey, w: content.width, h: content.height };
    const next = fitViewport(content, size, maxZoom);
    vpRef.current = next;
    setVp(next);
  }, [fitKey, content, size, maxZoom]);

  // Native, non-passive wheel listener: a pinch must zoom the image, not the page.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return undefined;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const action = wheelAction(e, usePrefs.getState().wheelMode);
      const v = vpRef.current;
      if (action.kind === 'zoom') {
        const lim = limits();
        apply(zoomAround(v, action.factor, e.clientX - rect.left, e.clientY - rect.top, lim.min, lim.max));
      } else {
        apply({ zoom: v.zoom, panX: v.panX + action.dx, panY: v.panY + action.dy });
      }
    };
    wrap.addEventListener('wheel', onWheel, { passive: false });
    return () => wrap.removeEventListener('wheel', onWheel);
  }, [apply, limits]);

  // Draw.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width === 0 || size.height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(size.width * dpr);
    const H = Math.round(size.height * dpr);
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
      canvas.style.width = `${size.width}px`;
      canvas.style.height = `${size.height}px`;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const rx = vp.panX * dpr;
    const ry = vp.panY * dpr;
    const rw = content.width * vp.zoom * dpr;
    const rh = content.height * vp.zoom * dpr;
    if (backdrop.kind === 'color') {
      ctx.fillStyle = backdrop.color;
      ctx.fillRect(0, 0, W, H);
    } else if (backdrop.kind === 'checker') {
      const pattern = ctx.createPattern(checker(), 'repeat');
      if (pattern) {
        ctx.fillStyle = pattern;
        ctx.fillRect(rx, ry, rw, rh);
      }
    }
    ctx.setTransform(dpr * vp.zoom, 0, 0, dpr * vp.zoom, rx, ry);
    for (const layer of layers) {
      const magnification = vp.zoom * dpr * (layer.width / Math.max(1, layer.source.width));
      ctx.imageSmoothingEnabled = layer.smooth === true || magnification < 1;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(layer.source, layer.x, layer.y, layer.width, layer.height);
    }
    if (outline) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.strokeStyle = 'rgba(140, 140, 146, 0.6)';
      ctx.lineWidth = dpr;
      ctx.setLineDash([5 * dpr, 4 * dpr]);
      ctx.strokeRect(rx - dpr / 2, ry - dpr / 2, rw + dpr, rh + dpr);
      ctx.setLineDash([]);
    }
  }, [vp, size, layers, backdrop, content, outline]);

  // Tell the owner what is on screen (it may fetch a sharper close-up).
  useEffect(() => {
    if (!onViewChange || size.width === 0) return;
    onViewChange({ zoom: vp.zoom, visible: visibleRect(vp, content, size) });
  }, [vp, size, content, onViewChange]);

  // ---- Overview map -------------------------------------------------------------
  const zoomedIn =
    size.width > 0 && (content.width * vp.zoom > size.width * 1.05 || content.height * vp.zoom > size.height * 1.05);
  const showMini = zoomedIn && layers.length > 0;
  const miniScale = Math.min(MINI_W / Math.max(1, content.width), MINI_H / Math.max(1, content.height));

  useLayoutEffect(() => {
    const c = miniRef.current;
    if (!c || !showMini) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(content.width * miniScale));
    const h = Math.max(1, Math.round(content.height * miniScale));
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = backdrop.kind === 'color' ? backdrop.color : backdrop.kind === 'checker' ? '#e6e6e6' : '#26262a';
    ctx.fillRect(0, 0, w, h);
    const base = layers[0];
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(base.source, base.x * miniScale, base.y * miniScale, base.width * miniScale, base.height * miniScale);
    const vis = visibleRect(vp, content, size);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#d8683a';
    ctx.strokeRect(vis.x * miniScale, vis.y * miniScale, vis.width * miniScale, vis.height * miniScale);
  }, [showMini, vp, size, layers, backdrop, content, miniScale]);

  const moveToMini = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    apply(centerView((e.clientX - rect.left) / miniScale, (e.clientY - rect.top) / miniScale, vpRef.current.zoom, sizeRef.current));
  };

  // ---- Pointer: drag to move, two fingers to pinch ------------------------------
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2 };
    }
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    pointers.current.set(e.pointerId, cur);
    const v = vpRef.current;
    if (pointers.current.size >= 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      const rect = e.currentTarget.getBoundingClientRect();
      const lim = limits();
      const g = pinch.current;
      const zoomed = zoomAround(v, dist / Math.max(1, g.dist), midX - rect.left, midY - rect.top, lim.min, lim.max);
      pinch.current = { dist, midX, midY };
      apply({ zoom: zoomed.zoom, panX: zoomed.panX + (midX - g.midX), panY: zoomed.panY + (midY - g.midY) });
      return;
    }
    apply({ zoom: v.zoom, panX: v.panX + (cur.x - prev.x), panY: v.panY + (cur.y - prev.y) });
  };

  const onPointerEnd = (e: React.PointerEvent<HTMLDivElement>): void => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) setDragging(false);
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const v = vpRef.current;
    const target = closeUp();
    if (v.zoom < target * 0.98) apply(zoomAround(v, target / v.zoom, e.clientX - rect.left, e.clientY - rect.top, 0, maxZoomRef.current));
    else fit();
  };

  const stop = (e: React.SyntheticEvent): void => e.stopPropagation();
  const zoomBy = (factor: number): void => {
    const lim = limits();
    apply(zoomAround(vpRef.current, factor, size.width / 2, size.height / 2, lim.min, lim.max));
  };

  return (
    <div
      ref={wrapRef}
      className={`zp-view${dragging ? ' dragging' : ''}`}
      aria-label={label}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onDoubleClick={onDoubleClick}
    >
      <canvas ref={canvasRef} className="zp-canvas" />
      {badge ? <div className="zp-badge">{badge}</div> : null}
      {showMini ? (
        <canvas
          ref={miniRef}
          className="zp-minimap"
          title={t('view.minimap')}
          onPointerDown={(e) => {
            e.stopPropagation();
            e.currentTarget.setPointerCapture(e.pointerId);
            moveToMini(e);
          }}
          onPointerMove={(e) => {
            if (e.buttons !== 0) moveToMini(e);
          }}
          onDoubleClick={stop}
        />
      ) : null}
      <div className="zp-controls" onPointerDown={stop} onDoubleClick={stop}>
        <button className="btn icon" onClick={() => zoomBy(0.8)} title={t('view.zoomOut')} aria-label={t('view.zoomOut')}>
          −
        </button>
        <span className="zp-zoom">{Math.round(vp.zoom * 100)}%</span>
        <button className="btn icon" onClick={() => zoomBy(1.25)} title={t('view.zoomIn')} aria-label={t('view.zoomIn')}>
          +
        </button>
        <button className="btn" onClick={fit} title={t('view.fitTitle')}>
          {t('view.fitShort')}
        </button>
        <button
          className="btn"
          onClick={() => {
            const v = vpRef.current;
            apply(zoomAround(v, 1 / v.zoom, size.width / 2, size.height / 2, 0, maxZoomRef.current));
          }}
          title={t('view.actualTitle')}
        >
          1:1
        </button>
      </div>
    </div>
  );
});
