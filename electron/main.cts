import { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, screen, session, shell } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * DitherLab desktop shell.
 *
 * The app is the same static build as the browser version. This process only
 * gives it a window, a native menu, "open with" support and a place to save
 * files. It never touches image processing, and nothing leaves the machine.
 */

const SCHEME = 'app';
const HOST = 'ditherlab';
const ORIGIN = `${SCHEME}://${HOST}`;
const DEV_URL = process.env.DITHERLAB_DEV_URL;
const DIST_DIR = path.join(__dirname, '..', 'dist');
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.jpe', '.jfif', '.webp', '.gif', '.bmp', '.avif']);
const MAX_OPEN_BYTES = 1024 * 1024 * 1024;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // The optional Claude review and Lospec palette import are the only network calls.
  "connect-src 'self' https://api.anthropic.com https://lospec.com",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

app.setName('DitherLab');
if (process.platform === 'win32') app.setAppUserModelId('app.ditherlab.desktop');
// A separate profile (and with it a separate single-instance lock), so an
// automated test run never hands its files to the copy the user has open.
if (process.env.DITHERLAB_USER_DATA) app.setPath('userData', process.env.DITHERLAB_USER_DATA);

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
  },
]);

// ---- Settings ---------------------------------------------------------------

type Language = 'hu' | 'en';

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

interface DesktopSettings {
  askWhereToSave: boolean;
  saveFolder: string | null;
  language: Language | null;
  window: WindowState;
}

function defaultSettings(): DesktopSettings {
  return { askWhereToSave: false, saveFolder: null, language: null, window: { width: 1440, height: 900, maximized: false } };
}

let settings: DesktopSettings = defaultSettings();
let saveTimer: NodeJS.Timeout | null = null;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function finite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function sanitizeSettings(raw: unknown): DesktopSettings {
  const out = defaultSettings();
  if (!isRecord(raw)) return out;
  if (typeof raw.askWhereToSave === 'boolean') out.askWhereToSave = raw.askWhereToSave;
  if (typeof raw.saveFolder === 'string' && raw.saveFolder !== '') out.saveFolder = raw.saveFolder;
  if (raw.language === 'hu' || raw.language === 'en') out.language = raw.language;
  if (isRecord(raw.window)) {
    const w = raw.window;
    const width = finite(w.width);
    const height = finite(w.height);
    if (width !== undefined && height !== undefined) {
      out.window = {
        x: finite(w.x),
        y: finite(w.y),
        width: Math.max(960, Math.round(width)),
        height: Math.max(620, Math.round(height)),
        maximized: w.maximized === true,
      };
    }
  }
  return out;
}

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

async function loadSettings(): Promise<void> {
  try {
    settings = sanitizeSettings(JSON.parse(await readFile(settingsFile(), 'utf8')) as unknown);
  } catch {
    settings = defaultSettings();
  }
}

function saveSettingsSoon(): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void mkdir(app.getPath('userData'), { recursive: true })
      .then(() => writeFile(settingsFile(), JSON.stringify(settings, null, 2)))
      .catch(() => undefined);
  }, 400);
}

function language(): Language {
  if (settings.language !== null) return settings.language;
  const first = app.getPreferredSystemLanguages()[0] ?? app.getLocale();
  return first.toLowerCase().startsWith('hu') ? 'hu' : 'en';
}

function saveFolder(): string {
  return settings.saveFolder !== null && existsSync(settings.saveFolder) ? settings.saveFolder : app.getPath('downloads');
}

function saveSettingsView(): DesktopSaveSettings {
  return { askWhereToSave: settings.askWhereToSave, folder: saveFolder() };
}

// ---- Texts for the native parts ---------------------------------------------

