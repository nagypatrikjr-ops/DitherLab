/** Small facts about where the app is running, for labels and shortcuts. */

export function isDesktop(): boolean {
  return typeof window !== 'undefined' && window.ditherlabDesktop !== undefined;
}

export function isMac(): boolean {
  const desktop = typeof window !== 'undefined' ? window.ditherlabDesktop : undefined;
  if (desktop) return desktop.platform === 'darwin';
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/** Shortcut label for a modifier combination: "⌘O" on a Mac, "Ctrl+O" elsewhere. */
export function mod(key: string): string {
  return isMac() ? `⌘${key}` : `Ctrl+${key}`;
}

export function redoKey(): string {
  return isMac() ? '⇧⌘Z' : 'Ctrl+Y';
}
