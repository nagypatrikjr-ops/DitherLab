import type { RGB } from '../types';

/**
 * Screen-print separation types.
 *
 * Vocabulary, because the domain terms matter when talking to a print shop:
 *  - separation / színbontás: one image per screen, one screen per ink
 *  - knockout / kihagyás: an area with no ink, where the garment shows through
 *  - underbase / aláfestés: a white layer printed first on dark garments so the
 *    colours on top stay bright instead of sinking into the fabric
 *  - choke: shrinking the underbase slightly so it cannot peek out as a halo
 *  - halftone / raszter: continuous tone turned into dots the press can hold
 *  - LPI: halftone lines per inch; mesh count should be roughly 4-5x the LPI
 *  - dot gain / pontnövekedés: dots print larger than they are on the film, so
 *    the film has to be compensated in the opposite direction
 */

export interface Ink {
  readonly id: string;
  readonly name: string;
  /** sRGB 0..1, the colour of the ink as printed on white. */
  readonly color: RGB;
  /** Print order; 0 prints first. The underbase is always before these. */
  readonly order: number;
  /** Whether this ink needs the white underbase beneath it. */
  readonly needsUnderbase: boolean;
  readonly enabled: boolean;
}

export type ScreenType = 'am' | 'fm';
export type PrintDotShape = 'round' | 'square' | 'ellipse' | 'euclidean' | 'line';

export interface ScreenSettings {
  /** Halftone frequency. 35-55 is the realistic textile range. */
  lpi: number;
  /** Film/output resolution in dots per inch. */
  dpi: number;
  /** AM = angled dot grid, FM = stochastic (no moire, grainier). */
  type: ScreenType;
  shape: PrintDotShape;
  /** Degrees. Simulated-process textile work commonly uses one angle. */
  angle: number;
  /** Expected press gain, compensated for on the film. 0.2 = 20%. */
  dotGain: number;
  /** Smallest and largest dot the press can hold, as area fraction. */
  minDot: number;
  maxDot: number;
  /** Below this coverage nothing is printed at all: a true knockout. */
  knockoutBelow: number;
  /** Above this coverage the area becomes solid ink. */
  solidAbove: number;
  seed: number;
}

export interface UnderbaseSettings {
  enabled: boolean;
  /** Shrink in output pixels, so the base cannot show around the colours. */
  chokePx: number;
  /** Solid base, or halftoned to follow the colours' coverage. */
  halftoned: boolean;
  /** Coverage below this gets no base. */
  threshold: number;
  color: RGB;
}

export interface PrintJob {
  /** Physical print width in millimetres; height follows the aspect ratio. */
  widthMm: number;
  garment: RGB;
  inks: Ink[];
  screen: ScreenSettings;
  underbase: UnderbaseSettings;
}

/** One screen's worth of output: 1 = ink, 0 = bare. */
export interface Separation {
  readonly id: string;
  readonly name: string;
  readonly color: RGB;
  readonly width: number;
  readonly height: number;
  readonly bits: Uint8Array;
  /** Fraction of the area carrying ink; useful as a "will this print" hint. */
  readonly coverage: number;
  readonly isUnderbase: boolean;
}

export const DEFAULT_SCREEN: ScreenSettings = {
  lpi: 45,
  dpi: 600,
  type: 'am',
  shape: 'round',
  angle: 22.5,
  dotGain: 0.22,
  minDot: 0.08,
  maxDot: 0.88,
  // Grain in the artwork produces a haze of very light coverage; anything
  // under this is dropped so the garment stays clean instead of speckled.
  knockoutBelow: 0.035,
  // Anything this close to full goes solid. Left at 0.97 nothing ever reaches
  // it on grainy art, and areas meant to be solid white print as 88% lattice.
  solidAbove: 0.92,
  seed: 1,
};

export const DEFAULT_UNDERBASE: UnderbaseSettings = {
  enabled: true,
  chokePx: 3,
  halftoned: true,
  threshold: 0.06,
  color: { r: 1, g: 1, b: 1 },
};

/** Mesh count that suits a given LPI: the common 4-5x rule of thumb. */
export function recommendedMesh(lpi: number): { min: number; max: number } {
  return { min: Math.round(lpi * 4), max: Math.round(lpi * 5) };
}

/** Output pixel size for a physical width at a given resolution. */
export function outputSize(
  widthMm: number,
  dpi: number,
  aspect: number,
): { width: number; height: number } {
  const width = Math.max(1, Math.round((widthMm / 25.4) * dpi));
  return { width, height: Math.max(1, Math.round(width / aspect)) };
}