const TEXT = {
  en: {
    file: 'File',
    open: 'Open image…',
    sample: 'Open sample image',
    dtf: 'T-shirt print (DTF)…',
    export: 'Export…',
    showSaved: 'Show saved files',
    settings: 'Settings…',
    quit: 'Quit DitherLab',
    edit: 'Edit',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    selectAll: 'Select all',
    view: 'View',
    fit: 'Fit image to window',
    actual: 'Actual pixels (100%)',
    compare: 'Before / after split view',
    bigger: 'Larger interface',
    smaller: 'Smaller interface',
    uiReset: 'Default interface size',
    fullscreen: 'Full screen',
    devtools: 'Developer tools',
    window: 'Window',
    minimize: 'Minimize',
    zoomWindow: 'Zoom',
    close: 'Close window',
    help: 'Help',
    start: 'Getting started',
    guide: 'DTF printing guide',
    shortcuts: 'Keyboard shortcuts',
    about: 'About DitherLab',
    hide: 'Hide DitherLab',
    hideOthers: 'Hide others',
    showAll: 'Show all',
    saveTitle: 'Save file',
    aboutDetail:
      'Dithering, halftones and print-ready T-shirt files (DTF transfers and screen-print films).\n\n' +
      'Everything runs on this computer. Your images never leave it, unless you switch on the optional Claude review yourself.',
    crashed: 'DitherLab stopped unexpectedly.',
    crashedDetail: 'Your work since the last export may be lost. Reload to continue.',
    reload: 'Reload',
    openFailed: 'This file could not be opened.',
    openTitle: 'Open image',
    images: 'Images',
    allFiles: 'All files',
  },
  hu: {
    file: 'Fájl',
    open: 'Kép megnyitása…',
    sample: 'Mintakép megnyitása',
    dtf: 'Pólónyomat (DTF)…',
    export: 'Exportálás…',
    showSaved: 'Mentett fájlok megnyitása',
    settings: 'Beállítások…',
    quit: 'Kilépés a DitherLabból',
    edit: 'Szerkesztés',
    undo: 'Visszavonás',
    redo: 'Újra',
    cut: 'Kivágás',
    copy: 'Másolás',
    paste: 'Beillesztés',
    selectAll: 'Összes kijelölése',
    view: 'Nézet',
    fit: 'Kép az ablakhoz igazítva',
    actual: 'Valós pixelek (100%)',
    compare: 'Előtte / utána osztott nézet',
    bigger: 'Nagyobb felület',
    smaller: 'Kisebb felület',
    uiReset: 'Alapméretű felület',
    fullscreen: 'Teljes képernyő',
    devtools: 'Fejlesztői eszközök',
    window: 'Ablak',
    minimize: 'Kis méret',
    zoomWindow: 'Nagyítás',
    close: 'Ablak bezárása',
    help: 'Súgó',
    start: 'Első lépések',
    guide: 'DTF nyomtatási útmutató',
    shortcuts: 'Billentyűparancsok',
    about: 'A DitherLabról',
    hide: 'DitherLab elrejtése',
    hideOthers: 'Többi elrejtése',
    showAll: 'Összes mutatása',
    saveTitle: 'Fájl mentése',
    aboutDetail:
      'Dithering, raszterezés és nyomdakész pólófájlok (DTF transzfer és szitafilm).\n\n' +
      'Minden ezen a gépen fut. A képeid nem hagyják el, hacsak te magad be nem kapcsolod az opcionális Claude ellenőrzést.',
    crashed: 'A DitherLab váratlanul leállt.',
    crashedDetail: 'Az utolsó mentés óta végzett munka elveszhetett. Töltsd újra a folytatáshoz.',
    reload: 'Újratöltés',
    openFailed: 'Ezt a fájlt nem sikerült megnyitni.',
    openTitle: 'Kép megnyitása',
    images: 'Képek',
    allFiles: 'Minden fájl',
  },
} as const;

function text(): (typeof TEXT)[Language] {
  return TEXT[language()];
}

// ---- Window -----------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;
let rendererReady = false;
const pendingFiles: string[] = [];
const savedFiles = new Set<string>();

function isAppUrl(url: string): boolean {
  return url.startsWith(`${ORIGIN}/`) || (DEV_URL !== undefined && url.startsWith(DEV_URL));
}

function openExternalSafe(url: string): void {
  if (url.startsWith('https://')) void shell.openExternal(url);
}

function sendCommand(command: DesktopCommand): void {
  mainWindow?.webContents.send('menu-command', command);
}

