import { useEffect, useRef } from 'react';

/**
 * One path for every user command, whether it comes from a keyboard shortcut,
 * the desktop menu or a button. Handlers stack: the most recently mounted one
 * (e.g. an open studio) gets the first chance and returns true when it acted.
 */
export type AppCommand = DesktopCommand;

type Handler = (command: AppCommand) => boolean;

const handlers: Handler[] = [];

export function runCommand(command: AppCommand): void {
  for (let i = handlers.length - 1; i >= 0; i--) {
    if (handlers[i](command)) return;
  }
}

export function useCommandHandler(handler: Handler): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const stable: Handler = (c) => ref.current(c);
    handlers.push(stable);
    return () => {
      const i = handlers.lastIndexOf(stable);
      if (i >= 0) handlers.splice(i, 1);
    };
  }, []);
}

/** True while the user is typing, so single-key shortcuts stay out of the way. */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true;
  if (target.tagName !== 'INPUT') return false;
  const type = (target as HTMLInputElement).type;
  return !['checkbox', 'radio', 'button', 'range', 'color', 'file'].includes(type);
}

/**
 * Keyboard → command, shared by the main window and the studios. On the Mac
 * desktop app the native menu owns the ⌘ shortcuts and sends them as commands
 * itself, so they are skipped here to avoid running twice.
 */
export function commandForKey(e: KeyboardEvent): AppCommand | null {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  const menuOwnsMod = window.ditherlabDesktop?.platform === 'darwin';
  if (mod && !e.altKey) {
    if (menuOwnsMod) return null;
    if (key === 'o') return 'open';
    if (key === 's') return 'export';
    if (key === 'p') return 'dtf';
    if (key === 'z') return e.shiftKey ? 'redo' : 'undo';
    if (key === 'y') return 'redo';
    if (key === ',') return 'settings';
    if (window.ditherlabDesktop) {
      if (key === '=' || key === '+') return 'ui-bigger';
      if (key === '-') return 'ui-smaller';
      if (key === '0') return 'ui-reset';
    }
    return null;
  }
  if (e.altKey || isTyping(e.target)) return null;
  if (key === 'f') return 'zoom-fit';
  if (key === '0') return 'zoom-100';
  if (key === 'c') return 'compare';
  if (key === '?' || e.key === 'F1') return 'shortcuts';
  return null;
}
