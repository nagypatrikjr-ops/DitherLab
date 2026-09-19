import { create } from 'zustand';
import type { WheelMode } from '../ui/viewport';

/**
 * Interface preferences, remembered in this browser (or desktop app). Nothing
 * here affects how images are processed.
 */
export interface Prefs {
  /** Desktop app interface zoom, 0.8–1.4. */
  uiScale: number;
  /** DTF studio: show only the essential controls. */
  dtfSimple: boolean;
  /** DTF studio: start from the last material colour, size and placement. */
  rememberDtf: boolean;
  /**
   * DTF studio: show the garment extras — the T-shirt mockup, the usual print
   * placements and the heat-press table. Off by default: the print file is the
   * same whatever it is pressed onto, so this is a preview, not a setting.
   */
  dtfGarment: boolean;
  /** Keep a list of recently opened images on this computer. */
  keepRecent: boolean;
  /** What the mouse wheel and two-finger scrolling do in the image viewers. */
  wheelMode: WheelMode;
}

const KEY = 'ditherlab.prefs';
const DEFAULTS: Prefs = { uiScale: 1, dtfSimple: true, rememberDtf: true, dtfGarment: false, keepRecent: true, wheelMode: 'zoom' };

export const UI_SCALES: readonly number[] = [0.85, 1, 1.15, 1.3];

function load(): Prefs {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (typeof raw !== 'object' || raw === null) return { ...DEFAULTS };
    const r = raw as Record<string, unknown>;
    return {
      uiScale: typeof r.uiScale === 'number' && r.uiScale >= 0.8 && r.uiScale <= 1.4 ? r.uiScale : DEFAULTS.uiScale,
      dtfSimple: typeof r.dtfSimple === 'boolean' ? r.dtfSimple : DEFAULTS.dtfSimple,
      rememberDtf: typeof r.rememberDtf === 'boolean' ? r.rememberDtf : DEFAULTS.rememberDtf,
      dtfGarment: typeof r.dtfGarment === 'boolean' ? r.dtfGarment : DEFAULTS.dtfGarment,
      keepRecent: typeof r.keepRecent === 'boolean' ? r.keepRecent : DEFAULTS.keepRecent,
      wheelMode: r.wheelMode === 'pan' || r.wheelMode === 'zoom' ? r.wheelMode : DEFAULTS.wheelMode,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

interface PrefsState extends Prefs {
  setPref: <K extends keyof Prefs>(key: K, value: Prefs[K]) => void;
}

export const usePrefs = create<PrefsState>()((set, get) => ({
  ...load(),
  setPref: (key, value) => {
    set({ [key]: value } as Pick<Prefs, typeof key>);
    const { uiScale, dtfSimple, rememberDtf, dtfGarment, keepRecent, wheelMode } = get();
    try {
      localStorage.setItem(KEY, JSON.stringify({ uiScale, dtfSimple, rememberDtf, dtfGarment, keepRecent, wheelMode }));
    } catch {
      /* storage unavailable */
    }
    if (key === 'uiScale') applyUiScale();
  },
}));

/** Desktop only: the browser version uses the browser's own zoom. */
export function applyUiScale(): void {
  window.ditherlabDesktop?.setUiScale(usePrefs.getState().uiScale);
}

export function stepUiScale(direction: 1 | -1 | 0): void {
  const { uiScale, setPref } = usePrefs.getState();
  if (direction === 0) {
    setPref('uiScale', 1);
    return;
  }
  const i = UI_SCALES.findIndex((s) => Math.abs(s - uiScale) < 0.01);
  const next = UI_SCALES[Math.min(UI_SCALES.length - 1, Math.max(0, (i < 0 ? 1 : i) + direction))];
  setPref('uiScale', next);
}