function focusWindow(): void {
  if (mainWindow === null) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** Restore the last position only if it is still on a connected display. */
function initialBounds(): { x?: number; y?: number; width: number; height: number } {
  const { x, y, width, height } = settings.window;
  if (x === undefined || y === undefined) return { width, height };
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return x < a.x + a.width - 80 && x + width > a.x + 80 && y >= a.y - 20 && y < a.y + a.height - 80;
  });
  return visible ? { x, y, width, height } : { width, height };
}

function createWindow(): void {
  const win = new BrowserWindow({
    ...initialBounds(),
    minWidth: 960,
    minHeight: 620,
    show: false,
    backgroundColor: '#121213',
    title: `DitherLab ${app.getVersion()}`,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      // Chromium slows the timers of a window that is covered or in the
      // background — after five minutes to one wake-up a minute. A long export
      // runs exactly while the user is doing something else, and its follow-up
      // steps are timers: a 600 DPI print could sit for minutes after it had
      // finished computing, with the controls ignoring input meanwhile.
      backgroundThrottling: false,
      additionalArguments: [`--ditherlab-version=${app.getVersion()}`],
    },
  });
  mainWindow = win;
  if (settings.window.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());

  const remember = (): void => {
    if (win.isDestroyed()) return;
    const b = win.getNormalBounds();
    settings.window = { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() };
    saveSettingsSoon();
  };
  win.on('resize', remember);
  win.on('move', remember);
  win.on('maximize', remember);
  win.on('unmaximize', remember);
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
    rendererReady = false;
  });

  const wc = win.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    openExternalSafe(url);
  });
  wc.on('did-start-loading', () => {
    rendererReady = false;
  });
  wc.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    const t = text();
    void dialog
      .showMessageBox(win, {
        type: 'error',
        message: t.crashed,
        detail: t.crashedDetail,
        buttons: [t.reload, t.quit],
        defaultId: 0,
      })
      .then((r) => {
        if (r.response === 0) win.reload();
        else app.quit();
      });
  });

  void win.loadURL(DEV_URL ?? `${ORIGIN}/index.html`);
}

// ---- Serving the app ----------------------------------------------------------

function serveApp(): void {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== HOST) return new Response('Not found', { status: 404 });
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.normalize(path.join(DIST_DIR, relative));
    if (!file.startsWith(DIST_DIR + path.sep)) return new Response('Forbidden', { status: 403 });
    let upstream: Response;
    try {
      upstream = await net.fetch(pathToFileURL(file).toString());
    } catch {
      return new Response('Not found', { status: 404 });
    }
    const headers = new Headers(upstream.headers);
    headers.set('Content-Type', MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
    headers.set('Content-Security-Policy', CSP);
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(upstream.body, { status: upstream.status, headers });
  });
}

// ---- Saving files -----------------------------------------------------------

function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return cleaned === '' ? 'ditherlab' : cleaned;
}

function uniquePath(dir: string, name: string): string {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = path.join(dir, name);
  for (let i = 1; existsSync(candidate); i++) candidate = path.join(dir, `${base} (${i})${ext}`);
  return candidate;
}

function wireDownloads(): void {
  session.defaultSession.on('will-download', (_event, item) => {
    const name = safeFileName(item.getFilename());
    if (settings.askWhereToSave) {
      item.setSaveDialogOptions({ title: text().saveTitle, defaultPath: path.join(saveFolder(), name) });
    } else {
      item.setSavePath(uniquePath(saveFolder(), name));
    }
    item.once('done', (_e, state) => {
      if (state === 'cancelled') return; // the user closed the Save dialog
      if (state !== 'completed') {
        // Used to return silently, so a save the disk refused (no permission,
        // disk full, folder gone) looked exactly like a button that did nothing.
        const target = item.getSavePath();
        const failure: DesktopSaveFailure = { name, folder: target === '' ? saveFolder() : path.dirname(target) };
        mainWindow?.webContents.send('file-save-failed', failure);
        return;
      }
      const saved = item.getSavePath();
      savedFiles.add(saved);
      const file: DesktopSavedFile = { name: path.basename(saved), path: saved };
      mainWindow?.webContents.send('file-saved', file);
    });
  });
}

