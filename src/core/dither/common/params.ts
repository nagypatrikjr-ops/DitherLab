import type { ParamSpec } from '../../types';

/**
 * Parameter fragments shared by whole families of algorithms. Spreading these
 * into a schema keeps the UI consistent and means a new algorithm inherits the
 * full pixelScale / palette / threshold behaviour for free.
 */

export const SCALE_PARAMS = {
  pixelScale: {
    kind: 'float',
    label: 'Raszter lépték',
    min: 1,
    max: 64,
    step: 0.25,
    default: 1,
    unit: '×',
    group: 'Raszter',
  },
  preserveEdges: {
    kind: 'bool',
    label: 'Élmegőrzés',
    default: false,
    group: 'Raszter',
  },
  outputMode: {
    kind: 'enum',
    label: 'Kimenet',
    options: [
      { value: 'upscaled', label: 'Visszanagyítva (eredeti méret)' },
      { value: 'native', label: 'Natív (kicsi) méret' },
    ],
    default: 'upscaled',
    group: 'Raszter',
  },
} as const satisfies Record<string, ParamSpec>;

export const QUANT_PARAMS = {
  colorMode: {
    kind: 'enum',
    label: 'Színmód',
    options: [
      { value: 'palette', label: 'Paletta' },
      { value: 'perChannel', label: 'Csatornánként' },
      { value: 'mono', label: 'Monokróm (1 bit)' },
    ],
    default: 'palette',
    group: 'Szín',
  },
  colorDepth: {
    kind: 'int',
    label: 'Színmélység',
    min: 2,
    max: 32,
    default: 2,
    unit: 'szint',
    group: 'Szín',
  },
  gammaCorrect: {
    kind: 'bool',
    label: 'Lineáris fényerőtér',
    default: true,
    group: 'Szín',
  },
} as const satisfies Record<string, ParamSpec>;

export const THRESHOLD_PARAMS = {
  threshold: {
    kind: 'float',
    label: 'Luminancia küszöb',
    min: -0.5,
    max: 0.5,
    step: 0.001,
    default: 0,
    group: 'Küszöb',
  },
  thresholdJitter: {
    kind: 'float',
    label: 'Küszöb szórás',
    min: 0,
    max: 1,
    step: 0.001,
    default: 0,
    group: 'Küszöb',
  },
  seed: { kind: 'seed', label: 'Seed', default: 1, group: 'Küszöb' },
} as const satisfies Record<string, ParamSpec>;

export const DIFFUSION_PARAMS = {
  serpentine: {
    kind: 'bool',
    label: 'Kígyózó pásztázás',
    default: true,
    group: 'Hibaterjesztés',
  },
  diffusionStrength: {
    kind: 'float',
    label: 'Kifolyás mértéke',
    min: 0,
    max: 2,
    step: 0.01,
    default: 1,
    unit: '×',
    group: 'Hibaterjesztés',
  },
  errorJitter: {
    kind: 'float',
    label: 'Hiba-zaj',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0,
    group: 'Hibaterjesztés',
  },
} as const satisfies Record<string, ParamSpec>;

export const ORDERED_PARAMS = {
  matrixScale: {
    kind: 'float',
    label: 'Mátrix lépték',
    min: 0.25,
    max: 16,
    step: 0.25,
    default: 1,
    unit: '×',
    group: 'Minta',
  },
  rotation: { kind: 'angle', label: 'Elforgatás', default: 0, group: 'Minta' },
  contrast: {
    kind: 'float',
    label: 'Minta kontraszt',
    min: 0,
    max: 3,
    step: 0.01,
    default: 1,
    group: 'Minta',
  },
  bias: {
    kind: 'float',
    label: 'Minta eltolás',
    min: -0.5,
    max: 0.5,
    step: 0.005,
    default: 0,
    group: 'Minta',
  },
} as const satisfies Record<string, ParamSpec>;
