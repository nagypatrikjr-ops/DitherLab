import type { EffectLayer, RGB } from '../core/types';
import type { PrintJob } from '../core/print';
import type {
  TransferAnalysis,
  TransferCheck,
  TransferSettings,
  TuneMetrics,
  TunePreference,
  TuneResult,
} from '../core/transfer';
import type { RenderSettings, WorkerRequest, WorkerResponse } from './protocol';

export interface RenderJobResult {
  imageData: ImageData;
  elapsedMs: number;
  firstRecomputed: number;
  fromCache: boolean;
}

export interface ScreenFilm {
  id: string;
  name: string;
  color: RGB;
  coverage: number;
  isUnderbase: boolean;
  /** One byte per pixel, 1 = ink. */
  bits: Uint8Array;
  width: number;
  height: number;
}

export interface SeparationJobResult {
  preview: ImageData;
  width: number;
  height: number;
  widthMm: number;
  heightMm: number;
  dpi: number;
  screens: ScreenFilm[];
  notes: { level: 'info' | 'warn'; text: string }[];
}

export interface TransferPreview {
  image: ImageData;
  width: number;
  height: number;
  frameWidth: number;
  frameHeight: number;
  x0: number;
  y0: number;
  dpi: number;
  widthMm: number;
  heightMm: number;
  sourceDpi: number;
  cellPx: number;
  minDotPx: number;
  removedSpecks: number;
  filledHoles: number;
}

export interface TransferAnalysisResult {
  checks: TransferCheck[];
  stats: TransferAnalysis['stats'];
  overlayWidth: number;
  overlayHeight: number;
  white: Uint8Array;
  unsupported: Uint8Array;
  thin: Uint8Array;
  milky: Uint8Array;
  fullWidth: number;
  fullHeight: number;
  removedSpecks: number;
  filledHoles: number;
}

export interface TransferFile {
  bytes: Uint8Array;
  width: number;
  height: number;
  format: 'png' | 'tiff';
}

export interface FilmJobResult {
  name: string;
  image: ImageData;
}

interface Pending {
  resolve: (r: never) => void;
  reject: (e: Error) => void;
  onProgress?: (fraction: number) => void;
}

/**
 * Main-thread handle on the render worker.
 *
 * Source pixels are uploaded once and referenced by id afterwards, so a slider
 * drag sends a few hundred bytes rather than a hundred megabytes.
 */
