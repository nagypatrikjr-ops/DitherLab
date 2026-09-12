import type { RGB } from '../types';
import type { KnockoutSettings } from './types';

/**
 * Reference data for DTF work. Every number here comes from a published
 * source (see README.md); nothing is tuned by eye.
 */

export interface GarmentPreset {
  readonly id: string;
  readonly name: string;
  readonly color: RGB;
}

export const GARMENTS: readonly GarmentPreset[] = [
  { id: 'black', name: 'Fekete', color: { r: 0.055, g: 0.055, b: 0.06 } },
  { id: 'charcoal', name: 'Szénszürke', color: { r: 0.2, g: 0.2, b: 0.21 } },
  { id: 'navy', name: 'Sötétkék', color: { r: 0.09, g: 0.12, b: 0.22 } },
  { id: 'forest', name: 'Sötétzöld', color: { r: 0.08, g: 0.16, b: 0.11 } },
  { id: 'maroon', name: 'Bordó', color: { r: 0.3, g: 0.07, b: 0.1 } },
  { id: 'white', name: 'Fehér', color: { r: 0.96, g: 0.96, b: 0.95 } },
];

/**
 * Gildan 5000 garment measurements (manufacturer size chart):
 * chest half measure and body length from the high point of the shoulder.
 */
export interface ShirtSize {
  readonly id: string;
  readonly halfChestMm: number;
  readonly bodyLengthMm: number;
}

const IN = 25.4;
export const SHIRT_SIZES: readonly ShirtSize[] = [
  { id: 'S', halfChestMm: 18 * IN, bodyLengthMm: 28 * IN },
  { id: 'M', halfChestMm: 20 * IN, bodyLengthMm: 29 * IN },
  { id: 'L', halfChestMm: 22 * IN, bodyLengthMm: 30 * IN },
  { id: 'XL', halfChestMm: 24 * IN, bodyLengthMm: 31 * IN },
  { id: '2XL', halfChestMm: 26 * IN, bodyLengthMm: 32 * IN },
  { id: '3XL', halfChestMm: 28 * IN, bodyLengthMm: 33 * IN },
];

export type PlacementSide = 'front' | 'back' | 'sleeve';

export interface Placement {
  readonly id: string;
  readonly name: string;
  readonly side: PlacementSide;
  /** Recommended width range and default, in mm. */
  readonly minMm: number;
  readonly maxMm: number;
  readonly defaultMm: number;
  /** Distance of the top of the print below the collar seam, in mm. */
  readonly belowCollarMm: number;
  /** Horizontal offset of the print centre from the garment centre, in mm. */
  readonly offsetMm: number;
  readonly note: string;
}

export const PLACEMENTS: readonly Placement[] = [
  {
    id: 'full-front',
    name: 'Elöl, teljes',
    side: 'front',
    minMm: 9 * IN,
    maxMm: 12 * IN,
    defaultMm: 11 * IN,
    belowCollarMm: 3 * IN,
    offsetMm: 0,
    note: 'S–M méreten 9–10", L-től 10–12" széles; 3"-re a nyakvarrás alatt.',
  },
  {
    id: 'left-chest',
    name: 'Bal mell',
    side: 'front',
    minMm: 3.5 * IN,
    maxMm: 4.5 * IN,
    defaultMm: 3.75 * IN,
    belowCollarMm: 3 * IN,
    offsetMm: 4 * IN,
    note: '3,5–4,5" széles, 3"-re a nyakvarrás alatt, 4"-re a középvonaltól.',
  },
  {
    id: 'full-back',
    name: 'Hát, teljes',
    side: 'back',
    minMm: 10 * IN,
    maxMm: 12 * IN,
    defaultMm: 12 * IN,
    belowCollarMm: 2.5 * IN,
    offsetMm: 0,
    note: '2–3"-re a hátsó nyakvarrás alatt, középre igazítva.',
  },
  {
    id: 'back-collar',
    name: 'Tarkó',
    side: 'back',
    minMm: 1 * IN,
    maxMm: 3 * IN,
    defaultMm: 2.5 * IN,
    belowCollarMm: 1.5 * IN,
    offsetMm: 0,
    note: '1–3" széles, 1–2"-re a hátsó nyakvarrás alatt.',
  },
  {
    id: 'sleeve',
    name: 'Ujj',
    side: 'sleeve',
    minMm: 1 * IN,
    maxMm: 3.5 * IN,
    defaultMm: 3 * IN,
    belowCollarMm: 0,
    offsetMm: 0,
    note: '1–3,5" méretben, az ujj közepére.',
  },
];

