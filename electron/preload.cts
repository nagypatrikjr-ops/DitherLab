import { contextBridge, ipcRenderer, webFrame } from 'electron';
import type { IpcRendererEvent } from 'electron';

/**
 * Exposes `window.ditherlabDesktop` to the page. Sandboxed and isolated: the
 * page gets these functions and nothing else from Electron or Node.
 */

function listen<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: T): void => {
    listener(value);
  };
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const VERSION_ARG = '--ditherlab-version=';
const versionArg = process.argv.find((a) => a.startsWith(VERSION_ARG));

const bridge: DesktopBridge = {
  platform: process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux',
  version: versionArg ? versionArg.slice(VERSION_ARG.length) : '',
  onCommand: (listener) => listen<DesktopCommand>('menu-command', listener),
  onOpenFile: (listener) => listen<DesktopOpenedFile>('open-file', listener),
  onFileSaved: (listener) => listen<DesktopSavedFile>('file-saved', listener),
  ready: () => {
    ipcRenderer.send('renderer-ready');
  },
  openImageDialog: () => ipcRenderer.invoke('open-image-dialog') as Promise<boolean>,
  showSavedFile: (filePath) => {
    ipcRenderer.send('show-saved-file', filePath);
  },
  getSaveSettings: () => ipcRenderer.invoke('save-settings:get') as Promise<DesktopSaveSettings>,
  setAskWhereToSave: (ask) => ipcRenderer.invoke('save-settings:ask', ask) as Promise<DesktopSaveSettings>,
  chooseSaveFolder: () => ipcRenderer.invoke('save-settings:choose') as Promise<DesktopSaveSettings>,
  openSaveFolder: () => {
    ipcRenderer.send('open-save-folder');
  },
  setLanguage: (language) => {
    ipcRenderer.send('set-language', language);
  },
  setUiScale: (factor) => {
    webFrame.setZoomFactor(Math.min(1.6, Math.max(0.7, factor)));
  },
};

contextBridge.exposeInMainWorld('ditherlabDesktop', bridge);
