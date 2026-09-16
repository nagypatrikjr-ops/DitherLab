import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { RGB } from '../core/types';
import {
  DEFAULT_SCREEN,
  DEFAULT_UNDERBASE,
  recommendedMesh,
  type Ink,
  type PrintDotShape,
  type PrintJob,
  type ScreenType,
} from '../core/print';
import { suggestInks } from '../core/print/separate';
import { bufferFromRgba } from '../core/buffer';
import { hexToRgb, rgbToHex } from '../core/palette/builtin';
import { encodePngRgba } from '../io/png';
import { createZip, type ZipEntry } from '../io/zip';
import type { RenderClient, SeparationJobResult } from '../workers/client';
import { useI18n, type MessageKey } from '../i18n';
import { usePrefs } from '../state/prefs';
import { NumberSlider } from './components/NumberSlider';
import { Section } from './components/Section';
import { ZoomPanView, canvasFromImage, handleViewerKey, type ViewLayer, type ZoomPanHandle } from './components/ZoomPanView';
import { isTyping, useCommandHandler } from './commands';
import { saveFile } from './save';
import { Icon } from './components/Icon';

interface Props {
  client: RenderClient;
  /** The untouched image. */
  sourceId: string;
  sourceImage: ImageData;
  /** The current effect stack output, when there is one. */
  renderImage: ImageData | null;
  fileName: string;
  onClose: () => void;
  headerExtra?: ReactNode;
}

const PREVIEW_MAX = 1100;

/** The garment is a physical object, not something to infer from the artwork. */
const GARMENTS: { id: string; key: MessageKey; color: RGB }[] = [
  { id: 'black', key: 'sp.gBlack', color: { r: 0.055, g: 0.055, b: 0.06 } },
  { id: 'charcoal', key: 'sp.gCharcoal', color: { r: 0.16, g: 0.16, b: 0.17 } },
  { id: 'navy', key: 'sp.gNavy', color: { r: 0.08, g: 0.11, b: 0.2 } },
  { id: 'forest', key: 'sp.gForest', color: { r: 0.08, g: 0.14, b: 0.11 } },
  { id: 'maroon', key: 'sp.gMaroon', color: { r: 0.21, g: 0.06, b: 0.09 } },
];

let inkCounter = 0;
function newInk(color: RGB, name: string, order: number): Ink {
  inkCounter += 1;
  return {
    id: `ink-${inkCounter}`,
    name,
    color,
    order,
    needsUnderbase: true,
    enabled: true,
  };
}

/** ASCII file-name fragment: accents dropped, everything else to dashes. */
function slug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

/**
 * Screen-print studio.
 *
 * The whole point: on a black garment the black of the artwork is *not* ink,
 * it is the shirt. So the image is separated into per-ink coverage, the garment
 * colour becomes a true knockout, and every remaining tone is screened into
 * dots the press can actually hold — no soft glow, no smeared grain.
 */
