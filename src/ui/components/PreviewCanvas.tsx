import { useEffect, useRef } from 'react';
import { useStore } from '../../state/store';
import { usePrefs } from '../../state/prefs';
import { wheelAction } from '../viewport';

interface Props {
  result: ImageData | null;
  original: ImageData;
}

/**
 * The viewport: zoom, pan, before/after and split comparison.
 *
 * Both images are kept on offscreen canvases and blitted with a transform, so
 * panning never re-rasterises anything. Smoothing is disabled above 1:1 so a
 * dithered pixel stays a pixel. A new image is fitted to the window; F / 0
 * (or the toolbar) ask for "fit" or "actual pixels" again.
 */
export function PreviewCanvas({ result, original }: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const resultCanvas = useRef<HTMLCanvasElement | null>(null);
  const originalCanvas = useRef<HTMLCanvasElement | null>(null);
  const panning = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const draggingSplit = useRef(false);
  const applied = useRef({ nonce: -1, dims: '' });

  const zoom = useStore((s) => s.zoom);
  const panX = useStore((s) => s.panX);
  const panY = useStore((s) => s.panY);
  const showOriginal = useStore((s) => s.showOriginal);
  const splitView = useStore((s) => s.splitView);
  const splitPosition = useStore((s) => s.splitPosition);
  const viewRequest = useStore((s) => s.viewRequest);
  const setPan = useStore((s) => s.setPan);
  const setView = useStore((s) => s.setView);
  const setViewport = useStore((s) => s.setViewport);
  const zoomAt = useStore((s) => s.zoomAt);
  const setSplitPosition = useStore((s) => s.setSplitPosition);
  const requestView = useStore((s) => s.requestView);

  const toOffscreen = (
    ref: React.MutableRefObject<HTMLCanvasElement | null>,
    image: ImageData | null,
  ): void => {
    if (image === null) {
      ref.current = null;
      return;
    }
    let c = ref.current;
    if (c === null || c.width !== image.width || c.height !== image.height) {
      c = document.createElement('canvas');
      c.width = image.width;
      c.height = image.height;
      ref.current = c;
    }
    c.getContext('2d')?.putImageData(image, 0, 0);
  };

  useEffect(() => {
    toOffscreen(resultCanvas, result);
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  useEffect(() => {
    toOffscreen(originalCanvas, original);
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [original]);

  useEffect(() => {
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, panX, panY, showOriginal, splitView, splitPosition]);

  // Track the viewport size: zoom buttons zoom around its centre, and a
  // resized window (or panel) is redrawn at once.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return undefined;
    const observer = new ResizeObserver(() => {
      setViewport(wrap.clientWidth, wrap.clientHeight);
      draw();
    });
    observer.observe(wrap);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fit a new image; honour explicit "fit" / "actual pixels" requests.
  const shownW = result?.width ?? original.width;
  const shownH = result?.height ?? original.height;
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const dims = `${shownW}x${shownH}`;
    if (applied.current.nonce === viewRequest.nonce && applied.current.dims === dims) return;
    const kind = applied.current.nonce === viewRequest.nonce ? 'fit' : viewRequest.kind;
    applied.current = { nonce: viewRequest.nonce, dims };
    const W = wrap.clientWidth;
    const H = wrap.clientHeight;
    if (W === 0 || H === 0) return;
    const z = kind === 'fit' ? Math.min(8, Math.max(0.02, Math.min((W - 48) / shownW, (H - 48) / shownH))) : 1;
    setView(z, Math.round((W - shownW * z) / 2), Math.round((H - shownH * z) / 2));
  }, [viewRequest, shownW, shownH, setView]);

  // Native, non-passive listener: a pinch must zoom the image, not the page.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return undefined;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const action = wheelAction(e, usePrefs.getState().wheelMode);
      const st = useStore.getState();
      if (action.kind === 'zoom') st.zoomAt(action.factor, e.clientX - rect.left, e.clientY - rect.top);
      else st.setPan(st.panX + action.dx, st.panY + action.dy);
    };
    wrap.addEventListener('wheel', onWheel, { passive: false });
    return () => wrap.removeEventListener('wheel', onWheel);
  }, []);

  function draw(): void {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = zoom < 1;

    // Until the first render arrives, the original stands in for it.
    const res = resultCanvas.current;
    const orig = originalCanvas.current;
    const shown = showOriginal || res === null ? orig : res;
    if (!shown) return;

    ctx.save();
    ctx.translate(panX, panY);
    ctx.scale(zoom, zoom);

    if (splitView && orig && res && !showOriginal) {
      const splitX = splitPosition * res.width;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, splitX, res.height);
      ctx.clip();
      ctx.drawImage(res, 0, 0);
      ctx.restore();

      ctx.save();
      ctx.beginPath();
      ctx.rect(splitX, 0, res.width - splitX, res.height);
      ctx.clip();
      ctx.drawImage(orig, 0, 0, orig.width, orig.height, 0, 0, res.width, res.height);
      ctx.restore();
    } else if (shown === orig && res !== null && orig !== null) {
      // "Before" at the preview's size, so the image does not jump.
      ctx.drawImage(orig, 0, 0, orig.width, orig.height, 0, 0, res.width, res.height);
    } else {
      ctx.drawImage(shown, 0, 0);
    }
    ctx.restore();
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    if (splitView && resultCanvas.current) {
      const handleX = panX + splitPosition * resultCanvas.current.width * zoom;
      if (Math.abs(e.clientX - rect.left - handleX) < 10) {
        draggingSplit.current = true;
        (e.target as Element).setPointerCapture?.(e.pointerId);
        return;
      }
    }
    panning.current = { x: e.clientX, y: e.clientY, panX, panY };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (draggingSplit.current && resultCanvas.current) {
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = (e.clientX - rect.left - panX) / zoom;
      setSplitPosition(x / resultCanvas.current.width);
      return;
    }
    const p = panning.current;
    if (!p) return;
    setPan(p.panX + (e.clientX - p.x), p.panY + (e.clientY - p.y));
  };

  const endPointer = (): void => {
    panning.current = null;
    draggingSplit.current = false;
  };

  const splitHandleX =
    splitView && resultCanvas.current ? panX + splitPosition * resultCanvas.current.width * zoom : null;

  return (
    <div
      className={`canvas-wrap${panning.current ? ' panning' : ''}`}
      ref={wrapRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onDoubleClick={(e) => {
        const rect = wrapRef.current?.getBoundingClientRect();
        if (!rect) return;
        // Close-up on the spot, and back to the whole image on the next double-click.
        if (zoom < 0.999) zoomAt(1 / zoom, e.clientX - rect.left, e.clientY - rect.top);
        else requestView('fit');
      }}
    >
      <canvas ref={canvasRef} />
      {splitHandleX !== null ? <div className="split-handle" style={{ left: splitHandleX }} /> : null}
    </div>
  );
}
