import type { DistanceMetric, EffectLayer, NoiseMode, Palette, RGB } from '../core/types';
import type { PrintJob } from '../core/print';
import type {
  TransferAnalysis,
  TransferCheck,
  TransferSettings,
  TuneMetrics,
  TunePreference,
  TuneResult,
} from '../core/transfer';

export interface SerialPalette {
  id: string;
  name: string;
  category: string;
  colors: Float32Array;
}

export interface RenderSettings {
  palette: SerialPalette | null;
  distance: DistanceMetric;
  gammaCorrect: boolean;
  seed: number;
  frame: number;
  noiseMode: NoiseMode;
  cycleLength: number;
  resolutionDivisor: number;
}

export type WorkerRequest =
  | {
      type: 'setSource';
      sourceId: string;
      width: number;
      height: number;
      /** RGBA bytes; transferred, not copied. */
      rgba: ArrayBuffer;
    }
  | { type: 'dropSource'; sourceId: string }
  | {
      type: 'render';
      jobId: number;
      sourceId: string;
      /** Optional proxy: render from a downscaled copy of the source. */
      divisor: number;
      layers: EffectLayer[];
      settings: RenderSettings;
    }
  | { type: 'cancel'; jobId: number }
  | { type: 'clearCache' }
  | {
      /** Separate a source into screens and return a composited preview. */
      type: 'separate';
      jobId: number;
      sourceId: string;
      job: PrintJob;
      /** Cap the long edge; omit for the full film resolution. */
      maxDimension?: number;
    }
  | {
      /** DTF transfer: interactive preview (maxDimension) or a 1:1 crop. */
      type: 'transfer';
      jobId: number;
      sourceId: string;
      settings: TransferSettings;
      maxDimension?: number;
      crop?: { x: number; y: number; width: number; height: number };
    }
  | {
      /** Full-resolution render + preflight, overlays reduced to a preview size. */
      type: 'transferAnalyze';
      jobId: number;
      sourceId: string;
      settings: TransferSettings;
      shirtId?: string;
      placementId?: string;
      overlayWidth: number;
      overlayHeight: number;
    }
  | {
      /** Find the best knockout settings for this image and garment. */
      type: 'transferTune';
      jobId: number;
      sourceId: string;
      settings: TransferSettings;
      preference: TunePreference;
    }
  | {
      /** Re-measure arbitrary settings the way the tuner does. */
      type: 'transferEvaluate';
      jobId: number;
      sourceId: string;
      settings: TransferSettings;
    }
  | {
      /** Full-resolution print-ready file. */
      type: 'transferExport';
      jobId: number;
      sourceId: string;
      settings: TransferSettings;
      format: 'png' | 'tiff';
    }
  | {
      /** Render one separation at full film resolution as a positive. */
      type: 'film';
      jobId: number;
      sourceId: string;
      job: PrintJob;
      index: number;
      invert: boolean;
    };

export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'progress'; jobId: number; fraction: number }
  | {
      type: 'done';
      jobId: number;
      width: number;
      height: number;
      rgba: ArrayBuffer;
      elapsedMs: number;
      firstRecomputed: number;
      fromCache: boolean;
    }
  | { type: 'error'; jobId: number; message: string }
  | { type: 'cancelled'; jobId: number }
  | {
      type: 'separated';
      jobId: number;
      width: number;
      height: number;
      widthMm: number;
      heightMm: number;
      dpi: number;
      previewRgba: ArrayBuffer;
      screens: {
        id: string;
        name: string;
        color: RGB;
        coverage: number;
        isUnderbase: boolean;
        /** One byte per pixel, 1 = ink. Transferred, so effectively free. */
        bits: ArrayBuffer;
      }[];
      notes: { level: 'info' | 'warn'; text: string }[];
    }
  | {
      type: 'transferDone';
      jobId: number;
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
      rgba: ArrayBuffer;
    }
  | {
      type: 'transferAnalysis';
      jobId: number;
      checks: TransferCheck[];
      stats: TransferAnalysis['stats'];
      overlayWidth: number;
      overlayHeight: number;
      /** 0..255: share of each overlay pixel covered by white underbase. */
      white: ArrayBuffer;
      /** 0/1 masks, max-pooled so a single problem pixel stays visible. */
      unsupported: ArrayBuffer;
      thin: ArrayBuffer;
      milky: ArrayBuffer;
      fullWidth: number;
      fullHeight: number;
      removedSpecks: number;
      filledHoles: number;
    }
  | { type: 'transferTuned'; jobId: number; result: TuneResult }
  | { type: 'transferEvaluated'; jobId: number; metrics: TuneMetrics }
  | {
      type: 'transferFile';
      jobId: number;
      format: 'png' | 'tiff';
      width: number;
      height: number;
      bytes: ArrayBuffer;
    }
  | {
      type: 'filmReady';
      jobId: number;
      name: string;
      width: number;
      height: number;
      rgba: ArrayBuffer;
    };

export function toSerialPalette(p: Palette | null): SerialPalette | null {
  return p === null
    ? null
    : { id: p.id, name: p.name, category: p.category, colors: p.colors };
}