// ---- Opening files from the OS ----------------------------------------------

function filesFromArgv(argv: readonly string[]): string[] {
  return argv
    .slice(1)
    .filter((a) => !a.startsWith('-') && IMAGE_EXTENSIONS.has(path.extname(a).toLowerCase()) && existsSync(a));
}

async function sendFile(filePath: string): Promise<void> {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size > MAX_OPEN_BYTES) throw new Error('size');
    const data = await readFile(filePath);
    const file: DesktopOpenedFile = {
      name: path.basename(filePath),
      bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    };
    mainWindow?.webContents.send('open-file', file);
    focusWindow();
  } catch {
    dialog.showErrorBox(text().openFailed, filePath);
  }
}

function requestOpen(filePath: string): void {
  if (!IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return;
  if (mainWindow === null || !rendererReady) {
    pendingFiles.push(filePath);
    if (mainWindow === null && app.isReady()) createWindow();
    return;
  }
  void sendFile(filePath);
}

// ---- IPC ----------------------------------------------------------------------

function trusted(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? '';
  return isAppUrl(url);
}

function wireIpc(): void {
  ipcMain.on('renderer-ready', (event) => {
    if (!trusted(event)) return;
    rendererReady = true;
    const files = pendingFiles.splice(0);
    for (const f of files) void sendFile(f);
  });
  ipcMain.on('show-saved-file', (event, filePath: unknown) => {
    if (!trusted(event) || typeof filePath !== 'string' || !savedFiles.has(filePath)) return;
    shell.showItemInFolder(filePath);
  });
  ipcMain.on('open-save-folder', (event) => {
    if (!trusted(event)) return;
    void shell.openPath(saveFolder());
  });
  ipcMain.on('set-language', (event, lang: unknown) => {
    if (!trusted(event) || (lang !== 'hu' && lang !== 'en')) return;
    if (settings.language === lang) return;
    settings.language = lang;
    saveSettingsSoon();
    buildMenu();
  });
  // The page's <input type="file"> relies on Chromium turning its accept
  // list into dialog filters, which Electron does unreliably on macOS (JPEGs
  // could show up greyed out). The native dialog gets an explicit list.
  ipcMain.handle('open-image-dialog', async (event) => {
    if (!trusted(event)) throw new Error('untrusted');
    const t = text();
    const options: Electron.OpenDialogOptions = {
      title: t.openTitle,
      properties: ['openFile'],
      filters: [
        { name: t.images, extensions: [...IMAGE_EXTENSIONS].map((ext) => ext.slice(1)) },
        { name: t.allFiles, extensions: ['*'] },
      ],
    };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    const chosen = result.filePaths[0];
    if (result.canceled || chosen === undefined) return false;
    await sendFile(chosen);
    return true;
  });
  ipcMain.handle('save-settings:get', (event) => {
    if (!trusted(event)) throw new Error('untrusted');
    return saveSettingsView();
  });
  ipcMain.handle('save-settings:ask', (event, ask: unknown) => {
    if (!trusted(event)) throw new Error('untrusted');
    if (typeof ask === 'boolean') {
      settings.askWhereToSave = ask;
      saveSettingsSoon();
    }
    return saveSettingsView();
  });
  ipcMain.handle('save-settings:choose', async (event) => {
    if (!trusted(event)) throw new Error('untrusted');
    const options: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: saveFolder(),
    };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    const chosen = result.filePaths[0];
    if (!result.canceled && chosen !== undefined) {
      settings.saveFolder = chosen;
      saveSettingsSoon();
    }
    return saveSettingsView();
  });
}

function wirePermissions(): void {
  const allowed = new Set(['clipboard-sanitized-write', 'fullscreen']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (e) => e.preventDefault());
  });
}

// ---- Menu -----------------------------------------------------------------------

function showAbout(): void {
  const t = text();
  const options: Electron.MessageBoxOptions = {
    type: 'info',
    title: t.about,
    message: `DitherLab ${app.getVersion()}`,
    detail: t.aboutDetail,
    buttons: ['OK'],
  };
  void (mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options));
}

