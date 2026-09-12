import type { RGB } from '../core/types';
import type { TunePreference } from '../core/transfer';

/**
 * The T-shirt studio's "last used" choices: shirt, size, fabric, placement,
 * width, resolution and the auto-tune aim. Only the user's own inputs are
 * remembered — never anything the tuner computes for a particular image.
 */
export interface DtfMemory {
  garment?: RGB;
  shirtId?: string;
  fabricId?: string;
  placementId?: string;
  widthMm?: number;
  dpi?: number;
  preference?: TunePreference;
}

const KEY = 'ditherlab.dtf';

function isRgb(v: unknown): v is RGB {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return [c.r, c.g, c.b].every((x) => typeof x === 'number' && x >= 0 && x <= 1);
}

export function loadDtfMemory(): DtfMemory {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (typeof raw !== 'object' || raw === null) return {};
    const r = raw as Record<string, unknown>;
    const out: DtfMemory = {};
    if (isRgb(r.garment)) out.garment = { r: r.garment.r, g: r.garment.g, b: r.garment.b };
    if (typeof r.shirtId === 'string') out.shirtId = r.shirtId;
    if (typeof r.fabricId === 'string') out.fabricId = r.fabricId;
    if (typeof r.placementId === 'string') out.placementId = r.placementId;
    if (typeof r.widthMm === 'number' && r.widthMm >= 20 && r.widthMm <= 1000) out.widthMm = r.widthMm;
    if (r.dpi === 300 || r.dpi === 360 || r.dpi === 600) out.dpi = r.dpi;
    if (r.preference === 'photo' || r.preference === 'balanced' || r.preference === 'vintage') out.preference = r.preference;
    return out;
  } catch {
    return {};
  }
}

export function saveDtfMemory(memory: DtfMemory): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(memory));
  } catch {
    /* storage unavailable */
  }
}

export function clearDtfMemory(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
}
