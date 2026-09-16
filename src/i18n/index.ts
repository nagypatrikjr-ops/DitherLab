import { create } from 'zustand';
import { CORE_EN } from './core-en';
import { translateDynamicEn } from './dynamic-en';
import { MESSAGES, type MessageKey } from './messages';

/**
 * Interface language. The UI's own texts live in ./messages (English and
 * Hungarian side by side, checked for completeness by the compiler). Texts
 * produced by the core stay Hungarian at the source and are translated on the
 * way to the screen by exact match (core-en.ts) or by pattern (dynamic-en.ts).
 */

export type Language = 'hu' | 'en';
export type { MessageKey };

export const LANGUAGES: readonly { id: Language; name: string }[] = [
  { id: 'en', name: 'English' },
  { id: 'hu', name: 'Magyar' },
];

const STORAGE_KEY = 'ditherlab.language';

function storedLanguage(): Language | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'hu' || v === 'en' ? v : null;
  } catch {
    return null;
  }
}

function systemLanguage(): Language {
  try {
    const first = navigator.languages?.[0] ?? navigator.language;
    return first.toLowerCase().startsWith('hu') ? 'hu' : 'en';
  } catch {
    return 'en';
  }
}

function applyLanguage(language: Language): void {
  if (typeof document !== 'undefined') document.documentElement.lang = language;
  if (typeof window !== 'undefined') window.ditherlabDesktop?.setLanguage(language);
}

interface LanguageState {
  language: Language;
  setLanguage: (language: Language) => void;
}

export const useLanguage = create<LanguageState>()((set) => ({
  language: storedLanguage() ?? systemLanguage(),
  setLanguage: (language) => {
    try {
      localStorage.setItem(STORAGE_KEY, language);
    } catch {
      /* storage unavailable: the choice lasts for this session */
    }
    applyLanguage(language);
    set({ language });
  },
}));

/** Sync <html lang> and the desktop menu with the stored choice at startup. */
export function initLanguage(): void {
  applyLanguage(useLanguage.getState().language);
}

export type Vars = Readonly<Record<string, string | number>>;

/** Numbers the way each language writes them: 1,5 in Hungarian, 1.5 in English. */
export function formatNumber(value: number, language: Language, digits?: number): string {
  const s = digits === undefined ? String(value) : value.toFixed(digits);
  return language === 'hu' ? s.replace('.', ',') : s;
}

export function translate(language: Language, key: MessageKey, vars?: Vars): string {
  const template = MESSAGES[language][key];
  if (vars === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = vars[name];
    if (v === undefined) return whole;
    return typeof v === 'number' ? formatNumber(v, language) : v;
  });
}

/** A string that comes from the core (names, labels, checks, errors). */
export function coreText(language: Language, hu: string): string {
  if (language === 'hu') return hu;
  return CORE_EN[hu] ?? translateDynamicEn(hu) ?? hu;
}

export interface I18n {
  readonly lang: Language;
  t(key: MessageKey, vars?: Vars): string;
  /** Translate a string produced by the core. */
  core(hu: string): string;
  /** Message of a caught error, translated when the core raised it. */
  err(error: unknown): string;
  num(value: number, digits?: number): string;
}

const cache: Partial<Record<Language, I18n>> = {};

/** What the user is told when the browser engine runs out of room. */
export const OUT_OF_MEMORY = 'Ehhez a mérethez nincs elég memória. Csökkentsd a felbontást (DPI) vagy a nyomat szélességét, és próbáld újra.';

/**
 * The engine's own failures are written for people; a JavaScript engine's are
 * not ("Array buffer allocation failed"). The ones that mean "too big for the
 * memory this machine has" all get the same plain explanation.
 */
function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /allocation failed|invalid array length|invalid typed array length|out of memory/i.test(message) ? OUT_OF_MEMORY : message;
}

export function i18nFor(lang: Language): I18n {
  const hit = cache[lang];
  if (hit) return hit;
  const made: I18n = {
    lang,
    t: (key, vars) => translate(lang, key, vars),
    core: (hu) => coreText(lang, hu),
    err: (error) => coreText(lang, errorText(error)),
    num: (value, digits) => formatNumber(value, lang, digits),
  };
  cache[lang] = made;
  return made;
}

export function useI18n(): I18n {
  return i18nFor(useLanguage((s) => s.language));
}

/** For code outside React components (file names, exported text). */
export function currentI18n(): I18n {
  return i18nFor(useLanguage.getState().language);
}