function buildMenu(): void {
  const t = text();
  const mac = process.platform === 'darwin';
  // On macOS the menu owns its shortcuts. On Windows the page handles them
  // itself (so typing in a text field keeps its own undo), and the menu only
  // shows the key.
  const cmd = (label: string, command: DesktopCommand, accelerator?: string): MenuItemConstructorOptions => ({
    label,
    click: () => sendCommand(command),
    ...(accelerator ? { accelerator, registerAccelerator: mac } : {}),
  });

  const template: MenuItemConstructorOptions[] = [];
  if (mac) {
    template.push({
      label: 'DitherLab',
      submenu: [
        { label: t.about, click: showAbout },
        { type: 'separator' },
        cmd(t.settings, 'settings', 'Cmd+,'),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: t.hide },
        { role: 'hideOthers', label: t.hideOthers },
        { role: 'unhide', label: t.showAll },
        { type: 'separator' },
        { role: 'quit', label: t.quit },
      ],
    });
  }
  template.push(
    {
      label: t.file,
      submenu: [
        cmd(t.open, 'open', 'CmdOrCtrl+O'),
        cmd(t.sample, 'sample'),
        { type: 'separator' },
        cmd(t.dtf, 'dtf', 'CmdOrCtrl+P'),
        cmd(t.export, 'export', 'CmdOrCtrl+S'),
        { type: 'separator' },
        { label: t.showSaved, click: () => void shell.openPath(saveFolder()) },
        ...(mac
          ? []
          : ([
              { type: 'separator' },
              cmd(t.settings, 'settings', 'Ctrl+,'),
              { type: 'separator' },
              { role: 'quit', label: t.quit },
            ] satisfies MenuItemConstructorOptions[])),
      ],
    },
    {
      label: t.edit,
      submenu: [
        cmd(t.undo, 'undo', 'CmdOrCtrl+Z'),
        cmd(t.redo, 'redo', mac ? 'Cmd+Shift+Z' : 'Ctrl+Y'),
        { type: 'separator' },
        { role: 'cut', label: t.cut },
        { role: 'copy', label: t.copy },
        { role: 'paste', label: t.paste },
        { role: 'selectAll', label: t.selectAll },
      ],
    },
    {
      label: t.view,
      submenu: [
        cmd(t.fit, 'zoom-fit'),
        cmd(t.actual, 'zoom-100'),
        cmd(t.compare, 'compare'),
        { type: 'separator' },
        cmd(t.bigger, 'ui-bigger', 'CmdOrCtrl+='),
        cmd(t.smaller, 'ui-smaller', 'CmdOrCtrl+-'),
        cmd(t.uiReset, 'ui-reset', 'CmdOrCtrl+0'),
        { type: 'separator' },
        { role: 'togglefullscreen', label: t.fullscreen },
        ...(app.isPackaged ? [] : ([{ role: 'toggleDevTools', label: t.devtools }] satisfies MenuItemConstructorOptions[])),
      ],
    },
  );
  if (mac) {
    template.push({
      label: t.window,
      submenu: [
        { role: 'minimize', label: t.minimize },
        { role: 'zoom', label: t.zoomWindow },
        { type: 'separator' },
        { role: 'close', label: t.close },
      ],
    });
  }
  template.push({
    label: t.help,
    submenu: [
      cmd(t.start, 'help'),
      cmd(t.guide, 'guide'),
      cmd(t.shortcuts, 'shortcuts'),
      ...(mac ? [] : ([{ type: 'separator' }, { label: t.about, click: showAbout }] satisfies MenuItemConstructorOptions[])),
    ],
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- Lifecycle ----------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    focusWindow();
    for (const f of filesFromArgv(argv)) requestOpen(f);
  });
  // macOS delivers Finder / Dock opens this way, possibly before "ready".
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    requestOpen(filePath);
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  void app.whenReady().then(async () => {
    await loadSettings();
    serveApp();
    wireDownloads();
    wirePermissions();
    wireIpc();
    buildMenu();
    createWindow();
    for (const f of filesFromArgv(process.argv)) requestOpen(f);
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}
