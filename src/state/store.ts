import { create } from 'zustand';
import type {
  BlendMode,
  DistanceMetric,
  EffectLayer,
  NoiseMode,
  Palette,
  ParamBag,
  ParamValue,
} from '../core/types';
import { defaultParams, requireProcessor } from '../core/dither/registry';
import { BUILTIN_PALETTES, findBuiltinPalette } from '../core/palette/builtin';

/** Everything that is saved, shared as a preset and covered by undo. */
export interface DitherDocument {
  layers: EffectLayer[];
  paletteId: string;
  customPalettes: Palette[];
  distance: DistanceMetric;
  gammaCorrect: boolean;
  seed: number;
  noiseMode: NoiseMode;
  cycleLength: number;
}

export interface SourceImage {
  id: string;
  name: string;
  width: number;
  height: number;
  imageData: ImageData;
}

export interface AppState {
  doc: DitherDocument;
  past: DitherDocument[];
  future: DitherDocument[];
  /** Snapshot taken at the start of a drag, pushed to history on commit. */
  dragSnapshot: DitherDocument | null;

  source: SourceImage | null;
  selectedLayerId: string | null;

  // Preview state (not undoable)
  zoom: number;
  panX: number;
  panY: number;
  showOriginal: boolean;
  splitView: boolean;
  splitPosition: number;
  proxyDivisor: number;
  previewExact: boolean;
  rendering: boolean;
  progress: number;
  lastRenderMs: number;
  statusMessage: string;
  /** "Fit" / "actual pixels" requests for the viewport; bumped by nonce. */
  viewRequest: { kind: 'fit' | 'actual'; nonce: number };
  viewport: { w: number; h: number };

  // actions
  setSource: (source: SourceImage | null) => void;
  addLayer: (type: string) => void;
  removeLayer: (id: string) => void;
  duplicateLayer: (id: string) => void;
  moveLayer: (id: string, toIndex: number) => void;
  toggleLayer: (id: string) => void;
  toggleLayerByIndex: (index: number) => void;
  selectLayer: (id: string | null) => void;
  setLayerOpacity: (id: string, opacity: number, transient?: boolean) => void;
  setLayerBlend: (id: string, blendMode: BlendMode) => void;
  setParam: (id: string, key: string, value: ParamValue, transient?: boolean) => void;
  commitDrag: () => void;
  setPalette: (paletteId: string) => void;
  addCustomPalette: (palette: Palette) => void;
  updateCustomPaletteColors: (paletteId: string, colors: Float32Array) => void;
  setDistance: (metric: DistanceMetric) => void;
  setGamma: (on: boolean) => void;
  setSeed: (seed: number) => void;
  setNoiseMode: (mode: NoiseMode, cycleLength?: number) => void;
  loadDocument: (doc: DitherDocument) => void;
  undo: () => void;
  redo: () => void;

  setZoom: (zoom: number) => void;
  setPan: (x: number, y: number) => void;
  zoomAt: (factor: number, cx: number, cy: number) => void;
  resetView: () => void;
  requestView: (kind: 'fit' | 'actual') => void;
  setViewport: (w: number, h: number) => void;
  setView: (zoom: number, panX: number, panY: number) => void;
  /** Zoom around the centre of the viewport. */
  zoomBy: (factor: number) => void;
  setShowOriginal: (on: boolean) => void;
  setSplitView: (on: boolean) => void;
  setSplitPosition: (v: number) => void;
  setRendering: (on: boolean, progress?: number) => void;
  setRenderStats: (ms: number, divisor: number, exact: boolean) => void;
  setStatus: (message: string) => void;
}

let layerCounter = 0;
function newLayerId(type: string): string {
  layerCounter += 1;
  return `${type.replace(/[^a-z0-9]/gi, '')}-${layerCounter}-${Math.random().toString(36).slice(2, 7)}`;
}

export function createLayer(type: string): EffectLayer {
  const proc = requireProcessor(type);
  return {
    id: newLayerId(type),
    type,
    enabled: true,
    opacity: 1,
    blendMode: 'normal',
    params: defaultParams(proc.params),
    name: proc.name,
  };
}

const MAX_HISTORY = 120;

function emptyDocument(): DitherDocument {
  return {
    layers: [],
    paletteId: BUILTIN_PALETTES[0].id,
    customPalettes: [],
    distance: 'weightedRgb',
    gammaCorrect: true,
    seed: 1,
    noiseMode: 'static',
    cycleLength: 12,
  };
}