/**
 * Heat press settings for DTF by fabric (DTF Database chart). The film
 * manufacturer's data sheet always takes precedence: temperature, time,
 * pressure and peel are specified together for a given film and powder.
 */
export interface PressSetting {
  readonly id: string;
  readonly fabric: string;
  readonly tempC: readonly [number, number];
  readonly tempF: readonly [number, number];
  readonly seconds: readonly [number, number];
  readonly pressure: string;
  readonly peel: string;
  readonly finish: string;
}

export const PRESS_SETTINGS: readonly PressSetting[] = [
  {
    id: 'cotton',
    fabric: '100% pamut',
    tempC: [149, 163],
    tempF: [300, 325],
    seconds: [10, 15],
    pressure: 'közepes–erős (40–60 psi)',
    peel: 'meleg vagy hideg (a fólia szerint)',
    finish: '149 °C (300 °F), 10 s, sütőpapírral',
  },
  {
    id: 'cvc',
    fabric: 'Pamut-domináns keverék (60/40, 80/20)',
    tempC: [143, 154],
    tempF: [290, 310],
    seconds: [10, 15],
    pressure: 'közepes (30–50 psi)',
    peel: 'langyos vagy hideg',
    finish: '146 °C (295 °F), 10 s, sütőpapírral',
  },
  {
    id: 'blend',
    fabric: '50/50 pamut-poliészter',
    tempC: [141, 146],
    tempF: [285, 295],
    seconds: [12, 15],
    pressure: 'közepes–erős (40–60 psi)',
    peel: 'langyos vagy hideg',
    finish: '143 °C (290 °F), 10 s, sütőpapírral',
  },
  {
    id: 'triblend',
    fabric: 'Tri-blend (pamut/poliészter/viszkóz)',
    tempC: [138, 149],
    tempF: [280, 300],
    seconds: [10, 12],
    pressure: 'közepes–könnyű (30–45 psi)',
    peel: 'langyos vagy hideg',
    finish: '141 °C (285 °F), 8 s, sütőpapírral',
  },
  {
    id: 'polyester',
    fabric: '100% poliészter',
    tempC: [132, 141],
    tempF: [270, 285],
    seconds: [10, 12],
    pressure: 'közepes (30–40 psi)',
    peel: 'hideg',
    finish: '132 °C (270 °F), 8 s, sütőpapírral',
  },
  {
    id: 'performance',
    fabric: 'Sport / funkcionális anyag',
    tempC: [121, 135],
    tempF: [250, 275],
    seconds: [15, 20],
    pressure: 'könnyű–közepes (20–40 psi)',
    peel: 'hideg',
    finish: '127 °C (260 °F), 8 s, sütőpapírral',
  },
  {
    id: 'fleece',
    fabric: 'Pulóver / polár (50/50 heavy blend)',
    tempC: [141, 149],
    tempF: [285, 300],
    seconds: [15, 20],
    pressure: 'közepes (30–50 psi)',
    peel: 'hideg',
    finish: '143 °C (290 °F), 10 s, sütőpapírral',
  },
];

/** Starting points for the knockout, from solid photo to open vintage. */
export interface LookPreset {
  readonly id: string;
  readonly name: string;
  readonly knockout: KnockoutSettings;
  readonly note: string;
}

export const LOOKS: readonly LookPreset[] = [
  {
    id: 'photo',
    name: 'Fotó — tömör',
    knockout: { enabled: true, tolerance: 0.05, solidPoint: 0.3, density: 1 },
    note: 'Csak a legmélyebb árnyékok bomlanak pontokra. Élethű, tömör nyomat.',
  },
  {
    id: 'balanced',
    name: 'Kiegyensúlyozott',
    knockout: { enabled: true, tolerance: 0.08, solidPoint: 0.6, density: 1 },
    note: 'Az árnyékok és a sötét középtónusok pontokra bomlanak, a világos részek tömörek.',
  },
  {
    id: 'vintage',
    name: 'Vintage — légáteresztő',
    knockout: { enabled: true, tolerance: 0.1, solidPoint: 1, density: 1 },
    note: 'Szinte minden tónus pontokból áll. Puha, könnyű, kopottas hatású nyomat.',
  },
];

/** Roll widths a finished file may need to fit. */
export const FILM_WIDTHS: readonly { name: string; mm: number }[] = [
  { name: 'Asztali DTF (30 cm)', mm: 12 * IN },
  { name: 'Szabványos gang sheet (22")', mm: 22 * IN },
  { name: 'Ipari tekercs (60 cm)', mm: 24 * IN },
];
