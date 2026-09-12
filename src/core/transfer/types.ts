import type { RGB } from '../types';

/**
 * DTF (direct-to-film) transfer preparation.
 *
 * The deliverable a DTF RIP or print service wants is a transparent PNG at
 * 300 DPI, at final print size, where every pixel is either fully opaque or
 * fully transparent. The RIP lays white ink under everything opaque, so:
 *
 *  - semi-transparent pixels are a defect: they get partial white and print
 *    as a hazy film, so soft glows, shadows and grain must become dots;
 *  - on a dark garment the dark parts of the art should not be printed at
 *    all ("black knockout") — the shirt supplies them, and the print gets
 *    lighter and more breathable;
 *  - features below the smallest printable size flake off in the wash, and a
 *    dot smaller than twice the RIP's white choke has no white under it.
 *
 * Sources for the numbers used below are listed in README.md.
 */

export type TransferScreen = 'am' | 'fm';
export type TransferDotShape = 'round' | 'euclidean' | 'square' | 'ellipse';
export type EdgeFadeShape = 'none' | 'rect' | 'ellipse';

export interface KnockoutSettings {
  enabled: boolean;
  /**
   * Distance from the garment colour, on a perceptual 0..1 scale, below which
   * nothing is printed. Grain that sits this close to the shirt colour
   * disappears instead of turning into specks.
   */
  tolerance: number;
  /**
   * Distance above which a pixel prints solid with its own colour. Between
   * the two, tones are reproduced with dots over the bare garment.
   */
  solidPoint: number;
  /** Dot weight in the transition zone: > 1 heavier, < 1 lighter. */
  density: number;
}

export interface TransferScreenSettings {
  /** AM: dots of varying size on an angled grid. FM: fixed-size dots, varying count. */
  kind: TransferScreen;
  lpi: number;
  angle: number;
  shape: TransferDotShape;
  /** Smallest dot or hole diameter the process reliably holds, in mm. */
  minDotMm: number;
  seed: number;
}

export interface TransferSettings {
  garment: RGB;
  /** Final printed width in millimetres; height follows the artwork. */
  widthMm: number;
  dpi: number;
  knockout: KnockoutSettings;
  screen: TransferScreenSettings;
  /** Fade the artwork's outer edge into dots so a photo is not a hard patch. */
  edgeFade: { shape: EdgeFadeShape; widthMm: number };
  adjust: { contrast: number; saturation: number; sharpen: number };
  /** White underbase choke the RIP applies, in mm. Drives checks and preview. */
  chokeMm: number;
  /** Remove specks and fill pinholes smaller than the minimum printable size. */
  cleanup: boolean;
  /** Mirror the exported file. A DTF service or RIP normally does this itself. */
  mirror: boolean;
}

/** Largest supported print edge. Covers every garment placement with room to spare. */
export const MAX_PRINT_MM = 500;

/**
 * White that must survive under a dot after the choke, in pixels of the file.
 * The RIP chokes the file's own pixel grid: a dot needs at least one pixel
 * farther than the choke from its edge, which after rasterisation takes about
 * three pixels of diameter beyond twice the choke. A dot that loses all of its
 * white prints as bare CMYK on dark fabric, i.e. it vanishes.
 */
export const WHITE_CORE_PX = 3;

/** Pixel coverage at or above which a pixel is simply solid. */
export const SOLID_ALPHA = 0.97;

/** Coverage below this is numerical noise from resampling, never a dot. */
export const ALPHA_FLOOR = 0.015;

export const DEFAULT_TRANSFER: TransferSettings = {
  garment: { r: 0.055, g: 0.055, b: 0.06 },
  widthMm: 280,
  dpi: 300,
  knockout: { enabled: true, tolerance: 0.08, solidPoint: 0.6, density: 1 },
  screen: {
    kind: 'am',
    lpi: 30,
    angle: 22.5,
    // Euclidean: round dots below 50%, round *holes* above it. A round dot
    // leaves four-pointed star gaps once neighbours merge (~78%), and DTF
    // plugs thin gaps unpredictably; round holes survive far better.
    shape: 'euclidean',
    minDotMm: 0.45,
    seed: 1,
  },
  edgeFade: { shape: 'none', widthMm: 15 },
  adjust: { contrast: 0, saturation: 0, sharpen: 0 },
  chokeMm: 0.17,
  cleanup: true,
  mirror: false,
};

export function mmToPx(mm: number, dpi: number): number {
  return (mm / 25.4) * dpi;
}

export function pxToMm(px: number, dpi: number): number {
  return (px / dpi) * 25.4;
}

/**
 * The dot size actually used: the process minimum, raised if the RIP's white
 * choke would otherwise eat the whole white core of a minimum dot. Defined in
 * millimetres at the file's resolution, so a preview renders the same dots.
 */
export function effectiveMinDotMm(s: TransferSettings): number {
  const corePx = (WHITE_CORE_PX * 25.4) / Math.max(1, s.dpi);
  return Math.max(s.screen.minDotMm, 2 * s.chokeMm + corePx);
}

/** Output pixel size of the full-resolution file. */
export function transferSize(
  s: TransferSettings,
  aspect: number,
): { width: number; height: number; heightMm: number } {
  const widthMm = Math.min(MAX_PRINT_MM, Math.max(5, s.widthMm));
  const heightMm = widthMm / aspect;
  return {
    width: Math.max(1, Math.round(mmToPx(widthMm, s.dpi))),
    height: Math.max(1, Math.round(mmToPx(heightMm, s.dpi))),
    heightMm,
  };
}