export const useStore = create<AppState>()((set, get) => {
  /** Push the current document onto the undo stack and apply a change. */
  const commit = (mutate: (doc: DitherDocument) => DitherDocument): void => {
    const { doc, past } = get();
    const next = mutate(doc);
    if (next === doc) return;
    set({
      doc: next,
      past: [...past, doc].slice(-MAX_HISTORY),
      future: [],
      dragSnapshot: null,
    });
  };

  /** Apply a change without touching history (used while dragging). */
  const touch = (mutate: (doc: DitherDocument) => DitherDocument): void => {
    const { doc, dragSnapshot } = get();
    set({
      doc: mutate(doc),
      dragSnapshot: dragSnapshot ?? doc,
      future: [],
    });
  };

  const mapLayer = (
    doc: DitherDocument,
    id: string,
    fn: (l: EffectLayer) => EffectLayer,
  ): DitherDocument => {
    let changed = false;
    const layers = doc.layers.map((l) => {
      if (l.id !== id) return l;
      const next = fn(l);
      if (next !== l) changed = true;
      return next;
    });
    return changed ? { ...doc, layers } : doc;
  };

  return {
    doc: emptyDocument(),
    past: [],
    future: [],
    dragSnapshot: null,
    source: null,
    selectedLayerId: null,

    zoom: 1,
    panX: 0,
    panY: 0,
    showOriginal: false,
    splitView: false,
    splitPosition: 0.5,
    proxyDivisor: 1,
    previewExact: true,
    rendering: false,
    progress: 0,
    lastRenderMs: 0,
    statusMessage: '',
    viewRequest: { kind: 'fit', nonce: 0 },
    viewport: { w: 0, h: 0 },

    setSource: (source) =>
      set({ source, zoom: 1, panX: 0, panY: 0, viewRequest: { kind: 'fit', nonce: get().viewRequest.nonce + 1 } }),

    addLayer: (type) => {
      const layer = createLayer(type);
      commit((doc) => ({ ...doc, layers: [...doc.layers, layer] }));
      set({ selectedLayerId: layer.id });
    },

    removeLayer: (id) => {
      commit((doc) => ({ ...doc, layers: doc.layers.filter((l) => l.id !== id) }));
      if (get().selectedLayerId === id) {
        set({ selectedLayerId: get().doc.layers.at(-1)?.id ?? null });
      }
    },

    duplicateLayer: (id) => {
      const src = get().doc.layers.find((l) => l.id === id);
      if (!src) return;
      const copy: EffectLayer = { ...src, id: newLayerId(src.type) };
      commit((doc) => {
        const index = doc.layers.findIndex((l) => l.id === id);
        const layers = [...doc.layers];
        layers.splice(index + 1, 0, copy);
        return { ...doc, layers };
      });
      set({ selectedLayerId: copy.id });
    },

    moveLayer: (id, toIndex) =>
      commit((doc) => {
        const from = doc.layers.findIndex((l) => l.id === id);
        if (from < 0) return doc;
        const clamped = Math.max(0, Math.min(doc.layers.length - 1, toIndex));
        if (from === clamped) return doc;
        const layers = [...doc.layers];
        const [moved] = layers.splice(from, 1);
        layers.splice(clamped, 0, moved);
        return { ...doc, layers };
      }),

    toggleLayer: (id) =>
      commit((doc) => mapLayer(doc, id, (l) => ({ ...l, enabled: !l.enabled }))),

    toggleLayerByIndex: (index) => {
      const layer = get().doc.layers[index];
      if (layer) get().toggleLayer(layer.id);
    },

    selectLayer: (id) => set({ selectedLayerId: id }),

    setLayerOpacity: (id, opacity, transient) => {
      const apply = (doc: DitherDocument) =>
        mapLayer(doc, id, (l) => (l.opacity === opacity ? l : { ...l, opacity }));
      if (transient) touch(apply);
      else commit(apply);
    },

    setLayerBlend: (id, blendMode) =>
      commit((doc) => mapLayer(doc, id, (l) => ({ ...l, blendMode }))),

    setParam: (id, key, value, transient) => {
      const apply = (doc: DitherDocument) =>
        mapLayer(doc, id, (l) => {
          if (l.params[key] === value) return l;
          const params: ParamBag = { ...l.params, [key]: value };
          return { ...l, params };
        });
      if (transient) touch(apply);
      else commit(apply);
    },

    commitDrag: () => {
      const { dragSnapshot, past } = get();
      if (dragSnapshot === null) return;
      set({
        past: [...past, dragSnapshot].slice(-MAX_HISTORY),
        future: [],
        dragSnapshot: null,
      });
    },

    setPalette: (paletteId) => commit((doc) => ({ ...doc, paletteId })),

    addCustomPalette: (palette) =>
      commit((doc) => ({
        ...doc,
        customPalettes: [...doc.customPalettes.filter((p) => p.id !== palette.id), palette],
        paletteId: palette.id,
      })),

    updateCustomPaletteColors: (paletteId, colors) =>
      commit((doc) => {
        const existing = doc.customPalettes.find((p) => p.id === paletteId);
        const base =
          existing ??
          findBuiltinPalette(paletteId) ?? { id: paletteId, name: paletteId, category: 'Egyedi', colors };
        const edited: Palette = {
          id: existing ? paletteId : `custom:${paletteId}`,
          name: existing ? base.name : `${base.name} (szerkesztett)`,
          category: 'Egyedi',
          colors,
        };
        return {
          ...doc,
          customPalettes: [...doc.customPalettes.filter((p) => p.id !== edited.id), edited],
          paletteId: edited.id,
        };
      }),

    setDistance: (distance) => commit((doc) => ({ ...doc, distance })),
    setGamma: (gammaCorrect) => commit((doc) => ({ ...doc, gammaCorrect })),
    setSeed: (seed) => commit((doc) => ({ ...doc, seed })),
    setNoiseMode: (noiseMode, cycleLength) =>
      commit((doc) => ({ ...doc, noiseMode, cycleLength: cycleLength ?? doc.cycleLength })),

    loadDocument: (next) => commit(() => next),

    undo: () => {
      const { past, doc, future } = get();
      if (past.length === 0) return;
      const previous = past[past.length - 1];
      set({
        doc: previous,
        past: past.slice(0, -1),
        future: [doc, ...future].slice(0, MAX_HISTORY),
        dragSnapshot: null,
      });
    },

    redo: () => {
      const { past, doc, future } = get();
      if (future.length === 0) return;
      const next = future[0];
      set({
        doc: next,
        past: [...past, doc].slice(-MAX_HISTORY),
        future: future.slice(1),
        dragSnapshot: null,
      });
    },

    setZoom: (zoom) => set({ zoom: Math.min(64, Math.max(0.02, zoom)) }),
    setPan: (panX, panY) => set({ panX, panY }),
    zoomAt: (factor, cx, cy) => {
      const { zoom, panX, panY } = get();
      const next = Math.min(64, Math.max(0.02, zoom * factor));
      const ratio = next / zoom;
      set({
        zoom: next,
        panX: cx - (cx - panX) * ratio,
        panY: cy - (cy - panY) * ratio,
      });
    },
    resetView: () => set({ zoom: 1, panX: 0, panY: 0 }),
    requestView: (kind) => set({ viewRequest: { kind, nonce: get().viewRequest.nonce + 1 } }),
    setViewport: (w, h) => set({ viewport: { w, h } }),
    setView: (zoom, panX, panY) => set({ zoom: Math.min(64, Math.max(0.02, zoom)), panX, panY }),
    zoomBy: (factor) => {
      const { viewport, zoomAt } = get();
      zoomAt(factor, viewport.w / 2, viewport.h / 2);
    },
    setShowOriginal: (showOriginal) => set({ showOriginal }),
    setSplitView: (splitView) => set({ splitView }),
    setSplitPosition: (splitPosition) =>
      set({ splitPosition: Math.min(1, Math.max(0, splitPosition)) }),
    setRendering: (rendering, progress) =>
      set({ rendering, progress: progress ?? (rendering ? 0 : 1) }),
    setRenderStats: (lastRenderMs, proxyDivisor, previewExact) =>
      set({ lastRenderMs, proxyDivisor, previewExact }),
    setStatus: (statusMessage) => set({ statusMessage }),
  };
});

/** Resolve the active palette from the document. */
export function activePalette(doc: DitherDocument): Palette | null {
  return (
    doc.customPalettes.find((p) => p.id === doc.paletteId) ??
    findBuiltinPalette(doc.paletteId)
  );
}

export function allPalettesFor(doc: DitherDocument): Palette[] {
  return [...doc.customPalettes, ...BUILTIN_PALETTES];
}

export function canUndo(state: AppState): boolean {
  return state.past.length > 0;
}

export function canRedo(state: AppState): boolean {
  return state.future.length > 0;
}