export function ScreenPrintStudio({
  client, sourceId, sourceImage, renderImage, fileName, onClose, headerExtra,
}: Props): JSX.Element {
  const { t, core, err, num } = useI18n();
  const wheelMode = usePrefs((p) => p.wheelMode);
  const [useRender, setUseRender] = useState(renderImage !== null);
  const [garment, setGarment] = useState<RGB>(GARMENTS[0].color);
  const [inks, setInks] = useState<Ink[]>([]);
  const [screen, setScreen] = useState({ ...DEFAULT_SCREEN });
  const [underbase, setUnderbase] = useState({ ...DEFAULT_UNDERBASE });
  const [widthMm, setWidthMm] = useState(280);
  const [result, setResult] = useState<SeparationJobResult | null>(null);
  const [view, setView] = useState<'preview' | number>('preview');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const viewerRef = useRef<ZoomPanHandle>(null);
  const activeJob = useRef<number | null>(null);
  const seq = useRef(0);
  const timer = useRef<number | null>(null);

  const activeImage = useRender && renderImage !== null ? renderImage : sourceImage;
  const printSourceId = useRender ? `${sourceId}#print` : sourceId;

  const inkName = (c: RGB, i: number): { name: string; white: boolean } => {
    const luma = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
    return luma > 0.75 ? { name: t('sp.inkWhite'), white: true } : { name: t('sp.inkColor', { n: i + 1 }), white: false };
  };

  // Upload whichever image the studio is working from.
  useEffect(() => {
    if (useRender && renderImage !== null) {
      client.setSource(printSourceId, renderImage);
    } else if (!client.hasSource(sourceId)) {
      client.setSource(sourceId, sourceImage);
    }
  }, [client, useRender, renderImage, sourceImage, sourceId, printSourceId]);

  // First run: read the garment and inks straight out of the artwork.
  useEffect(() => {
    if (inks.length > 0) return;
    const buf = bufferFromRgba(activeImage.data, activeImage.width, activeImage.height);
    // The darkest cluster is dropped: that is the artwork's background, which
    // the garment replaces. Only the remaining clusters become ink.
    const guess = suggestInks(buf, 3);
    setInks(
      guess.inks.map((c, i) => {
        const { name, white } = inkName(c, i);
        const ink = newInk(c, name, i);
        // White ink is its own base; it never needs one underneath.
        return white ? { ...ink, needsUnderbase: false } : ink;
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeImage]);

  const job: PrintJob = useMemo(
    () => ({ widthMm, garment, inks, screen, underbase }),
    [widthMm, garment, inks, screen, underbase],
  );

  const run = useCallback(() => {
    if (inks.length === 0) return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    const mine = ++seq.current;
    timer.current = window.setTimeout(() => {
      if (activeJob.current !== null) client.cancel(activeJob.current);
      setBusy(true);
      setError(null);
      const { jobId, promise } = client.separate(printSourceId, job, PREVIEW_MAX);
      activeJob.current = jobId;
      promise
        .then((r) => {
          if (mine !== seq.current) return;
          activeJob.current = null;
          setResult(r);
          setBusy(false);
        })
        .catch((e: unknown) => {
          if (mine !== seq.current) return;
          activeJob.current = null;
          setBusy(false);
          const m = e instanceof Error ? e.message : String(e);
          if (m !== 'cancelled') setError(core(m));
        });
    }, 120);
  }, [client, printSourceId, job, inks.length, core]);

  useEffect(() => {
    run();
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [run]);

  // The bitmap for whichever view is selected. Films arrive as one byte per
  // pixel and are expanded to a positive here, only for the screen actually
  // being looked at, so switching tabs costs one pass instead of three.
  const viewCanvas = useMemo(() => {
    if (result === null) return null;
    if (view === 'preview') return canvasFromImage(result.preview);
    const film = result.screens[view];
    if (!film) return null;
    const img = new ImageData(film.width, film.height);
    for (let p = 0; p < film.bits.length; p++) {
      const v = film.bits[p] === 1 ? 0 : 255;
      const i = p * 4;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    return canvasFromImage(img);
  }, [result, view]);

  const viewLayers = useMemo(
    (): ViewLayer[] =>
      viewCanvas === null ? [] : [{ source: viewCanvas, x: 0, y: 0, width: viewCanvas.width, height: viewCanvas.height }],
    [viewCanvas],
  );
  const viewContent = useMemo(() => ({ width: viewCanvas?.width ?? 1, height: viewCanvas?.height ?? 1 }), [viewCanvas]);

  const setInk = (id: string, patch: Partial<Ink>): void =>
    setInks((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));

  const filmFileName = (index: number, name: string): string => `${fileName}-film-${index + 1}-${slug(core(name))}.png`;

  const exportFilm = async (index: number, invert: boolean): Promise<void> => {
    setBusy(true);
    setStatus(t('sp.renderingFilm', { n: index + 1 }));
    try {
      const film = await client.film(printSourceId, job, index, invert);
      const png = await encodePngRgba(film.image.data, film.image.width, film.image.height);
      saveFile(png, filmFileName(index, film.name), 'image/png');
      setStatus(t('sp.filmSaved', { name: core(film.name), w: film.image.width, h: film.image.height }));
    } catch (e) {
      setError(err(e));
    } finally {
      setBusy(false);
    }
  };

  /** Every film in one ZIP — one save instead of a string of downloads. */
  const exportAllFilms = async (): Promise<void> => {
    if (result === null) return;
    setBusy(true);
    try {
      const entries: ZipEntry[] = [];
      for (let i = 0; i < result.screens.length; i++) {
        setStatus(t('sp.renderingFilm', { n: i + 1 }));
        const film = await client.film(printSourceId, job, i, false);
        const png = await encodePngRgba(film.image.data, film.image.width, film.image.height);
        entries.push({ name: filmFileName(i, film.name), data: png });
      }
      saveFile(createZip(entries), `${fileName}-${t('sp.fileFilms')}.zip`, 'application/zip');
      setStatus(t('sp.allSaved', { n: entries.length }));
    } catch (e) {
      setError(err(e));
    } finally {
      setBusy(false);
    }
  };

  const exportPreview = async (): Promise<void> => {
    setBusy(true);
    setStatus(t('sp.renderingPreview'));
    try {
      const { promise } = client.separate(printSourceId, job);
      const r = await promise;
      const png = await encodePngRgba(r.preview.data, r.preview.width, r.preview.height);
      saveFile(png, `${fileName}-${t('sp.filePreview')}.png`, 'image/png');
      setStatus(t('sp.previewSaved', { w: r.preview.width, h: r.preview.height }));
    } catch (e) {
      setError(err(e));
    } finally {
      setBusy(false);
    }
  };

  useCommandHandler((command) => {
    switch (command) {
      case 'export':
        if (!busy) void exportAllFilms();
        return true;
      case 'undo':
      case 'redo':
        if (isTyping(document.activeElement)) document.execCommand(command);
        return true;
      case 'zoom-fit':
        viewerRef.current?.fit();
        return true;
      case 'zoom-100':
        viewerRef.current?.actual();
        return true;
      case 'dtf':
      case 'compare':
        return true;
      default:
        return false;
    }
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || isTyping(e.target)) return;
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (handleViewerKey(e, viewerRef.current)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const mesh = recommendedMesh(screen.lpi);
  const cellPx = screen.dpi / Math.max(1, screen.lpi);
  const garmentHex = rgbToHex(garment.r, garment.g, garment.b);
  const garmentId = GARMENTS.find((g) => rgbToHex(g.color.r, g.color.g, g.color.b) === garmentHex)?.id ?? 'custom';

  return (
    <div className="studio">
      <div className="studio-bar">
        <strong>{t('studio.title')}</strong>
        {headerExtra}
        <span className="studio-sub">{t('sp.sub')}</span>
        <span className="spacer" />
        {busy ? <span className="badge">{t('sp.calculating')}</span> : null}
        <button className="btn" onClick={onClose} title={t('common.closeEsc')}>{t('common.close')}</button>
      </div>

      <div className="studio-body">
        <div className="panel left">
          <Section title={t('dtf.source')}>
            {renderImage !== null ? (
              <div className="field">
                <div className="label"><span>{t('studio.fromWhich')}</span></div>
                <select value={useRender ? 'render' : 'source'} onChange={(e) => setUseRender(e.target.value === 'render')} aria-label={t('studio.fromWhich')}>
                  <option value="render">{t('studio.render')}</option>
                  <option value="source">{t('studio.original')}</option>
                </select>
              </div>
            ) : null}
            <div className="hint">{activeImage.width} × {activeImage.height} px</div>
            <div className="field">
              <div className="label"><span>{t('sp.garment')}</span></div>
              <select
                value={garmentId}
                aria-label={t('sp.garment')}
                onChange={(e) => {
                  const g = GARMENTS.find((x) => x.id === e.target.value);
                  if (g) setGarment(g.color);
                }}
              >
                {GARMENTS.map((g) => <option key={g.id} value={g.id}>{t(g.key)}</option>)}
                <option value="custom">{t('sp.gCustom')}</option>
              </select>
              <div className="color-field">
                <input
                  type="color"
                  className="swatch-input"
                  aria-label={t('sp.garment')}
                  value={garmentHex}
                  onChange={(e) => {
                    const [r, g, b] = hexToRgb(e.target.value);
                    setGarment({ r, g, b });
                  }}
                />
                <input type="text" readOnly aria-label={t('sp.garment')} value={garmentHex} />
              </div>
              <div className="hint">{t('sp.sub')}</div>
            </div>
            <NumberSlider
              label={t('dtf.width')}
              value={widthMm}
              min={30}
              max={500}
              step={1}
              unit="mm"
              onChange={(v) => setWidthMm(Math.round(v))}
              onCommit={() => undefined}
            />
            {result ? (
              <div className="hint">
                {t('sp.film', {
                  w: Math.round(result.widthMm),
                  h: Math.round(result.heightMm),
                  px: Math.round((widthMm / 25.4) * screen.dpi),
                  dpi: screen.dpi,
                })}
              </div>
            ) : null}
          </Section>

          <Section title={t('sp.inks', { n: inks.length })}>
            <div className="hint">{t('sp.inksHint')}</div>
            {inks.map((ink, index) => (
              <div key={ink.id} className="ink-row">
                <div className="slider-row">
                  <button
                    className="mini"
                    title={ink.enabled ? t('sp.skip') : t('sp.enable')}
                    aria-label={ink.enabled ? t('sp.skip') : t('sp.enable')}
                    aria-pressed={ink.enabled}
                    onClick={() => setInk(ink.id, { enabled: !ink.enabled })}
                  >
                    <Icon name={ink.enabled ? 'lampOn' : 'lampOff'} size={12} />
                  </button>
                  <input
                    type="color"
                    aria-label={ink.name}
                    style={{ width: 26, height: 22, padding: 0, background: 'none', border: 'none' }}
                    value={rgbToHex(ink.color.r, ink.color.g, ink.color.b)}
                    onChange={(e) => {
                      const [r, g, b] = hexToRgb(e.target.value);
                      setInk(ink.id, { color: { r, g, b } });
                    }}
                  />
                  <input type="text" aria-label={ink.name} value={ink.name} onChange={(e) => setInk(ink.id, { name: e.target.value })} />
                  <button
                    className="mini"
                    title={t('common.remove')}
                    aria-label={t('common.remove')}
                    onClick={() => setInks((prev) => prev.filter((i) => i.id !== ink.id))}
                  ><Icon name="close" size={12} /></button>
                </div>
                <label className="checkbox" style={{ marginLeft: 22 }}>
                  <input
                    type="checkbox"
                    checked={ink.needsUnderbase}
                    onChange={(e) => setInk(ink.id, { needsUnderbase: e.target.checked })}
                  />
                  <span>{t('sp.needsBase')}</span>
                </label>
                {index < inks.length - 1 ? <div className="ink-sep" /> : null}
              </div>
            ))}
            <div className="row" style={{ marginTop: 8 }}>
              <button
                className="btn"
                onClick={() => setInks((prev) => [...prev, newInk({ r: 1, g: 1, b: 1 }, t('sp.newInk'), prev.length)])}
              >{t('sp.addInk')}</button>
              <button
                className="btn"
                onClick={() => {
                  const buf = bufferFromRgba(activeImage.data, activeImage.width, activeImage.height);
                  const guess = suggestInks(buf, inks.length + 1);
                  setInks(
                    guess.inks.map((c, i) => {
                      const { name, white } = inkName(c, i);
                      const ink = newInk(c, name, i);
                      return white ? { ...ink, needsUnderbase: false } : ink;
                    }),
                  );
                }}
              >{t('sp.readInks')}</button>
            </div>
          </Section>

          <Section title={t('sp.underbase')}>
            <div className="hint">{t('sp.underbaseHint')}</div>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={underbase.enabled}
                onChange={(e) => setUnderbase({ ...underbase, enabled: e.target.checked })}
              />
              <span>{t('sp.makeBase')}</span>
            </label>
            {underbase.enabled ? (
              <>
                <NumberSlider
                  label={t('sp.choke')}
                  value={underbase.chokePx}
                  min={0}
                  max={12}
                  step={1}
                  unit="px"
                  onChange={(v) => setUnderbase({ ...underbase, chokePx: Math.round(v) })}
                  onCommit={() => undefined}
                />
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={underbase.halftoned}
                    onChange={(e) => setUnderbase({ ...underbase, halftoned: e.target.checked })}
                  />
                  <span>{t('sp.halftonedBase')}</span>
                </label>
              </>
            ) : null}
          </Section>
        </div>

        <div className="studio-canvas">
          <div className="view-tabs">
            <div className="view-scroll" role="tablist">
            <button
              role="tab"
              aria-selected={view === 'preview'}
              className={`btn${view === 'preview' ? ' active' : ''}`}
              onClick={() => setView('preview')}
            >
              {t('sp.preview')}
            </button>
            {result?.screens.map((sep, i) => (
              <button
                key={sep.id}
                role="tab"
                aria-selected={view === i}
                className={`btn${view === i ? ' active' : ''}`}
                onClick={() => setView(i)}
              >
                <span className="dot" style={{ background: rgbToHex(sep.color.r, sep.color.g, sep.color.b) }} />
                {core(sep.name)}
                <span className="cov">{(sep.coverage * 100).toFixed(0)}%</span>
              </button>
            ))}
            </div>
            <span className="spacer" />
          </div>
          <ZoomPanView
            ref={viewerRef}
            label={view === 'preview' ? t('sp.preview') : t('sp.filmNote')}
            content={viewContent}
            layers={viewLayers}
            backdrop={{ kind: 'plain' }}
            fitKey="screen"
            badge={result === null ? t('sp.calculating') : null}
          />
          <div className="film-note">
            <span>{view !== 'preview' ? t('sp.filmNote') : ''}</span>
            <span className="film-hint">{wheelMode === 'pan' ? t('view.hintPan') : t('view.hint')}</span>
          </div>
        </div>

        <div className="panel right">
          <Section title={t('sp.screen')}>
            <NumberSlider
              label={t('dtf.lpi')}
              value={screen.lpi}
              defaultValue={45}
              min={15}
              max={85}
              step={1}
              unit="LPI"
              onChange={(v) => setScreen({ ...screen, lpi: Math.round(v) })}
              onCommit={() => undefined}
            />
            <div className="hint">{t('sp.meshHint', { min: mesh.min, max: mesh.max })}</div>
            <div className="field">
              <div className="label"><span>{t('sp.filmRes')}</span></div>
              <select value={String(screen.dpi)} onChange={(e) => setScreen({ ...screen, dpi: Number(e.target.value) })} aria-label={t('sp.filmRes')}>
                <option value="300">300 DPI</option>
                <option value="600">{t('sp.dpi600')}</option>
                <option value="720">720 DPI</option>
                <option value="1200">1200 DPI</option>
              </select>
              <div className="hint">
                {t('sp.cell', { px: num(cellPx, 1) })}
                {cellPx < 4 ? t('sp.cellLow') : '.'}
              </div>
            </div>
            <div className="field">
              <div className="label"><span>{t('sp.screenType')}</span></div>
              <select value={screen.type} onChange={(e) => setScreen({ ...screen, type: e.target.value as ScreenType })} aria-label={t('sp.screenType')}>
                <option value="am">{t('sp.am')}</option>
                <option value="fm">{t('sp.fm')}</option>
              </select>
            </div>
            {screen.type === 'am' ? (
              <>
                <div className="field">
                  <div className="label"><span>{t('dtf.dotShape')}</span></div>
                  <select value={screen.shape} onChange={(e) => setScreen({ ...screen, shape: e.target.value as PrintDotShape })} aria-label={t('dtf.dotShape')}>
                    <option value="round">{t('sp.shapeRound')}</option>
                    <option value="euclidean">{t('sp.shapeEuclidean')}</option>
                    <option value="square">{t('sp.shapeSquare')}</option>
                    <option value="ellipse">{t('sp.shapeEllipse')}</option>
                    <option value="line">{t('sp.shapeLine')}</option>
                  </select>
                </div>
                <NumberSlider
                  label={t('sp.angle')}
                  value={screen.angle}
                  min={0}
                  max={90}
                  step={0.5}
                  unit="°"
                  onChange={(v) => setScreen({ ...screen, angle: v })}
                  onCommit={() => undefined}
                />
              </>
            ) : null}
          </Section>

          <Section title={t('sp.tolerances')}>
            <NumberSlider
              label={t('sp.dotGain')}
              value={screen.dotGain}
              min={0}
              max={0.5}
              step={0.01}
              onChange={(v) => setScreen({ ...screen, dotGain: v })}
              onCommit={() => undefined}
            />
            <div className="hint">{t('sp.dotGainHint')}</div>
            <NumberSlider
              label={t('sp.minDot')}
              value={screen.minDot}
              min={0.02}
              max={0.3}
              step={0.01}
              onChange={(v) => setScreen({ ...screen, minDot: v })}
              onCommit={() => undefined}
            />
            <NumberSlider
              label={t('sp.maxDot')}
              value={screen.maxDot}
              min={0.6}
              max={0.99}
              step={0.01}
              onChange={(v) => setScreen({ ...screen, maxDot: v })}
              onCommit={() => undefined}
            />
            <NumberSlider
              label={t('sp.knockoutBelow')}
              value={screen.knockoutBelow}
              min={0}
              max={0.25}
              step={0.005}
              onChange={(v) => setScreen({ ...screen, knockoutBelow: v })}
              onCommit={() => undefined}
            />
            <div className="hint">{t('sp.knockoutHint')}</div>
          </Section>

          {result ? (
            <Section title={t('sp.check')}>
              {result.notes.map((n, i) => (
                <div key={i} className={n.level === 'warn' ? 'error' : 'hint'}>
                  {n.level === 'warn' ? '⚠ ' : ''}{core(n.text)}
                </div>
              ))}
            </Section>
          ) : null}

          <Section title={t('sp.export')}>
            <div className="row">
              <button className="btn primary" disabled={busy || result === null} onClick={() => void exportAllFilms()}>
                {t('sp.saveAll')}
              </button>
            </div>
            <div className="add-grid" style={{ marginTop: 6 }}>
              {result?.screens.map((sep, i) => (
                <button key={sep.id} className="btn" disabled={busy} onClick={() => void exportFilm(i, false)}>
                  {t('sp.filmN', { n: i + 1, name: core(sep.name) })}
                </button>
              ))}
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn" disabled={busy} onClick={() => void exportPreview()}>
                {t('sp.savePreview')}
              </button>
            </div>
            <div className="hint">{t('sp.exportHint')}</div>
          </Section>

          {status ? <div className="hint panel-note">{status}</div> : null}
          {error ? <div className="error panel-note">{error}</div> : null}
        </div>
      </div>
    </div>
  );
}
