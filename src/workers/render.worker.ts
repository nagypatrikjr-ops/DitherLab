/// <reference lib="webworker" />
import { registerAllProcessors } from '../core';
import { bufferFromRgba, bufferToRgba, resampleBox } from '../core/buffer';
import {
  auditSeparations,
  buildSeparations,
  renderPrintPreview,
  separationToBuffer,
} from '../core/print';
import { RenderCache, renderPipeline } from '../core/pipeline';
import {
  PLACEMENTS,
  SHIRT_SIZES,
  analyzeTransfer,
  autoTune,
  evaluateSettings,
  mirrorRgba,
  prepareSource,
  renderTransfer,
  transferSize,
  type TransferSettings,
} from '../core/transfer';
import { encodePngRgba } from '../io/png';
import { encodeTiff } from '../io/image';
import type { PixelBuffer, RenderContext } from '../core/types';
import type { WorkerRequest, WorkerResponse } from './protocol';

registerAllProcessors();

const sources = new Map<string, PixelBuffer>();
const proxies = new Map<string, PixelBuffer>();
const cache = new RenderCache(384 * 1024 * 1024);
const cancelled = new Set<number>();

function post(message: WorkerResponse, transfer: Transferable[] = []): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message, transfer);
}

function proxyFor(sourceId: string, divisor: number): PixelBuffer | null {
  const source = sources.get(sourceId);
  if (!source) return null;
  if (divisor <= 1) return source;
  const key = `${sourceId}@${divisor}`;
  const hit = proxies.get(key);
  if (hit) return hit;
  const scaled = resampleBox(
    source,
    Math.max(1, Math.round(source.width / divisor)),
    Math.max(1, Math.round(source.height / divisor)),
  );
  proxies.set(key, scaled);
  return scaled;
}

// ---------------------------------------------------------------------------
// DTF transfer helpers
// ---------------------------------------------------------------------------

/** Reduced working copies of large sources, keyed by id and size. */
const reduced = new Map<string, PixelBuffer>();
/** prepareSource results, keyed by working copy + adjustments + garment. */
const preparedCache = new Map<string, Float32Array>();

function remember<V>(map: Map<string, V>, key: string, value: V, limit: number): V {
  map.set(key, value);
  while (map.size > limit) {
    const first = map.keys().next();
    if (first.done) break;
    map.delete(first.value);
  }
  return value;
}

/**
 * The transfer never needs more source pixels than its output has, and a
 * 6000-pixel photo prepared at full size would cost over half a gigabyte.
 * Larger sources are box-reduced to the output size first.
 */
function workingSource(
  sourceId: string,
  source: PixelBuffer,
  maxW: number,
  maxH: number,
): { buf: PixelBuffer; key: string } {
  if (source.width <= maxW && source.height <= maxH) return { buf: source, key: sourceId };
  const k = Math.min(maxW / source.width, maxH / source.height);
  const w = Math.max(1, Math.round(source.width * k));
  const h = Math.max(1, Math.round(source.height * k));
  const key = `${sourceId}@${w}x${h}`;
  const hit = reduced.get(key);
  if (hit) return { buf: hit, key };
  return { buf: remember(reduced, key, resampleBox(source, w, h), 4), key };
}

function preparedFor(key: string, buf: PixelBuffer, s: TransferSettings): Float32Array {
  const pk = `${key}|${JSON.stringify(s.adjust)}|${JSON.stringify(s.garment)}`;
  const hit = preparedCache.get(pk);
  if (hit) return hit;
  return remember(preparedCache, pk, prepareSource(buf, s), 4);
}

/** Box-average a 0/1 mask to 0..255 coverage at a smaller size. */
function reduceAverage(mask: Uint8Array, w: number, h: number, ow: number, oh: number): Uint8Array {
  const out = new Uint8Array(ow * oh);
  for (let oy = 0; oy < oh; oy++) {
    const y0 = Math.floor((oy * h) / oh);
    const y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * h) / oh));
    for (let ox = 0; ox < ow; ox++) {
      const x0 = Math.floor((ox * w) / ow);
      const x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * w) / ow));
      let sum = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) sum += mask[y * w + x];
      out[oy * ow + ox] = Math.round((sum / ((y1 - y0) * (x1 - x0))) * 255);
    }
  }
  return out;
}

