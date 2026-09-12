/**
 * DitherLab core types.
 *
 * Design rule: everything in `src/core` is free of DOM and React so that the
 * exact same code runs on the main thread, inside a Web Worker and in Vitest.
 * That is what makes "preview === export" a structural guarantee rather than
 * a promise.
 */

// ---------------------------------------------------------------------------
// Pixel buffers
// ---------------------------------------------------------------------------

export type ColorSpace = 'srgb' | 'linear';

/** RGBA, interleaved, nominal range 0..1 (values may transiently leave it). */
export interface PixelBuffer {
  readonly data: Float32Array;
  readonly width: number;
  readonly height: number;
  readonly colorSpace: ColorSpace;
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

// ---------------------------------------------------------------------------
// Parameter schema -> UI and -> static types
// ---------------------------------------------------------------------------

export interface EnumOption {
  readonly value: string;
  readonly label: string;
}

export type ParamSpec =
  | {
      readonly kind: 'float';
      readonly label: string;
      readonly min: number;
      readonly max: number;
      readonly step: number;
      readonly default: number;
      readonly unit?: string;
      readonly curve?: 'linear' | 'log';
      readonly group?: string;
    }
  | {
      readonly kind: 'int';
      readonly label: string;
      readonly min: number;
      readonly max: number;
      readonly default: number;
      readonly unit?: string;
      readonly group?: string;
    }
  | {
      readonly kind: 'bool';
      readonly label: string;
      readonly default: boolean;
      readonly group?: string;
    }
  | {
      readonly kind: 'angle';
      readonly label: string;
      readonly default: number;
      readonly group?: string;
    }
  | {
      readonly kind: 'enum';
      readonly label: string;
      readonly options: readonly EnumOption[];
      readonly default: string;
      readonly group?: string;
    }
  | {
      readonly kind: 'seed';
      readonly label: string;
      readonly default: number;
      readonly group?: string;
    }
  | {
      readonly kind: 'color';
      readonly label: string;
      readonly default: RGB;
      readonly group?: string;
    }
  | {
      readonly kind: 'matrix';
      readonly label: string;
      readonly rows: number;
      readonly cols: number;
      readonly default: readonly number[];
      readonly group?: string;
    }
  | {
      readonly kind: 'text';
      readonly label: string;
      readonly default: string;
      readonly group?: string;
    };

export type ParamSchema = Readonly<Record<string, ParamSpec>>;

type ValueOfSpec<S extends ParamSpec> = S extends {
  kind: 'float' | 'int' | 'angle' | 'seed';
}
  ? number
  : S extends { kind: 'bool' }
    ? boolean
    : S extends { kind: 'enum'; options: readonly (infer O)[] }
      ? O extends { value: infer V }
        ? V
        : never
      : S extends { kind: 'color' }
        ? RGB
        : S extends { kind: 'matrix' }
          ? readonly number[]
          : S extends { kind: 'text' }
            ? string
            : never;

/** Static parameter object derived from a schema. Enum values become literal unions. */
export type ParamsOf<S extends ParamSchema> = {
  readonly [K in keyof S]: ValueOfSpec<S[K]>;
};

/** Loosely typed bag used at the storage/serialisation boundary. */
export type ParamValue = number | boolean | string | RGB | readonly number[];
export type ParamBag = Readonly<Record<string, ParamValue>>;

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'colorDodge'
  | 'colorBurn'
  | 'hardLight'
  | 'softLight'
  | 'difference'
  | 'exclusion'
  | 'linearBurn'
  | 'linearDodge'
  | 'vividLight'
  | 'pinLight';

export interface EffectLayer {
  readonly id: string;
  /** Registry key of the processor. */
  readonly type: string;
  readonly enabled: boolean;
  /** 0..1 */
  readonly opacity: number;
  readonly blendMode: BlendMode;
  readonly params: ParamBag;
  readonly name?: string;
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

export interface Palette {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  /** sRGB 0..1 triplets, flattened (r,g,b, r,g,b, ...). */
  readonly colors: Float32Array;
}

export type DistanceMetric = 'rgb' | 'weightedRgb' | 'cie76' | 'ciede2000';

// ---------------------------------------------------------------------------
// Render context
// ---------------------------------------------------------------------------

export type NoiseMode = 'static' | 'perFrame' | 'cycling';

export interface RenderContext {
  readonly palette: Palette | null;
  readonly distance: DistanceMetric;
  /** Run error diffusion in linear light. */
  readonly gammaCorrect: boolean;
  /** Document-level seed; combined with layer id for per-layer streams. */
  readonly seed: number;
  /** Frame index for video; 0 for stills. */
  readonly frame: number;
  readonly noiseMode: NoiseMode;
  readonly cycleLength: number;
  /**
   * 1 = full resolution. A proxy preview uses an integer divisor and every
   * raster-geometry parameter (pixelScale, LPI, matrix scale) MUST be divided
   * by it, otherwise the preview lies about the final render.
   */
  readonly resolutionDivisor: number;
  readonly signal?: AbortSignal;
  progress?: (fraction: number) => void;
}

// ---------------------------------------------------------------------------
// Processors (dither algorithms and effects share one interface)
// ---------------------------------------------------------------------------

export type ProcessorCategory =
  | 'errorDiffusion'
  | 'ordered'
  | 'halftone'
  | 'modulated'
  | 'adjust'
  | 'stylize'
  | 'glitch'
  | 'blur';

export interface Processor<S extends ParamSchema = ParamSchema> {
  readonly id: string;
  readonly name: string;
  readonly category: ProcessorCategory;
  readonly params: S;
  /** True if the processor can produce more than 2 tones. */
  readonly supportsColor: boolean;
  /** True if the output is guaranteed 1-bit and therefore vectorisable. */
  readonly vectorizable: boolean;
  apply(input: PixelBuffer, params: ParamsOf<S>, ctx: RenderContext): PixelBuffer;
}

/** Type-erased processor as stored in the registry. */
export interface AnyProcessor {
  readonly id: string;
  readonly name: string;
  readonly category: ProcessorCategory;
  readonly params: ParamSchema;
  readonly supportsColor: boolean;
  readonly vectorizable: boolean;
  apply(input: PixelBuffer, params: ParamBag, ctx: RenderContext): PixelBuffer;
}