export class RenderClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextJobId = 1;
  private readonly uploaded = new Set<string>();

  constructor() {
    this.worker = new Worker(new URL('./render.worker.ts', import.meta.url), {
      type: 'module',
    });
    // An error the worker did not catch carries no job id, so without this
    // every waiting request would wait forever and the buttons that started
    // them would stay disabled ("it just won't save").
    const failAll = (message: string): void => {
      const waiting = [...this.pending.values()];
      this.pending.clear();
      for (const entry of waiting) entry.reject(new Error(message));
    };
    this.worker.onerror = (event: ErrorEvent) => {
      event.preventDefault();
      failAll(event.message || 'A háttérszámítás váratlanul leállt.');
    };
    this.worker.onmessageerror = () => {
      failAll('A háttérszámítás eredménye nem olvasható.');
    };
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      if (msg.type === 'ready') return;
      const entry = this.pending.get(msg.jobId);
      if (!entry) return;
      switch (msg.type) {
        case 'progress':
          entry.onProgress?.(msg.fraction);
          break;
        case 'done': {
          this.pending.delete(msg.jobId);
          const bytes = new Uint8ClampedArray(msg.rgba);
          this.settle(entry, {
            imageData: new ImageData(bytes, msg.width, msg.height),
            elapsedMs: msg.elapsedMs,
            firstRecomputed: msg.firstRecomputed,
            fromCache: msg.fromCache,
          });
          break;
        }
        case 'separated': {
          this.pending.delete(msg.jobId);
          this.settle(entry, {
            preview: new ImageData(new Uint8ClampedArray(msg.previewRgba), msg.width, msg.height),
            width: msg.width,
            height: msg.height,
            widthMm: msg.widthMm,
            heightMm: msg.heightMm,
            dpi: msg.dpi,
            notes: msg.notes,
            screens: msg.screens.map((s) => ({
              id: s.id,
              name: s.name,
              color: s.color,
              coverage: s.coverage,
              isUnderbase: s.isUnderbase,
              bits: new Uint8Array(s.bits),
              width: msg.width,
              height: msg.height,
            })),
          });
          break;
        }
        case 'transferDone': {
          this.pending.delete(msg.jobId);
          const result: TransferPreview = {
            image: new ImageData(new Uint8ClampedArray(msg.rgba), msg.width, msg.height),
            width: msg.width,
            height: msg.height,
            frameWidth: msg.frameWidth,
            frameHeight: msg.frameHeight,
            x0: msg.x0,
            y0: msg.y0,
            dpi: msg.dpi,
            widthMm: msg.widthMm,
            heightMm: msg.heightMm,
            sourceDpi: msg.sourceDpi,
            cellPx: msg.cellPx,
            minDotPx: msg.minDotPx,
            removedSpecks: msg.removedSpecks,
            filledHoles: msg.filledHoles,
          };
          this.settle(entry, result);
          break;
        }
        case 'transferAnalysis': {
          this.pending.delete(msg.jobId);
          const result: TransferAnalysisResult = {
            checks: msg.checks,
            stats: msg.stats,
            overlayWidth: msg.overlayWidth,
            overlayHeight: msg.overlayHeight,
            white: new Uint8Array(msg.white),
            unsupported: new Uint8Array(msg.unsupported),
            thin: new Uint8Array(msg.thin),
            milky: new Uint8Array(msg.milky),
            fullWidth: msg.fullWidth,
            fullHeight: msg.fullHeight,
            removedSpecks: msg.removedSpecks,
            filledHoles: msg.filledHoles,
          };
          this.settle(entry, result);
          break;
        }
        case 'transferEvaluated': {
          this.pending.delete(msg.jobId);
          this.settle(entry, msg.metrics);
          break;
        }
        case 'transferTuned': {
          this.pending.delete(msg.jobId);
          this.settle(entry, msg.result);
          break;
        }
        case 'transferFile': {
          this.pending.delete(msg.jobId);
          const result: TransferFile = {
            bytes: new Uint8Array(msg.bytes),
            width: msg.width,
            height: msg.height,
            format: msg.format,
          };
          this.settle(entry, result);
          break;
        }
        case 'filmReady': {
          this.pending.delete(msg.jobId);
          this.settle(entry, {
            name: msg.name,
            image: new ImageData(new Uint8ClampedArray(msg.rgba), msg.width, msg.height),
          });
          break;
        }
        case 'error':
          this.pending.delete(msg.jobId);
          entry.reject(new Error(msg.message));
          break;
        case 'cancelled':
          this.pending.delete(msg.jobId);
          entry.reject(new Error('cancelled'));
          break;
      }
    };
  }

  private send(msg: WorkerRequest, transfer: Transferable[] = []): void {
    this.worker.postMessage(msg, transfer);
  }

  /** The pending map is heterogeneous; each response type resolves its own shape. */
  private settle(entry: Pending, value: unknown): void {
    (entry.resolve as (v: unknown) => void)(value);
  }

  hasSource(sourceId: string): boolean {
    return this.uploaded.has(sourceId);
  }

  setSource(sourceId: string, image: ImageData): void {
    // Copy so the caller keeps its own pixels after the transfer.
    const copy = new Uint8ClampedArray(image.data);
    this.uploaded.add(sourceId);
    this.send(
      { type: 'setSource', sourceId, width: image.width, height: image.height, rgba: copy.buffer },
      [copy.buffer],
    );
  }

  dropSource(sourceId: string): void {
    this.uploaded.delete(sourceId);
    this.send({ type: 'dropSource', sourceId });
  }

  clearCache(): void {
    this.send({ type: 'clearCache' });
  }

  render(
    sourceId: string,
    divisor: number,
    layers: EffectLayer[],
    settings: RenderSettings,
    onProgress?: (fraction: number) => void,
  ): { jobId: number; promise: Promise<RenderJobResult> } {
    const jobId = this.nextJobId++;
    const promise = new Promise<RenderJobResult>((resolve, reject) => {
      this.pending.set(jobId, { resolve, reject, onProgress });
      this.send({ type: 'render', jobId, sourceId, divisor, layers, settings });
    });
    return { jobId, promise };
  }

  /** Separate for the interactive preview; `maxDimension` caps the film size. */
  separate(
    sourceId: string,
    job: PrintJob,
    maxDimension?: number,
  ): { jobId: number; promise: Promise<SeparationJobResult> } {
    const jobId = this.nextJobId++;
    const promise = new Promise<SeparationJobResult>((resolve, reject) => {
      this.pending.set(jobId, { resolve: resolve as never, reject });
      this.send({ type: 'separate', jobId, sourceId, job, maxDimension });
    });
    return { jobId, promise };
  }

  private request<T>(msg: Extract<WorkerRequest, { jobId: number }>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.set(msg.jobId, { resolve: resolve as never, reject });
      this.send(msg);
    });
  }

  /** DTF preview (with maxDimension) or a 1:1 crop of the full-resolution file. */
  transfer(
    sourceId: string,
    settings: TransferSettings,
    opts: { maxDimension?: number; crop?: { x: number; y: number; width: number; height: number } },
  ): Promise<TransferPreview> {
    const jobId = this.nextJobId++;
    return this.request<TransferPreview>({
      type: 'transfer',
      jobId,
      sourceId,
      settings,
      maxDimension: opts.maxDimension,
      crop: opts.crop,
    });
  }

  /** Full-resolution preflight; overlays come back at the given size. */
  transferAnalyze(
    sourceId: string,
    settings: TransferSettings,
    context: { shirtId?: string; placementId?: string },
    overlay: { width: number; height: number },
  ): Promise<TransferAnalysisResult> {
    const jobId = this.nextJobId++;
    return this.request<TransferAnalysisResult>({
      type: 'transferAnalyze',
      jobId,
      sourceId,
      settings,
      shirtId: context.shirtId,
      placementId: context.placementId,
      overlayWidth: overlay.width,
      overlayHeight: overlay.height,
    });
  }

  /** Best knockout settings for this image on this garment (see core/transfer/tune). */
  transferTune(sourceId: string, settings: TransferSettings, preference: TunePreference): Promise<TuneResult> {
    const jobId = this.nextJobId++;
    return this.request<TuneResult>({ type: 'transferTune', jobId, sourceId, settings, preference });
  }

  /** Tuner metrics for arbitrary settings — used to vet a proposal before applying it. */
  transferEvaluate(sourceId: string, settings: TransferSettings): Promise<TuneMetrics> {
    const jobId = this.nextJobId++;
    return this.request<TuneMetrics>({ type: 'transferEvaluate', jobId, sourceId, settings });
  }

  /** The print-ready file at full resolution. */
  transferExport(sourceId: string, settings: TransferSettings, format: 'png' | 'tiff'): Promise<TransferFile> {
    const jobId = this.nextJobId++;
    return this.request<TransferFile>({ type: 'transferExport', jobId, sourceId, settings, format });
  }

  /** One separation at full film resolution, as a positive by default. */
  film(sourceId: string, job: PrintJob, index: number, invert = false): Promise<FilmJobResult> {
    const jobId = this.nextJobId++;
    return new Promise<FilmJobResult>((resolve, reject) => {
      this.pending.set(jobId, { resolve: resolve as never, reject });
      this.send({ type: 'film', jobId, sourceId, job, index, invert });
    });
  }

  cancel(jobId: number): void {
    this.send({ type: 'cancel', jobId });
  }

  dispose(): void {
    this.worker.terminate();
    this.pending.clear();
  }
}