/** Max-pool a 0/1 mask so a lone problem pixel still shows when reduced. */
function reduceAny(mask: Uint8Array, w: number, h: number, ow: number, oh: number): Uint8Array {
  const out = new Uint8Array(ow * oh);
  for (let oy = 0; oy < oh; oy++) {
    const y0 = Math.floor((oy * h) / oh);
    const y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * h) / oh));
    for (let ox = 0; ox < ow; ox++) {
      const x0 = Math.floor((ox * w) / ow);
      const x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * w) / ow));
      let any = 0;
      for (let y = y0; y < y1 && any === 0; y++) {
        for (let x = x0; x < x1; x++) {
          if (mask[y * w + x] !== 0) {
            any = 1;
            break;
          }
        }
      }
      out[oy * ow + ox] = any;
    }
  }
  return out;
}

function fullSizeFor(source: PixelBuffer, s: TransferSettings): { width: number; height: number } {
  return transferSize(s, source.width / source.height);
}

async function handleTransferExport(msg: Extract<WorkerRequest, { type: 'transferExport' }>): Promise<void> {
  const source = sources.get(msg.sourceId);
  if (!source) {
    post({ type: 'error', jobId: msg.jobId, message: `Ismeretlen forrás: ${msg.sourceId}` });
    return;
  }
  try {
    const full = fullSizeFor(source, msg.settings);
    const work = workingSource(msg.sourceId, source, full.width, full.height);
    const r = renderTransfer(work.buf, msg.settings, {
      prepared: preparedFor(work.key, work.buf, msg.settings),
      originalWidth: source.width,
    });
    const rgba = msg.settings.mirror ? mirrorRgba(r.rgba, r.width, r.height) : r.rgba;
    let bytes: Uint8Array;
    if (msg.format === 'png') {
      bytes = await encodePngRgba(rgba, r.width, r.height, { dpi: msg.settings.dpi, srgb: true });
    } else {
      bytes = encodeTiff(new ImageData(rgba, r.width, r.height), {
        dpi: Math.round(msg.settings.dpi),
        alpha: true,
      });
    }
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    post(
      { type: 'transferFile', jobId: msg.jobId, format: msg.format, width: r.width, height: r.height, bytes: buf },
      [buf],
    );
  } catch (err) {
    post({ type: 'error', jobId: msg.jobId, message: err instanceof Error ? err.message : String(err) });
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>): void => {
  const msg = event.data;

  switch (msg.type) {
    case 'setSource': {
      sources.set(
        msg.sourceId,
        bufferFromRgba(new Uint8ClampedArray(msg.rgba), msg.width, msg.height),
      );
      for (const key of [...proxies.keys()]) {
        if (key.startsWith(`${msg.sourceId}@`)) proxies.delete(key);
      }
      cache.clear();
      break;
    }

    case 'dropSource': {
      sources.delete(msg.sourceId);
      for (const key of [...proxies.keys()]) {
        if (key.startsWith(`${msg.sourceId}@`)) proxies.delete(key);
      }
      break;
    }

    case 'cancel': {
      cancelled.add(msg.jobId);
      break;
    }

    case 'clearCache': {
      cache.clear();
      break;
    }

    case 'transfer': {
      const source = sources.get(msg.sourceId);
      if (!source) {
        post({ type: 'error', jobId: msg.jobId, message: `Ismeretlen forrás: ${msg.sourceId}` });
        return;
      }
      try {
        const full = fullSizeFor(source, msg.settings);
        let capW = full.width;
        let capH = full.height;
        if (msg.crop === undefined && msg.maxDimension !== undefined) {
          // A preview frame never shows more than about twice its own pixels.
          const k = Math.min(1, (msg.maxDimension * 2) / Math.max(full.width, full.height));
          capW = Math.max(1, Math.round(full.width * k));
          capH = Math.max(1, Math.round(full.height * k));
        }
        const work = workingSource(msg.sourceId, source, capW, capH);
        const r = renderTransfer(work.buf, msg.settings, {
          maxDimension: msg.maxDimension,
          crop: msg.crop,
          prepared: preparedFor(work.key, work.buf, msg.settings),
          originalWidth: source.width,
        });
        const buf = r.rgba.buffer as ArrayBuffer;
        post(
          {
            type: 'transferDone',
            jobId: msg.jobId,
            width: r.width,
            height: r.height,
            frameWidth: r.frameWidth,
            frameHeight: r.frameHeight,
            x0: r.x0,
            y0: r.y0,
            dpi: r.dpi,
            widthMm: r.widthMm,
            heightMm: r.heightMm,
            sourceDpi: r.sourceDpi,
            cellPx: r.cellPx,
            minDotPx: r.minDotPx,
            removedSpecks: r.removedSpecks,
            filledHoles: r.filledHoles,
            rgba: buf,
          },
          [buf],
        );
      } catch (err) {
        post({ type: 'error', jobId: msg.jobId, message: err instanceof Error ? err.message : String(err) });
      }
      break;
    }

    case 'transferAnalyze': {
      const source = sources.get(msg.sourceId);
      if (!source) {
        post({ type: 'error', jobId: msg.jobId, message: `Ismeretlen forrás: ${msg.sourceId}` });
        return;
      }
      try {
        const full = fullSizeFor(source, msg.settings);
        const work = workingSource(msg.sourceId, source, full.width, full.height);
        const r = renderTransfer(work.buf, msg.settings, {
          prepared: preparedFor(work.key, work.buf, msg.settings),
          originalWidth: source.width,
        });
        const a = analyzeTransfer(r, msg.settings, {
          shirt: SHIRT_SIZES.find((x) => x.id === msg.shirtId),
          placement: PLACEMENTS.find((x) => x.id === msg.placementId),
        });
        const ow = Math.max(1, msg.overlayWidth);
        const oh = Math.max(1, msg.overlayHeight);
        const white = reduceAverage(a.white, r.width, r.height, ow, oh);
        const unsupported = reduceAny(a.unsupported, r.width, r.height, ow, oh);
        const thin = reduceAny(a.thin, r.width, r.height, ow, oh);
        const milky = reduceAny(a.milky, r.width, r.height, ow, oh);
        post(
          {
            type: 'transferAnalysis',
            jobId: msg.jobId,
            checks: a.checks,
            stats: a.stats,
            overlayWidth: ow,
            overlayHeight: oh,
            white: white.buffer as ArrayBuffer,
            unsupported: unsupported.buffer as ArrayBuffer,
            thin: thin.buffer as ArrayBuffer,
            milky: milky.buffer as ArrayBuffer,
            fullWidth: r.width,
            fullHeight: r.height,
            removedSpecks: r.removedSpecks,
            filledHoles: r.filledHoles,
          },
          [
            white.buffer as ArrayBuffer,
            unsupported.buffer as ArrayBuffer,
            thin.buffer as ArrayBuffer,
            milky.buffer as ArrayBuffer,
          ],
        );
      } catch (err) {
        post({ type: 'error', jobId: msg.jobId, message: err instanceof Error ? err.message : String(err) });
      }
      break;
    }

    case 'transferExport': {
      void handleTransferExport(msg);
      break;
    }

    case 'transferEvaluate': {
      const source = sources.get(msg.sourceId);
      if (!source) {
        post({ type: 'error', jobId: msg.jobId, message: `Ismeretlen forrás: ${msg.sourceId}` });
        return;
      }
      try {
        post({ type: 'transferEvaluated', jobId: msg.jobId, metrics: evaluateSettings(source, msg.settings) });
      } catch (err) {
        post({ type: 'error', jobId: msg.jobId, message: err instanceof Error ? err.message : String(err) });
      }
      break;
    }

    case 'transferTune': {
      const source = sources.get(msg.sourceId);
      if (!source) {
        post({ type: 'error', jobId: msg.jobId, message: `Ismeretlen forrás: ${msg.sourceId}` });
        return;
      }
      try {
        const result = autoTune(source, msg.settings, msg.preference);
        post({ type: 'transferTuned', jobId: msg.jobId, result });
      } catch (err) {
        post({ type: 'error', jobId: msg.jobId, message: err instanceof Error ? err.message : String(err) });
      }
      break;
    }

    case 'separate': {
      const source = sources.get(msg.sourceId);
      if (!source) {
        post({ type: 'error', jobId: msg.jobId, message: `Ismeretlen forrás: ${msg.sourceId}` });
        return;
      }
      try {
        const result = buildSeparations(source, msg.job, msg.maxDimension);
        const preview = bufferToRgba(renderPrintPreview(result, msg.job.garment));
        const previewBuffer = preview.buffer as ArrayBuffer;
        const transfer: Transferable[] = [previewBuffer];

        // Ship the films at full preview size but as one byte per pixel, so a
        // separation can actually be inspected without paying RGBA on every
        // slider move. The buffers are transferred, not copied.
        const screens = result.separations.map((sep) => {
          const buf = sep.bits.buffer as ArrayBuffer;
          transfer.push(buf);
          return {
            id: sep.id,
            name: sep.name,
            color: sep.color,
            coverage: sep.coverage,
            isUnderbase: sep.isUnderbase,
            bits: buf,
          };
        });

        post(
          {
            type: 'separated',
            jobId: msg.jobId,
            width: result.width,
            height: result.height,
            widthMm: result.widthMm,
            heightMm: result.heightMm,
            dpi: result.dpi,
            previewRgba: previewBuffer,
            screens,
            notes: auditSeparations(result, msg.job),
          },
          transfer,
        );
      } catch (err) {
        post({
          type: 'error',
          jobId: msg.jobId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'film': {
      const source = sources.get(msg.sourceId);
      if (!source) {
        post({ type: 'error', jobId: msg.jobId, message: `Ismeretlen forrás: ${msg.sourceId}` });
        return;
      }
      try {
        const result = buildSeparations(source, msg.job);
        const sep = result.separations[msg.index];
        if (!sep) throw new Error(`Nincs ilyen szita: ${msg.index}`);
        const rgba = bufferToRgba(separationToBuffer(sep, msg.invert));
        const buf = rgba.buffer as ArrayBuffer;
        post(
          {
            type: 'filmReady',
            jobId: msg.jobId,
            name: sep.name,
            width: sep.width,
            height: sep.height,
            rgba: buf,
          },
          [buf],
        );
      } catch (err) {
        post({
          type: 'error',
          jobId: msg.jobId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'render': {
      const source = proxyFor(msg.sourceId, msg.divisor);
      if (source === null) {
        post({ type: 'error', jobId: msg.jobId, message: `Ismeretlen forrás: ${msg.sourceId}` });
        return;
      }

      const controller = new AbortController();
      // Cancellation arrives as a separate message; the worker is single
      // threaded, so a job can only observe a cancel that was queued before it
      // started. Long jobs poll the flag through the abort signal below.
      if (cancelled.has(msg.jobId)) {
        cancelled.delete(msg.jobId);
        post({ type: 'cancelled', jobId: msg.jobId });
        return;
      }

      const s = msg.settings;
      const ctx: RenderContext = {
        palette: s.palette,
        distance: s.distance,
        gammaCorrect: s.gammaCorrect,
        seed: s.seed,
        frame: s.frame,
        noiseMode: s.noiseMode,
        cycleLength: s.cycleLength,
        resolutionDivisor: msg.divisor,
        signal: controller.signal,
        progress: (fraction) => {
          post({ type: 'progress', jobId: msg.jobId, fraction });
        },
      };

      try {
        const result = renderPipeline(
          source,
          `${msg.sourceId}@${msg.divisor}`,
          msg.layers,
          ctx,
          cache,
        );
        const rgba = bufferToRgba(result.buffer);
        const rgbaBuffer = rgba.buffer as ArrayBuffer;
        post(
          {
            type: 'done',
            jobId: msg.jobId,
            width: result.buffer.width,
            height: result.buffer.height,
            rgba: rgbaBuffer,
            elapsedMs: result.elapsedMs,
            firstRecomputed: result.firstRecomputed,
            fromCache: result.fromCache,
          },
          [rgbaBuffer],
        );
      } catch (err) {
        post({
          type: 'error',
          jobId: msg.jobId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }
  }
};

post({ type: 'ready' });
