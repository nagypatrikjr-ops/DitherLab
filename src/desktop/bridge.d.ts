/**
 * The small, typed surface the desktop shell exposes to the page as
 * `window.ditherlabDesktop`. It is absent in the browser version, so every
 * caller must treat it as optional.
 *
 * Shared by the renderer (src/) and the Electron preload (electron/), which is
 * why it is a global declaration file rather than a module.
 */

/** Commands the native menu sends to the page. */
type DesktopCommand =
  | 'open'
  | 'sample'
  | 'export'
  | 'dtf'
  | 'undo'
  | 'redo'
  | 'zoom-fit'
  | 'zoom-100'
  | 'compare'
  | 'ui-bigger'
  | 'ui-smaller'
  | 'ui-reset'
  | 'help'
  | 'guide'
  | 'shortcuts'
  | 'settings';

interface DesktopOpenedFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

interface DesktopSavedFile {
  readonly name: string;
  readonly path: string;
}

interface DesktopSaveSettings {
  /** Show a Save dialog for every file instead of saving straight to `folder`. */
  readonly askWhereToSave: boolean;
  readonly folder: string;
}

interface DesktopBridge {
  readonly platform: 'darwin' | 'win32' | 'linux';
  readonly version: string;
  onCommand(listener: (command: DesktopCommand) => void): () => void;
  /** Files opened from Finder/Explorer, the Dock icon or "Open with". */
  onOpenFile(listener: (file: DesktopOpenedFile) => void): () => void;
  onFileSaved(listener: (file: DesktopSavedFile) => void): () => void;
  /** Tell the shell the page can receive files. */
  ready(): void;
  /**
   * Native "Open image" dialog. The chosen file arrives through onOpenFile;
   * resolves false when the dialog was cancelled.
   */
  openImageDialog(): Promise<boolean>;
  showSavedFile(path: string): void;
  getSaveSettings(): Promise<DesktopSaveSettings>;
  setAskWhereToSave(ask: boolean): Promise<DesktopSaveSettings>;
  chooseSaveFolder(): Promise<DesktopSaveSettings>;
  openSaveFolder(): void;
  setLanguage(language: 'hu' | 'en'): void;
  setUiScale(factor: number): void;
}

interface Window {
  readonly ditherlabDesktop?: DesktopBridge;
}
