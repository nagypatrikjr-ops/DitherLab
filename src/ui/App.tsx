import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PreviewCanvas } from './components/PreviewCanvas';
import { Toasts } from './components/Toasts';
import { SourcePanel } from './panels/SourcePanel';
import { PalettePanel } from './panels/PalettePanel';
import { LayerPanel } from './panels/LayerPanel';
import { ExportPanel } from './panels/ExportPanel';
import { activePalette, canRedo, canUndo, useStore } from '../state/store';
import { stepUiScale, usePrefs } from '../state/prefs';
import { RenderClient } from '../workers/client';
import { toSerialPalette, type RenderSettings } from '../workers/protocol';
import { previewIsExact, proxyDivisorFor } from '../core/pipeline';
import { imageDataFromBlob } from '../io/image';
import { encodePngRgba } from '../io/png';
import { addRecent, getRecent } from '../io/recent';
import { LANGUAGES, useI18n, useLanguage, type Language } from '../i18n';
import { ShirtStudio, type StudioMode } from './ShirtStudio';
import { WelcomeScreen } from './WelcomeScreen';
import { version } from '../../package.json';
import { Icon } from './components/Icon';
import { HelpCenter, type HelpTab } from './HelpCenter';
import { SettingsDialog } from './SettingsDialog';
import { commandForKey, isTyping, runCommand, useCommandHandler } from './commands';
import { toast } from './toasts';
import { saveFile } from './save';
import { mod, redoKey } from './platform';

const PREVIEW_MAX_DIMENSION = 2000;
const IMAGE_NAME = /\.(png|jpe?g|jpe|jfif|webp|gif|bmp|avif)$/i;
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  jfif: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

export function App(): JSX.Element {
  const i18n = useI18n();
  const { t } = i18n;
  // Callbacks read the current language through a ref, so switching language
  // never re-creates the render pipeline (and never triggers a re-render).
  const i18nRef = useRef(i18n);
  i18nRef.current = i18n;
  const language = useLanguage((s) => s.language);
  const setLanguage = useLanguage((s) => s.setLanguage);

  const clientRef = useRef<RenderClient | null>(null);
  if (clientRef.current === null) clientRef.current = new RenderClient();
  const client = clientRef.current;

  const doc = useStore((s) => s.doc);
  const source = useStore((s) => s.source);
  const setSource = useStore((s) => s.setSource);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const canU = useStore(canUndo);
  const canR = useStore(canRedo);
  const zoom = useStore((s) => s.zoom);
  const zoomBy = useStore((s) => s.zoomBy);
  const requestView = useStore((s) => s.requestView);
  const showOriginal = useStore((s) => s.showOriginal);
  const setShowOriginal = useStore((s) => s.setShowOriginal);
  const splitView = useStore((s) => s.splitView);
  const setSplitView = useStore((s) => s.setSplitView);
  const setRendering = useStore((s) => s.setRendering);
  const setRenderStats = useStore((s) => s.setRenderStats);
  const setStatus = useStore((s) => s.setStatus);
  const toggleLayerByIndex = useStore((s) => s.toggleLayerByIndex);
  const rendering = useStore((s) => s.rendering);
  const progress = useStore((s) => s.progress);
  const lastRenderMs = useStore((s) => s.lastRenderMs);
  const proxyDivisor = useStore((s) => s.proxyDivisor);
  const previewExact = useStore((s) => s.previewExact);
  const statusMessage = useStore((s) => s.statusMessage);

  const [result, setResult] = useState<ImageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [studio, setStudio] = useState<StudioMode | null>(null);
  const [help, setHelp] = useState<HelpTab | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const pendingStudio = useRef<StudioMode | null>(null);
  const overlayRef = useRef(false);
  overlayRef.current = studio !== null || help !== null || settingsOpen;
  const activeJob = useRef<number | null>(null);
  const renderTimer = useRef<number | null>(null);
  const renderSeq = useRef(0);

  const settings: RenderSettings = useMemo(
    () => ({
      palette: toSerialPalette(activePalette(doc)),
      distance: doc.distance,
      gammaCorrect: doc.gammaCorrect,
      seed: doc.seed,
      frame: 0,
      noiseMode: doc.noiseMode,
      cycleLength: doc.cycleLength,
      resolutionDivisor: 1,
    }),
    [doc],
  );

  const divisor = source ? proxyDivisorFor(source.width, source.height, PREVIEW_MAX_DIMENSION) : 1;

  // Upload source pixels to the worker exactly once per image. The old result
  // is dropped so the new original shows while the first render runs.
  useEffect(() => {
    setResult(null);
    if (source === null) return;
    if (!client.hasSource(source.id)) client.setSource(source.id, source.imageData);
  }, [source, client]);

  const runRender = useCallback(
    (immediate = false) => {
      if (source === null) return;
      if (renderTimer.current !== null) window.clearTimeout(renderTimer.current);
      const seq = ++renderSeq.current;
      const start = (): void => {
        if (activeJob.current !== null) client.cancel(activeJob.current);
        setRendering(true, 0);
        setError(null);
        const { jobId, promise } = client.render(source.id, divisor, doc.layers, settings, (fraction) =>
          setRendering(true, fraction),
        );
        activeJob.current = jobId;
        promise
          .then((r) => {
            if (seq !== renderSeq.current) return;
            activeJob.current = null;
            setResult(r.imageData);
            setRendering(false, 1);
            setRenderStats(r.elapsedMs, divisor, previewIsExact(doc.layers, divisor));
          })
          .catch((err: unknown) => {
            if (seq !== renderSeq.current) return;
            activeJob.current = null;
            setRendering(false, 1);
            const message = err instanceof Error ? err.message : String(err);
            if (message !== 'cancelled') setError(i18nRef.current.core(message));
          });
      };
      if (immediate) start();
      else renderTimer.current = window.setTimeout(start, 90);
    },
    [source, client, divisor, doc.layers, settings, setRendering, setRenderStats],
  );

  useEffect(() => {
    runRender();
    return () => {
      if (renderTimer.current !== null) window.clearTimeout(renderTimer.current);
    };
  }, [runRender]);

  const loadSeq = useRef(0);
  const loadImage = useCallback(
    (blob: Blob, name: string) => {
      const tr = i18nRef.current.t;
      const mine = ++loadSeq.current;
      imageDataFromBlob(blob)
        .then((imageData) => {
          // A slower, earlier load must not replace an image opened after it.
          if (mine !== loadSeq.current) return;
          setSource({ id: `${name}:${Date.now()}`, name, width: imageData.width, height: imageData.height, imageData });
          setError(null);
          setStatus(tr('app.loaded', { name, w: imageData.width, h: imageData.height }));
          const mp = (imageData.width * imageData.height) / 1e6;
          if (mp > 50) toast('info', tr('app.bigImage', { mp: Math.round(mp) }));
          if (usePrefs.getState().keepRecent) void addRecent(blob, name, imageData);
          const next = pendingStudio.current;
          pendingStudio.current = null;
          if (next) setStudio(next);
        })
        .catch(() => {
          if (mine !== loadSeq.current) return;
          pendingStudio.current = null;
          toast('error', /\.hei[cf]$/i.test(name) ? tr('app.openFailedHeic', { name }) : tr('app.openFailed', { name }));
        });
    },
    [setSource, setStatus],
  );

  const openPicker = useCallback((then?: StudioMode) => {
    pendingStudio.current = then ?? null;
    // Desktop: the native dialog with an explicit list of image types; the
    // file comes back through onOpenFile like any other opened file.
    const desktop = window.ditherlabDesktop;
    if (desktop) {
      void desktop.openImageDialog().then((opened) => {
        if (!opened) pendingStudio.current = null;
      });
      return;
    }
    fileRef.current?.click();
  }, []);

  // A cancelled file dialog must not leave a studio queued for the next image.
  useEffect(() => {
    const input = fileRef.current;
    if (!input) return undefined;
    const onCancel = (): void => {
      pendingStudio.current = null;
    };
    input.addEventListener('cancel', onCancel);
    return () => input.removeEventListener('cancel', onCancel);
  }, []);

  const loadSample = useCallback(() => {
    fetch('./sample.png')
      .then((r) => r.blob())
      .then((b) => loadImage(b, 'sample.png'))
      .catch(() => toast('error', i18nRef.current.t('app.openFailed', { name: 'sample.png' })));
  }, [loadImage]);

  const openRecent = useCallback(
    (id: string) => {
      void getRecent(id).then((r) => {
        if (r) loadImage(r.blob, r.name);
      });
    },
    [loadImage],
  );

  /** Render at full resolution; used by every exporter. */
  const getFullRender = useCallback(async (): Promise<ImageData> => {
    const tr = i18nRef.current.t;
    if (source === null) throw new Error(tr('common.openImageFirst'));
    setStatus(tr('app.fullRender'));
    const { promise } = client.render(source.id, 1, doc.layers, settings);
    const r = await promise;
    setStatus(tr('app.fullRenderDone', { ms: r.elapsedMs }));
    return r.imageData;
  }, [source, client, doc.layers, settings, setStatus]);

  const exportPng = useCallback(async (): Promise<void> => {
    const src = useStore.getState().source;
    if (src === null) {
      toast('info', i18nRef.current.t('common.openImageFirst'));
      return;
    }
    try {
      const image = await getFullRender();
      saveFile(await encodePngRgba(image.data, image.width, image.height), `${baseName(src.name)}-dither.png`, 'image/png');
    } catch (e) {
      toast('error', i18nRef.current.err(e));
    }
  }, [getFullRender]);

  // ---- Commands: keyboard, desktop menu and buttons all end up here --------
  useCommandHandler((command) => {
    const hasImage = useStore.getState().source !== null;
    switch (command) {
      case 'open':
        openPicker();
        return true;
      case 'sample':
        loadSample();
        return true;
      case 'export':
        void exportPng();
        return true;
      case 'dtf':
        if (hasImage) setStudio('dtf');
        else openPicker('dtf');
        return true;
      case 'undo':
      case 'redo':
        if (isTyping(document.activeElement)) document.execCommand(command);
        else if (command === 'undo') undo();
        else redo();
        return true;
      case 'zoom-fit':
        requestView('fit');
        return true;
      case 'zoom-100':
        requestView('actual');
        return true;
      case 'compare':
        if (hasImage) setSplitView(!useStore.getState().splitView);
        return true;
      case 'ui-bigger':
        stepUiScale(1);
        return true;
      case 'ui-smaller':
        stepUiScale(-1);
        return true;
      case 'ui-reset':
        stepUiScale(0);
        return true;
      case 'help':
        setHelp('start');
        return true;
      case 'guide':
        setHelp('dtf');
        return true;
      case 'shortcuts':
        setHelp('keys');
        return true;
      case 'settings':
        setSettingsOpen(true);
        return true;
    }
    return false;
  });

  // ---- Keyboard ---------------------------------------------------------------
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return;
      const command = commandForKey(e);
      if (command) {
        e.preventDefault();
        runCommand(command);
        return;
      }
      // The rest only makes sense on the main canvas.
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey || overlayRef.current) return;
      if (useStore.getState().source === null) return;
      const key = e.key.toLowerCase();
      if (e.code === 'Space') {
        e.preventDefault();
        setShowOriginal(true);
      } else if (key === 'r') {
        e.preventDefault();
        runRender(true);
      } else if (key === '+' || key === '=') {
        zoomBy(1.25);
      } else if (key === '-') {
        zoomBy(0.8);
      } else if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        const step = e.shiftKey ? 240 : 60;
        const st = useStore.getState();
        st.setPan(
          st.panX + (e.key === 'ArrowLeft' ? step : e.key === 'ArrowRight' ? -step : 0),
          st.panY + (e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0),
        );
      } else if (/^[1-9]$/.test(e.key)) {
        toggleLayerByIndex(Number(e.key) - 1);
      }
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code === 'Space' && !isTyping(e.target)) setShowOriginal(false);
    };
    const onPaste = (e: ClipboardEvent): void => {
      if (isTyping(e.target)) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        const file = items[i].kind === 'file' ? items[i].getAsFile() : null;
        if (file && file.type.startsWith('image/')) {
          e.preventDefault();
          loadImage(file, file.name || 'clipboard.png');
          return;
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('paste', onPaste);
    };
  }, [setShowOriginal, runRender, zoomBy, toggleLayerByIndex, loadImage]);

  // ---- Drop an image anywhere in the window --------------------------------------
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent): boolean => e.dataTransfer?.types.includes('Files') ?? false;
    const onEnter = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const onOver = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const files = [...(e.dataTransfer?.files ?? [])];
      const file = files.find((f) => f.type.startsWith('image/') || IMAGE_NAME.test(f.name));
      if (file) loadImage(file, file.name);
      else if (files[0]) toast('error', i18nRef.current.t('app.openFailed', { name: files[0].name }));
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [loadImage]);

  // ---- Desktop app: menu commands, "open with", saved-file notices ------------
  useEffect(() => {
    const desktop = window.ditherlabDesktop;
    if (!desktop) return undefined;
    const offCommand = desktop.onCommand((c) => runCommand(c));
    const offOpen = desktop.onOpenFile((f) => {
      const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
      loadImage(new Blob([f.bytes as BlobPart], { type: MIME_BY_EXT[ext] ?? '' }), f.name);
    });
    const offSaved = desktop.onFileSaved((f) => {
      const tr = i18nRef.current.t;
      toast('success', tr('toast.saved', { name: f.name }), { label: tr('toast.showInFolder'), run: () => desktop.showSavedFile(f.path) });
    });
    const offFailed = desktop.onSaveFailed((f) => {
      toast('error', i18nRef.current.t('toast.saveFailed', { name: f.name, folder: f.folder }));
    });
    desktop.ready();
    return () => {
      offCommand();
      offOpen();
      offSaved();
      offFailed();
    };
  }, [loadImage]);

  const activeLayers = doc.layers.filter((l) => l.enabled).length;
  const hasImage = source !== null;

  return (
    <div className="app">
      <div className="toolbar" role="toolbar">
        {/* The nameplate. The version is on it because the user has to be able
            to tell, at a glance, which build is actually running. */}
        <div className="brand" title={`DitherLab ${version}`}>
          Dither<span>Lab</span>
          <em className="brand-version">{version}</em>
        </div>
        <button className="btn" onClick={() => openPicker()} title={t('app.openTitle', { key: mod('O') })}>
          {t('app.open')}
        </button>
        <span className="tb-sep" />
        <button className="btn icon" disabled={!canU} onClick={undo} title={t('app.undo', { key: mod('Z') })} aria-label={t('app.undo', { key: mod('Z') })}><Icon name="undo" /></button>
        <button className="btn icon" disabled={!canR} onClick={redo} title={t('app.redo', { key: redoKey() })} aria-label={t('app.redo', { key: redoKey() })}><Icon name="redo" /></button>
        <span className="tb-sep" />
        <button className="btn" disabled={!hasImage} onClick={() => runRender(true)} title={t('app.renderTitle')}>
          {t('app.render')}
        </button>
        <button
          className={`btn${showOriginal ? ' active' : ''}`}
          disabled={!hasImage}
          onPointerDown={() => setShowOriginal(true)}
          onPointerUp={() => setShowOriginal(false)}
          onPointerLeave={() => setShowOriginal(false)}
          title={t('app.beforeTitle')}
        >
          {t('app.before')}
        </button>
        <button
          className={`btn${splitView ? ' active' : ''}`}
          disabled={!hasImage}
          aria-pressed={splitView}
          onClick={() => setSplitView(!splitView)}
          title={t('app.compareTitle')}
        >
          {t('app.compare')}
        </button>
        <button className="btn primary" onClick={() => runCommand('dtf')} title={t('app.dtfTitle', { key: mod('P') })}>
          {t('app.dtf')}
        </button>
        <span className="spacer" />
        <button className="btn icon" disabled={!hasImage} onClick={() => zoomBy(1 / 1.5)} title={t('app.zoomOut')} aria-label={t('app.zoomOut')}><Icon name="zoomOut" /></button>
        <span className="zoom-readout">{Math.round(zoom * 100)}%</span>
        <button className="btn icon" disabled={!hasImage} onClick={() => zoomBy(1.5)} title={t('app.zoomIn')} aria-label={t('app.zoomIn')}><Icon name="zoomIn" /></button>
        <button className="btn" disabled={!hasImage} onClick={() => requestView('fit')} title={t('app.fitTitle')}>{t('app.fit')}</button>
        <button className="btn" disabled={!hasImage} onClick={() => requestView('actual')} title={t('app.actualTitle')}>1:1</button>
        <span className="tb-sep" />
        <select
          className="lang-select"
          value={language}
          onChange={(e) => setLanguage(e.target.value as Language)}
          aria-label={t('common.language')}
          title={t('common.language')}
        >
          {LANGUAGES.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
        <button className="btn" onClick={() => setHelp('start')} title={t('app.helpTitle')}>
          {t('app.help')}
        </button>
        <button className="btn icon" onClick={() => setSettingsOpen(true)} title={t('app.settingsTitle', { key: mod(',') })} aria-label={t('app.settings')}>
          <Icon name="settings" />
        </button>
      </div>

      <div className="panel left">
        <SourcePanel onOpen={() => openPicker()} />
        <PalettePanel />
      </div>

      {source === null ? (
        <WelcomeScreen onOpen={openPicker} onSample={loadSample} onRecent={openRecent} onHelp={() => setHelp('start')} />
      ) : (
        <PreviewCanvas result={result} original={source.imageData} />
      )}
      <div className="canvas-badge">
        {proxyDivisor > 1 && hasImage ? (
          <span className={`badge ${previewExact ? 'ok' : 'warn'}`}>
            {previewExact ? t('app.proxyExact', { d: proxyDivisor }) : t('app.proxyInexact', { d: proxyDivisor })}
          </span>
        ) : null}
        {rendering ? <span className="badge">{t('app.rendering')}</span> : null}
      </div>

      <div className="panel right">
        <LayerPanel />
        <ExportPanel getFullRender={getFullRender} busy={rendering} />
      </div>

      {studio !== null && source !== null ? (
        <ShirtStudio
          key={source.id}
          client={client}
          sourceId={source.id}
          sourceImage={source.imageData}
          renderImage={result}
          fileName={baseName(source.name)}
          initialMode={studio}
          onModeChange={setStudio}
          onClose={() => setStudio(null)}
        />
      ) : null}

      {help !== null ? (
        <HelpCenter
          tab={help}
          onTab={setHelp}
          onClose={() => setHelp(null)}
          hasImage={hasImage}
          onOpenImage={() => {
            setHelp(null);
            openPicker(help === 'dtf' ? 'dtf' : undefined);
          }}
          onOpenDtf={() => {
            setHelp(null);
            setStudio('dtf');
          }}
        />
      ) : null}
      {settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}

      {dragging ? (
        <div className="drop-overlay" aria-hidden="true">
          <div>{t('app.dropHere')}</div>
        </div>
      ) : null}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) loadImage(f, f.name);
          else pendingStudio.current = null;
          e.target.value = '';
        }}
      />

      <Toasts />

      <div className="statusbar">
        <span>{activeLayers === 1 ? t('app.layers.one') : t('app.layers.other', { n: activeLayers })}</span>
        {lastRenderMs > 0 ? <span>{lastRenderMs} ms</span> : null}
        {source ? <span>{source.width}×{source.height}</span> : null}
        <span className="grow">{error ? <span className="error">{error}</span> : statusMessage}</span>
        {rendering ? (
          <div className="progress"><div style={{ width: `${Math.round(progress * 100)}%` }} /></div>
        ) : null}
        <span className="faint">{t('app.hint')}</span>
      </div>
    </div>
  );
}
