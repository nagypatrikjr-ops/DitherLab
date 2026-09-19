import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { RGB } from '../core/types';
import { createBuffer, bufferToRgba, resampleBox, toColorSpace } from '../core/buffer';
import {
  DEFAULT_TRANSFER,
  FILM_WIDTHS,
  MILKY_LIMIT,
  GARMENTS,
  LOOKS,
  MAX_PRINT_MM,
  MAX_SPOT_COLORS,
  DEFAULT_SPOT_TOLERANCE,
  PLACEMENTS,
  PRESS_SETTINGS,
  SHIRT_SIZES,
  dominantInks,
  effectiveMinDotMm,
  mmToPx,
  transferSize,
  type EdgeFadeShape,
  type Placement,
  type ShirtSize,
  type SpotCandidate,
  type SpotOther,
  type SpotSettings,
  type TransferDotShape,
  type TransferScreen,
  type TransferSettings,
  type TunePreference,
  type TuneResult,
} from '../core/transfer';
import { CLAUDE_MODEL } from '../ai/model';
import type { ClaudeProposal } from '../ai/claude';
import { imageDataToPngBase64, readLocal, scaleImageData, writeLocal } from '../ai/images';
import { hexToRgb, rgbToHex } from '../core/palette/builtin';
import { erodeDisk } from '../core/transfer/morph';
import { createZip, type ZipEntry } from '../io/zip';
import { RenderClient, type TransferAnalysisResult, type TransferPreview } from '../workers/client';
import { useI18n, type I18n, type MessageKey, type Vars } from '../i18n';
import { usePrefs } from '../state/prefs';
import { Icon } from './components/Icon';
import { NumberSlider } from './components/NumberSlider';
import { Section } from './components/Section';
import {
  ZoomPanView,
  canvasFromImage,
  handleViewerKey,
  type Backdrop,
  type ViewInfo,
  type ViewLayer,
  type ZoomPanHandle,
} from './components/ZoomPanView';
import { cropFor, rectContains, type Rect } from './viewport';
import { isTyping, useCommandHandler } from './commands';
import { loadDtfMemory, saveDtfMemory } from './dtfMemory';
import { saveFile } from './save';
import { toast } from './toasts';

interface Props {
  client: RenderClient;
  sourceId: string;
  sourceImage: ImageData;
  renderImage: ImageData | null;
  fileName: string;
  onClose: () => void;
  headerExtra?: ReactNode;
}

type View = 'shirt' | 'file' | 'background' | 'white' | 'problems' | 'detail';
type CheckLevel = TransferAnalysisResult['checks'][number]['level'];

const PREVIEW_MAX = 900;
const IN = 25.4;
/** Largest full-resolution crop fetched for a close-up, in pixels. */
const MAX_CROP_AREA = 4_000_000;
const BG_SWATCHES: readonly [string, MessageKey][] = [
  ['#000000', 'view.bgBlack'],
  ['#ffffff', 'view.bgWhite'],
  ['#808080', 'view.bgGray'],
];

const SHAPE_NAME_KEYS: Record<TransferDotShape, MessageKey> = {
  euclidean: 'dtf.shapeNameEuclidean',
  round: 'dtf.shapeNameRound',
  square: 'dtf.shapeNameSquare',
  ellipse: 'dtf.shapeNameEllipse',
};

const VIEWS: readonly [View, MessageKey][] = [
  ['shirt', 'dtf.viewShirt'],
  ['file', 'dtf.viewFile'],
  ['white', 'dtf.viewWhite'],
  ['problems', 'dtf.viewProblems'],
  ['detail', 'dtf.viewDetail'],
  ['background', 'dtf.viewBackground'],
];

function sameKnockout(a: TransferSettings['knockout'], b: TransferSettings['knockout']): boolean {
  return (
    a.enabled === b.enabled &&
    Math.abs(a.tolerance - b.tolerance) < 1e-6 &&
    Math.abs(a.solidPoint - b.solidPoint) < 1e-6 &&
    Math.abs(a.density - b.density) < 1e-6
  );
}

function recommendedWidth(pl: Placement, shirt: ShirtSize): number {
  // Published guidance: full front 9–10" on S–M, 10–12" from L up.
  if (pl.id === 'full-front' && (shirt.id === 'S' || shirt.id === 'M')) return 9.5 * IN;
  return pl.defaultMm;
}

function garmentOf(color: RGB): (typeof GARMENTS)[number] | undefined {
  const hex = rgbToHex(color.r, color.g, color.b);
  return GARMENTS.find((g) => rgbToHex(g.color.r, g.color.g, g.color.b) === hex);
}

/** Widen a crop by a margin, staying inside the file. */
function grow(r: Rect, margin: number, size: { width: number; height: number }): Rect {
  const x = Math.max(0, r.x - margin);
  const y = Math.max(0, r.y - margin);
  return {
    x,
    y,
    width: Math.min(size.width, r.x + r.width + margin) - x,
    height: Math.min(size.height, r.y + r.height + margin) - y,
  };
}

/**
 * The white underbase for one crop, computed exactly the way the preflight
 * does it: the ink eroded by the choke. The crop is fetched with a margin, so
 * the erosion sees the same neighbours it would see in the whole file.
 */
function whiteCropCanvas(img: ImageData, req: Rect, want: Rect, chokePx: number): HTMLCanvasElement {
  const ink = new Uint8Array(img.width * img.height);
  for (let p = 0; p < ink.length; p++) ink[p] = img.data[p * 4 + 3] !== 0 ? 1 : 0;
  const white = erodeDisk(ink, img.width, img.height, chokePx);
  const out = new ImageData(want.width, want.height);
  for (let y = 0; y < want.height; y++) {
    const sy = y + want.y - req.y;
    for (let x = 0; x < want.width; x++) {
      const v = white[sy * img.width + (x + want.x - req.x)] === 1 ? 255 : 0;
      const i = (y * want.width + x) * 4;
      out.data[i] = 30 + (v * 225) / 255;
      out.data[i + 1] = 30 + (v * 225) / 255;
      out.data[i + 2] = 32 + (v * 223) / 255;
      out.data[i + 3] = 255;
    }
  }
  return canvasFromImage(out);
}

/**
 * What the print looks like from a normal viewing distance: the file composited
 * over the shirt and reduced in *linear light*. A canvas scaling it down would
 * average in sRGB and show every dotted area too dark.
 */
function appearance(img: ImageData, garment: RGB, tw: number, th: number): ImageData {
  const buf = createBuffer(img.width, img.height, 'srgb');
  const d = img.data;
  for (let p = 0; p < img.width * img.height; p++) {
    const on = d[p * 4 + 3] !== 0;
    buf.data[p * 4] = on ? d[p * 4] / 255 : garment.r;
    buf.data[p * 4 + 1] = on ? d[p * 4 + 1] / 255 : garment.g;
    buf.data[p * 4 + 2] = on ? d[p * 4 + 2] / 255 : garment.b;
    buf.data[p * 4 + 3] = 1;
  }
  const small = resampleBox(toColorSpace(buf, 'linear'), Math.max(1, tw), Math.max(1, th));
  return new ImageData(bufferToRgba(small), small.width, small.height);
}

interface MockupLabels {
  width: string;
  below: string;
  footer: string;
}

function mockupLabels({ t, num }: I18n, preview: TransferPreview, shirt: ShirtSize, pl: Placement): MockupLabels {
  return {
    width: t('dtf.mockWidth', { cm: num(preview.widthMm / 10, 1), in: num(preview.widthMm / IN, 1) }),
    below: t('dtf.mockBelow', { cm: num(pl.belowCollarMm / 10, 1) }),
    footer: t('dtf.mockFooter', { id: shirt.id, cm: num(shirt.halfChestMm / 10, 1) }),
  };
}

/** A flat T-shirt with the print at its physical size and published position. */
function drawMockup(
  canvas: HTMLCanvasElement,
  preview: TransferPreview,
  s: TransferSettings,
  shirt: ShirtSize,
  pl: Placement,
  labels: MockupLabels,
  pixelRatio: number = window.devicePixelRatio || 1,
): void {
  const W = shirt.halfChestMm;
  const L = shirt.bodyLengthMm;
  const spanMm = W * 1.7;
  const topPad = W * 0.06;
  const heightMm = L + topPad * 2;
  const dpr = pixelRatio;
  const cssW = 760;
  const scale = cssW / spanMm;
  const cssH = Math.round(heightMm * scale);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const X = (mm: number): number => (spanMm / 2 + mm) * scale;
  const Y = (mm: number): number => (topPad + mm) * scale;
  const back = pl.side === 'back';
  const neckHalf = 0.18 * W;
  const neckDrop = back ? 0.04 * W : 0.14 * W;

  const garmentHex = rgbToHex(s.garment.r, s.garment.g, s.garment.b);
  ctx.beginPath();
  ctx.moveTo(X(-neckHalf), Y(0));
  ctx.quadraticCurveTo(X(0), Y(neckDrop * 2), X(neckHalf), Y(0));
  ctx.lineTo(X(0.53 * W), Y(0.05 * W));
  ctx.lineTo(X(0.8 * W), Y(0.3 * W));
  ctx.lineTo(X(0.68 * W), Y(0.45 * W));
  ctx.lineTo(X(0.5 * W), Y(0.37 * W));
  ctx.lineTo(X(0.5 * W), Y(L));
  ctx.lineTo(X(-0.5 * W), Y(L));
  ctx.lineTo(X(-0.5 * W), Y(0.37 * W));
  ctx.lineTo(X(-0.68 * W), Y(0.45 * W));
  ctx.lineTo(X(-0.8 * W), Y(0.3 * W));
  ctx.lineTo(X(-0.53 * W), Y(0.05 * W));
  ctx.closePath();
  ctx.fillStyle = garmentHex;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(X(-neckHalf), Y(0));
  ctx.quadraticCurveTo(X(0), Y(neckDrop * 2), X(neckHalf), Y(0));
  ctx.lineWidth = Math.max(2, 0.018 * W * scale);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.stroke();

  // Print position: published offsets below the collar seam.
  const pw = preview.widthMm * scale;
  const ph = preview.heightMm * scale;
  let left: number;
  let top: number;
  if (pl.side === 'sleeve') {
    left = X(-0.64 * W) - pw / 2;
    top = Y(0.31 * W) - ph / 2;
  } else {
    left = X(pl.offsetMm) - pw / 2;
    top = Y(neckDrop + pl.belowCollarMm);
  }
  const img = appearance(preview.image, s.garment, Math.round(pw * dpr), Math.round(ph * dpr));
  const off = document.createElement('canvas');
  off.width = img.width;
  off.height = img.height;
  off.getContext('2d')?.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(off, left, top, pw, ph);

  ctx.fillStyle = 'rgba(220,220,222,0.75)';
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(labels.width, left + pw / 2, top + ph + 16);
  if (pl.side !== 'sleeve') {
    ctx.textAlign = 'left';
    ctx.fillText(labels.below, X(0.54 * W), Y(neckDrop + pl.belowCollarMm) + 4);
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(220,220,222,0.45)';
  ctx.fillText(labels.footer, cssW / 2, cssH - 6);
}

/**
 * DTF transfer studio: from any image to a print-ready transparent PNG for
 * white-underbase heat-press transfers, with the black of the design knocked
 * out so the shirt supplies it.
 */
export function TransferStudio({
  client, sourceId, sourceImage, renderImage, fileName, onClose, headerExtra,
}: Props): JSX.Element {
  const i18n = useI18n();
  const { t, core, num, err } = i18n;
  const simple = usePrefs((p) => p.dtfSimple);
  // The garment extras (mockup, placement, pressing) are a preview of where the
  // transfer ends up, not part of making it, so they are off unless asked for.
  const garmentMode = usePrefs((p) => p.dtfGarment);
  const garmentRef = useRef(garmentMode);
  garmentRef.current = garmentMode;
  const wheelMode = usePrefs((p) => p.wheelMode);
  const setPref = usePrefs((p) => p.setPref);

  // The user's own last choices (shirt, size, placement…), if they want them remembered.
  const memory = useMemo(() => (usePrefs.getState().rememberDtf ? loadDtfMemory() : {}), []);
  const [s, setS] = useState<TransferSettings>(() => ({
    ...DEFAULT_TRANSFER,
    garment: memory.garment ?? DEFAULT_TRANSFER.garment,
    widthMm: memory.widthMm ?? DEFAULT_TRANSFER.widthMm,
    dpi: memory.dpi ?? DEFAULT_TRANSFER.dpi,
  }));
  const [placementId, setPlacementId] = useState(() =>
    memory.placementId !== undefined && PLACEMENTS.some((p) => p.id === memory.placementId) ? memory.placementId : 'full-front',
  );
  const [shirtId, setShirtId] = useState(() =>
    memory.shirtId !== undefined && SHIRT_SIZES.some((x) => x.id === memory.shirtId) ? memory.shirtId : 'L',
  );
  const [fabricId, setFabricId] = useState(() =>
    memory.fabricId !== undefined && PRESS_SETTINGS.some((x) => x.id === memory.fabricId) ? memory.fabricId : 'cotton',
  );
  const [useRender, setUseRender] = useState(false);
  const [view, setView] = useState<View>(() => (usePrefs.getState().dtfGarment ? 'shirt' : 'background'));
  const [preview, setPreview] = useState<TransferPreview | null>(null);
  const [analysis, setAnalysis] = useState<TransferAnalysisResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [bgColor, setBgColor] = useState<string | null>(() => readLocal('ditherlab.viewBg'));
  const [crop, setCrop] = useState<{
    rect: Rect;
    canvas: HTMLCanvasElement;
    forS: TransferSettings;
    forSource: string;
    kind: 'color' | 'white';
  } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // Colours read off the print, for the ink filter. They have to come from a
  // render the filter has not already narrowed, so the last unfiltered one is
  // kept aside rather than read back out of whatever is on screen.
  const [inkCandidates, setInkCandidates] = useState<SpotCandidate[] | null>(null);
  const unfiltered = useRef<Uint8ClampedArray | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  // The error line sits at the foot of a panel that is often scrolled away
  // from it; a failure the user cannot see is indistinguishable from nothing
  // happening, so every new error is also raised as a notification.
  const lastToasted = useRef<string | null>(null);
  useEffect(() => {
    // A preview that fails the same way on every slider move is one problem,
    // not one notification per move.
    if (error !== null && error !== lastToasted.current) toast('error', error);
    lastToasted.current = error ?? lastToasted.current;
  }, [error]);
  const [heavy, setHeavy] = useState<RenderClient | null>(null);

  // Automatic settings: the measurable part runs locally for every image.
  const [autoTuneOn, setAutoTuneOn] = useState(true);
  const [preference, setPreference] = useState<TunePreference>(memory.preference ?? 'balanced');
  const [tune, setTune] = useState<TuneResult | null>(null);
  const [tuning, setTuning] = useState(false);
  const [tuneNonce, setTuneNonce] = useState(0);

  // Claude review: opt-in, with the user's own key, kept on this computer only.
  const [claudeKey, setClaudeKey] = useState<string>(() => readLocal('ditherlab.claude.key') ?? '');
  const [keyDraft, setKeyDraft] = useState('');
  const [claudeConsent, setClaudeConsent] = useState<boolean>(() => readLocal('ditherlab.claude.consent') === '1');
  const [claudeAuto, setClaudeAuto] = useState<boolean>(() => readLocal('ditherlab.claude.auto') !== '0');
  const [claudeBusy, setClaudeBusy] = useState(false);
  const [claudeResult, setClaudeResult] = useState<
    { proposal: ClaudeProposal; applied: boolean; note: { key: MessageKey; vars?: Vars } } | null
  >(null);
  const [claudeError, setClaudeError] = useState<string | null>(null);

  const viewerRef = useRef<ZoomPanHandle>(null);
  const checkRef = useRef<HTMLDivElement>(null);

  const activeImage = useRender && renderImage !== null ? renderImage : sourceImage;
  const dtfSourceId = useRender ? `${sourceId}#dtf` : sourceId;
  const aspect = activeImage.width / activeImage.height;
  useEffect(() => {
    if (!garmentMode) setView((v) => (v === 'shirt' ? 'background' : v));
  }, [garmentMode]);

  const shirt = SHIRT_SIZES.find((x) => x.id === shirtId) ?? SHIRT_SIZES[2];
  const placement = PLACEMENTS.find((x) => x.id === placementId) ?? PLACEMENTS[0];
  const press = PRESS_SETTINGS.find((x) => x.id === fabricId) ?? PRESS_SETTINGS[0];
  const full = transferSize(s, aspect);

  // Remember the user's own choices for next time.
  useEffect(() => {
    if (!usePrefs.getState().rememberDtf) return;
    saveDtfMemory({ garment: s.garment, shirtId, fabricId, placementId, widthMm: s.widthMm, dpi: s.dpi, preference });
  }, [s.garment, shirtId, fabricId, placementId, s.widthMm, s.dpi, preference]);

  // A second worker takes the full-resolution checks and exports, so the
  // interactive preview never queues behind a multi-second job.
  useEffect(() => {
    const c = new RenderClient();
    setHeavy(c);
    return () => c.dispose();
  }, []);

  useEffect(() => {
    for (const c of [client, heavy]) {
      if (c === null) continue;
      if (useRender) c.setSource(dtfSourceId, activeImage);
      else if (!c.hasSource(sourceId)) c.setSource(sourceId, activeImage);
    }
  }, [client, heavy, useRender, activeImage, dtfSourceId, sourceId]);

  const frame = useMemo(() => {
    const k = Math.min(1, PREVIEW_MAX / Math.max(full.width, full.height));
    return {
      width: Math.max(1, Math.round(full.width * k)),
      height: Math.max(1, Math.round(full.height * k)),
    };
  }, [full.width, full.height]);

  // ---- Preview: latest request wins, at most one in flight ----------------
  const previewInFlight = useRef(false);
  const previewPending = useRef<(() => void) | null>(null);
  const runPreview = useCallback(() => {
    const go = (): void => {
      previewInFlight.current = true;
      client
        .transfer(dtfSourceId, s, { maxDimension: PREVIEW_MAX })
        .then((r) => {
          setPreview(r);
          setError(null);
        })
        .catch((e: unknown) => setError(i18nRef.current.err(e)))
        .finally(() => {
          previewInFlight.current = false;
          const next = previewPending.current;
          previewPending.current = null;
          if (next) next();
        });
    };
    if (previewInFlight.current) previewPending.current = go;
    else go();
  }, [client, dtfSourceId, s]);

  const i18nRef = useRef(i18n);
  i18nRef.current = i18n;

  useEffect(() => {
    const timer = window.setTimeout(runPreview, 120);
    return () => window.clearTimeout(timer);
  }, [runPreview]);

  // ---- Full-resolution preflight ------------------------------------------
  const analysisInFlight = useRef(false);
  const analysisPending = useRef<(() => void) | null>(null);
  const runAnalysis = useCallback(() => {
    if (heavy === null) return;
    const go = (): void => {
      analysisInFlight.current = true;
      setAnalyzing(true);
      heavy
        .transferAnalyze(dtfSourceId, s, garmentRef.current ? { shirtId, placementId } : {}, frame)
        .then((a) => setAnalysis(a))
        .catch((e: unknown) => setError(i18nRef.current.err(e)))
        .finally(() => {
          analysisInFlight.current = false;
          const next = analysisPending.current;
          analysisPending.current = null;
          if (next) next();
          else setAnalyzing(false);
        });
    };
    if (analysisInFlight.current) analysisPending.current = go;
    else go();
  }, [heavy, dtfSourceId, s, shirtId, placementId, garmentMode, frame]);

  useEffect(() => {
    const timer = window.setTimeout(runAnalysis, 700);
    return () => window.clearTimeout(timer);
  }, [runAnalysis]);

  // ---- Automatic settings ----------------------------------------------------
  const claudeReady = claudeKey.trim() !== '' && claudeConsent;
  const sRef = useRef(s);
  sRef.current = s;

  const runClaude = useCallback(
    async (result: TuneResult): Promise<void> => {
      if (heavy === null || !claudeReady) return;
      setClaudeBusy(true);
      setClaudeError(null);
      const tr = i18nRef.current;
      try {
        const cur = sRef.current;
        const tunedNow: TransferSettings = {
          ...cur,
          knockout: result.settings.knockout,
          screen: { ...cur.screen, lpi: result.settings.screen.lpi },
        };
        const prev = await client.transfer(dtfSourceId, tunedNow, { maxDimension: PREVIEW_MAX });
        const k = Math.min(1, 768 / Math.max(prev.width, prev.height));
        const shirtView = appearance(
          prev.image,
          cur.garment,
          Math.max(1, Math.round(prev.width * k)),
          Math.max(1, Math.round(prev.height * k)),
        );
        const garmentName = tr.core(garmentOf(cur.garment)?.name ?? 'Egyedi');
        const maxLpi = (() => {
          const eff = effectiveMinDotMm(cur);
          for (const lpi of [55, 50, 45, 40, 35, 30, 25, 20]) {
            if ((Math.PI / 4) * (eff / (25.4 / lpi)) ** 2 <= 0.5) return lpi;
          }
          return 20;
        })();
        // Loaded on first use: the SDK stays out of the bundle for anyone who never enables Claude.
        const { reviewWithClaude, applyProposal } = await import('../ai/claude');
        const proposal = await reviewWithClaude({
          apiKey: claudeKey.trim(),
          language: tr.lang,
          originalPng: await imageDataToPngBase64(scaleImageData(activeImage, 768)),
          onShirtPng: await imageDataToPngBase64(shirtView),
          tune: result,
          checks: analysis?.checks ?? [],
          current: tunedNow,
          maxLpi,
          context: {
            garmentName,
            garmentHex: rgbToHex(cur.garment.r, cur.garment.g, cur.garment.b),
            shirtSize: shirt.id,
            placementName: tr.core(placement.name),
            widthMm: cur.widthMm,
            heightMm: transferSize(cur, aspect).heightMm,
            fabric: tr.core(press.fabric),
          },
        });
        const proposed = applyProposal(proposal, { ...result, settings: tunedNow });
        // Trust, then verify: re-measure before anything changes.
        const m = await heavy.transferEvaluate(dtfSourceId, proposed);
        const milkyOk = m.milky <= Math.max(MILKY_LIMIT, result.metrics.milky) + 0.005;
        const toneOk = m.toneError <= result.metrics.toneError + 0.01;
        if (milkyOk && toneOk) {
          setS((prevS) => ({
            ...prevS,
            knockout: proposed.knockout,
            edgeFade: proposed.edgeFade,
            adjust: proposed.adjust,
            screen: { ...prevS.screen, lpi: proposed.screen.lpi },
          }));
          setClaudeResult({ proposal, applied: true, note: { key: 'claude.applied', vars: { milky: Math.round(m.milky * 100) } } });
        } else {
          setClaudeResult({
            proposal,
            applied: false,
            note: !milkyOk
              ? { key: 'claude.rejectedMilky', vars: { milky: Math.round(m.milky * 100) } }
              : { key: 'claude.rejectedTone' },
          });
        }
      } catch (e) {
        setClaudeError(tr.err(e));
      } finally {
        setClaudeBusy(false);
      }
    },
    // analysis is read for context only; re-creating on every analysis would re-trigger nothing
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [heavy, claudeReady, claudeKey, client, dtfSourceId, activeImage, shirt, placement, press, aspect],
  );

  const runTune = useCallback(async (): Promise<void> => {
    if (heavy === null) return;
    setTuning(true);
    try {
      const result = await heavy.transferTune(dtfSourceId, sRef.current, preference);
      setTune(result);
      setClaudeResult(null);
      setS((prevS) => ({
        ...prevS,
        knockout: result.settings.knockout,
        screen: { ...prevS.screen, lpi: prevS.screen.kind === 'am' ? result.settings.screen.lpi : prevS.screen.lpi },
      }));
      if (claudeReady && claudeAuto) void runClaude(result);
    } catch (e) {
      setError(i18nRef.current.err(e));
    } finally {
      setTuning(false);
    }
  }, [heavy, dtfSourceId, preference, claudeReady, claudeAuto, runClaude]);

  const garmentKey = rgbToHex(s.garment.r, s.garment.g, s.garment.b);
  useEffect(() => {
    if (!autoTuneOn || heavy === null) return;
    void runTune();
    // Re-tune when the image, the shirt or the preference changes — not on
    // every slider move, which would overwrite the user's own adjustments.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoTuneOn, heavy, dtfSourceId, garmentKey, preference, s.chokeMm, s.dpi, tuneNonce]);

  // ---- Ink filter: the colours the print actually uses --------------------
  const spotActive = s.spot.enabled && s.spot.colors.length > 0;
  useEffect(() => {
    if (preview === null || spotActive) return;
    unfiltered.current = preview.image.data;
  }, [preview, spotActive]);

  useEffect(() => {
    unfiltered.current = null;
    setInkCandidates(null);
  }, [dtfSourceId]);

  useEffect(() => {
    if (!s.spot.enabled || inkCandidates !== null || unfiltered.current === null) return;
    setInkCandidates(dominantInks(unfiltered.current, 6));
  }, [s.spot.enabled, inkCandidates, preview]);

  const saveKey = (): void => {
    const k = keyDraft.trim();
    if (k === '') return;
    setClaudeKey(k);
    writeLocal('ditherlab.claude.key', k);
    setKeyDraft('');
  };

  // ---- Viewer: what each view shows, and full-resolution close-ups --------
  const bgHex = bgColor ?? garmentKey;
  const lastView = useRef<ViewInfo | null>(null);
  const detailCenter = useRef({ x: 0, y: 0 });
  const cropSeq = useRef(0);
  const cropTimer = useRef<number | null>(null);

  const previewCanvas = useMemo(() => (preview === null ? null : canvasFromImage(preview.image)), [preview]);

  const overlayCanvas = useMemo(() => {
    if (preview === null || (view !== 'white' && view !== 'problems')) return null;
    const ok = analysis !== null && analysis.overlayWidth === preview.width && analysis.overlayHeight === preview.height;
    const img = new ImageData(preview.width, preview.height);
    const n = preview.width * preview.height;
    if (view === 'white') {
      for (let p = 0; p < n; p++) {
        const v = ok && analysis ? analysis.white[p] : 0;
        img.data[p * 4] = 30 + (v * 225) / 255;
        img.data[p * 4 + 1] = 30 + (v * 225) / 255;
        img.data[p * 4 + 2] = 32 + (v * 223) / 255;
        img.data[p * 4 + 3] = 255;
      }
      return canvasFromImage(img);
    }
    for (let p = 0; p < n; p++) {
      const on = preview.image.data[p * 4 + 3] !== 0;
      let r = on ? preview.image.data[p * 4] * 0.35 + 20 : 24;
      let g = on ? preview.image.data[p * 4 + 1] * 0.35 + 20 : 24;
      let b = on ? preview.image.data[p * 4 + 2] * 0.35 + 22 : 26;
      if (ok && analysis) {
        if (analysis.milky[p] === 1) {
          r = 40;
          g = 200;
          b = 230;
        }
        if (analysis.thin[p] === 1) {
          r = 255;
          g = 160;
          b = 0;
        }
        if (analysis.unsupported[p] === 1) {
          r = 255;
          g = 40;
          b = 60;
        }
      }
      img.data[p * 4] = r;
      img.data[p * 4 + 1] = g;
      img.data[p * 4 + 2] = b;
      img.data[p * 4 + 3] = 255;
    }
    return canvasFromImage(img);
  }, [view, preview, analysis]);

  const mockup = useMemo(() => {
    if (preview === null || view !== 'shirt') return null;
    const canvas = document.createElement('canvas');
    // Drawn at 2× at least, so it stays crisp when zoomed in.
    drawMockup(
      canvas,
      preview,
      s,
      shirt,
      placement,
      mockupLabels(i18n, preview, shirt, placement),
      Math.max(2, window.devicePixelRatio || 1),
    );
    return { canvas, width: parseFloat(canvas.style.width), height: parseFloat(canvas.style.height) };
  }, [view, preview, s, shirt, placement, i18n]);

  const cropKind: 'color' | 'white' | null =
    view === 'white' ? 'white' : view === 'file' || view === 'background' || view === 'detail' ? 'color' : null;

  // Zooming past the preview's own resolution fetches the real pixels for the
  // visible part, so the dots on screen are the dots that will be printed.
  const requestDetail = useRef<() => void>(() => undefined);
  requestDetail.current = () => {
    const v = lastView.current;
    if (v === null || preview === null || cropKind === null) return;
    if (v.zoom * (full.width / preview.width) <= 1.1) return;
    if (
      crop !== null &&
      crop.forS === s &&
      crop.forSource === dtfSourceId &&
      crop.kind === cropKind &&
      rectContains(crop.rect, v.visible)
    ) {
      return;
    }
    const want = cropFor(v.visible, full, 96, MAX_CROP_AREA);
    if (want === null) return;
    const chokePx = mmToPx(s.chokeMm, s.dpi);
    const req = cropKind === 'white' ? grow(want, Math.ceil(chokePx) + 2, full) : want;
    const seq = ++cropSeq.current;
    const forS = s;
    const forSource = dtfSourceId;
    const kind = cropKind;
    setDetailLoading(true);
    client
      .transfer(forSource, forS, { crop: req })
      .then((r) => {
        if (seq !== cropSeq.current) return;
        setCrop({
          rect: kind === 'white' ? want : req,
          canvas: kind === 'white' ? whiteCropCanvas(r.image, req, want, chokePx) : canvasFromImage(r.image),
          forS,
          forSource,
          kind,
        });
      })
      .catch((e: unknown) => setError(i18nRef.current.err(e)))
      .finally(() => {
        if (seq === cropSeq.current) setDetailLoading(false);
      });
  };

  const scheduleDetail = useCallback((delay: number) => {
    if (cropTimer.current !== null) window.clearTimeout(cropTimer.current);
    cropTimer.current = window.setTimeout(() => requestDetail.current(), delay);
  }, []);

  const onViewChange = useCallback(
    (v: ViewInfo) => {
      lastView.current = v;
      scheduleDetail(180);
    },
    [scheduleDetail],
  );

  // New settings, another image or another view: fetch a fresh close-up.
  useEffect(() => {
    scheduleDetail(280);
  }, [s, dtfSourceId, view, scheduleDetail]);

  useEffect(
    () => () => {
      if (cropTimer.current !== null) window.clearTimeout(cropTimer.current);
    },
    [],
  );

  // "Detail 1:1" opens at real print pixels, around the middle of the last view.
  useEffect(() => {
    if (view === 'detail') viewerRef.current?.centerOn(detailCenter.current.x, detailCenter.current.y, 1);
  }, [view]);

  const viewLayers = useMemo((): ViewLayer[] => {
    if (view === 'shirt') {
      return mockup === null
        ? []
        : [{ source: mockup.canvas, x: 0, y: 0, width: mockup.width, height: mockup.height, smooth: true }];
    }
    const base = view === 'white' || view === 'problems' ? overlayCanvas : previewCanvas;
    const out: ViewLayer[] = [];
    if (base !== null) out.push({ source: base, x: 0, y: 0, width: full.width, height: full.height });
    if (crop !== null && cropKind !== null && crop.kind === cropKind && crop.forS === s && crop.forSource === dtfSourceId) {
      out.push({ source: crop.canvas, x: crop.rect.x, y: crop.rect.y, width: crop.rect.width, height: crop.rect.height });
    }
    return out;
  }, [view, mockup, overlayCanvas, previewCanvas, full.width, full.height, crop, cropKind, s, dtfSourceId]);

  const viewContent = useMemo(
    () =>
      view === 'shirt'
        ? { width: mockup?.width ?? 760, height: mockup?.height ?? 900 }
        : { width: full.width, height: full.height },
    [view, mockup, full.width, full.height],
  );

  const backdrop: Backdrop =
    view === 'file'
      ? { kind: 'checker' }
      : view === 'background'
        ? { kind: 'color', color: bgHex }
        : view === 'detail'
          ? { kind: 'color', color: garmentKey }
          : { kind: 'plain' };

  const chooseView = (next: View): void => {
    if (next === 'detail') {
      const v = lastView.current;
      detailCenter.current =
        v !== null && view !== 'shirt'
          ? { x: v.visible.x + v.visible.width / 2, y: v.visible.y + v.visible.height / 2 }
          : { x: full.width / 2, y: full.height / 2 };
    }
    setView(next);
  };

  const chooseBackground = (color: string | null): void => {
    setBgColor(color);
    writeLocal('ditherlab.viewBg', color);
  };

  const patch = (next: Partial<TransferSettings>): void => setS((prev) => ({ ...prev, ...next }));
  const patchKo = (next: Partial<TransferSettings['knockout']>): void =>
    setS((prev) => ({ ...prev, knockout: { ...prev.knockout, ...next } }));
  const patchScreen = (next: Partial<TransferSettings['screen']>): void =>
    setS((prev) => ({ ...prev, screen: { ...prev.screen, ...next } }));
  const patchAdjust = (next: Partial<TransferSettings['adjust']>): void =>
    setS((prev) => ({ ...prev, adjust: { ...prev.adjust, ...next } }));
  const patchSpot = (next: Partial<SpotSettings>): void =>
    setS((prev) => ({ ...prev, spot: { ...prev.spot, ...next } }));

  const inkHex = (c: RGB): string => rgbToHex(c.r, c.g, c.b);
  const setInk = (i: number, hex: string): void =>
    setS((prev) => {
      const [r, g, b] = hexToRgb(hex);
      const colors = prev.spot.colors.map((c, k) => (k === i ? { r, g, b } : c));
      return { ...prev, spot: { ...prev.spot, colors } };
    });
  const removeInk = (i: number): void =>
    setS((prev) => ({ ...prev, spot: { ...prev.spot, colors: prev.spot.colors.filter((_, k) => k !== i) } }));
  const addInk = (): void =>
    setS((prev) => {
      if (prev.spot.colors.length >= MAX_SPOT_COLORS) return prev;
      // Offer the most-used colour that is not on the list yet; failing that,
      // white, which is the one ink every dark-shirt transfer already carries.
      const taken = new Set(prev.spot.colors.map(inkHex));
      const next = (inkCandidates ?? []).find((c) => !taken.has(inkHex(c.color)))?.color ?? { r: 1, g: 1, b: 1 };
      return { ...prev, spot: { ...prev.spot, colors: [...prev.spot.colors, next] } };
    });
  const toggleInk = (c: RGB): void =>
    setS((prev) => {
      const hex = inkHex(c);
      const has = prev.spot.colors.some((x) => inkHex(x) === hex);
      const colors = has
        ? prev.spot.colors.filter((x) => inkHex(x) !== hex)
        : prev.spot.colors.length >= MAX_SPOT_COLORS
          ? prev.spot.colors
          : [...prev.spot.colors, c];
      return { ...prev, spot: { ...prev.spot, colors } };
    });

  const choosePlacement = (id: string): void => {
    const pl = PLACEMENTS.find((x) => x.id === id);
    if (!pl) return;
    setPlacementId(id);
    patch({ widthMm: Math.round(recommendedWidth(pl, shirt)) });
  };

  const resetToRecommended = (): void => {
    // The ink filter is the user's own colour choice, not a print setting the
    // recommendations have an opinion about, so it survives the reset.
    setS((prev) => ({ ...DEFAULT_TRANSFER, garment: prev.garment, widthMm: prev.widthMm, dpi: prev.dpi, spot: prev.spot }));
    setPreference('balanced');
    setAutoTuneOn(true);
    setTuneNonce((n) => n + 1);
    toast('success', t('dtf.resetDone'));
  };

  // ---- Files --------------------------------------------------------------------
  const printFileName = (format: 'png' | 'tiff'): string =>
    `${fileName}_${Math.round(full.heightMm) > 0 ? `${Math.round(s.widthMm)}x${Math.round(full.heightMm)}mm` : ''}` +
    `_${s.dpi}dpi_DTF${s.mirror ? `_${t('dtf.fileMirrored')}` : ''}.${format === 'png' ? 'png' : 'tif'}`;

  const exportFile = async (format: 'png' | 'tiff'): Promise<void> => {
    if (heavy === null) return;
    setBusy(true);
    setStatus(t('dtf.rendering'));
    try {
      const f = await heavy.transferExport(dtfSourceId, s, format);
      const name = printFileName(format);
      saveFile(f.bytes, name, format === 'png' ? 'image/png' : 'image/tiff');
      setStatus(t('dtf.saved', { name, w: f.width, h: f.height, mb: num(f.bytes.length / 1e6, 1) }));
    } catch (e) {
      setError(err(e));
    } finally {
      setBusy(false);
    }
  };

  const mockupBlob = (): Promise<Blob | null> =>
    new Promise((resolve) => {
      if (preview === null) {
        resolve(null);
        return;
      }
      const c = document.createElement('canvas');
      drawMockup(c, preview, s, shirt, placement, mockupLabels(i18n, preview, shirt, placement));
      c.toBlob((blob) => resolve(blob), 'image/png');
    });

  const exportMockup = async (): Promise<void> => {
    const blob = await mockupBlob();
    if (blob) saveFile(blob, `${fileName}_${t('dtf.fileMockup')}.png`, 'image/png');
  };

  const ticketText = (pngName: string): string => {
    const eff = effectiveMinDotMm(s);
    const mark = (l: CheckLevel): string => (l === 'ok' ? 'OK' : l === 'info' ? 'i' : l === 'warn' ? '!' : t('ticket.error'));
    const title = t('ticket.title');
    const lines = [
      title,
      '='.repeat(title.length),
      t('ticket.file', { name: pngName }),
      t('ticket.size', {
        w: num(s.widthMm / 10, 1),
        h: num(full.heightMm / 10, 1),
        wi: num(s.widthMm / IN, 1),
        hi: num(full.heightMm / IN, 1),
        pw: full.width,
        ph: full.height,
        dpi: s.dpi,
      }),
      s.mirror ? t('ticket.mirrorYes') : t('ticket.mirrorNo'),
      '',
      t('ticket.base', {
        name: core(garmentOf(s.garment)?.name ?? 'Egyedi'),
        hex: rgbToHex(s.garment.r, s.garment.g, s.garment.b),
      }),
      ...(garmentMode
        ? [
            t('ticket.shirtSize', { size: shirt.id }),
            t('ticket.placement', { name: core(placement.name), note: core(placement.note) }),
          ]
        : []),
      '',
      s.knockout.enabled
        ? t('ticket.knockoutOn', {
            tol: Math.round(s.knockout.tolerance * 100),
            solid: Math.round(s.knockout.solidPoint * 100),
          })
        : t('ticket.knockoutOff'),
      ...(spotActive ? [t('ticket.inks', { list: s.spot.colors.map(inkHex).join(', ') })] : []),
      s.screen.kind === 'am'
        ? t('ticket.screenAm', { lpi: s.screen.lpi, angle: num(s.screen.angle, 1), shape: t(SHAPE_NAME_KEYS[s.screen.shape]) })
        : t('ticket.screenFm'),
      t('ticket.minDot', { mm: num(eff, 2) }),
      t('ticket.choke', { mm: num(s.chokeMm, 2), px: num(mmToPx(s.chokeMm, 300), 1) }),
      '',
      ...(garmentMode
        ? [
        t('ticket.press', { fabric: core(press.fabric) }),
        t('ticket.temp', { c1: press.tempC[0], c2: press.tempC[1], f1: press.tempF[0], f2: press.tempF[1] }),
        t('ticket.time', { s1: press.seconds[0], s2: press.seconds[1] }),
        t('ticket.pressure', { v: core(press.pressure) }),
        t('ticket.peel', { v: core(press.peel) }),
        t('ticket.finish', { v: core(press.finish) }),
        t('ticket.datasheet'),
        '',
          ]
        : []),
      t('ticket.checks'),
      ...(analysis?.checks ?? []).map((c) => `  [${mark(c.level)}] ${core(c.title)} — ${core(c.detail)}`),
      '',
    ];
    // BOM: older Windows editors then read the accents correctly.
    return `﻿${lines.join('\n')}`;
  };

  const exportTicket = (): void => {
    saveFile(ticketText(printFileName('png')), `${fileName}_${t('dtf.fileTicket')}.txt`, 'text/plain;charset=utf-8');
  };

  const exportPackage = async (): Promise<void> => {
    if (heavy === null) return;
    setBusy(true);
    setStatus(t('dtf.packaging'));
    try {
      const f = await heavy.transferExport(dtfSourceId, s, 'png');
      const pngName = printFileName('png');
      const entries: ZipEntry[] = [{ name: pngName, data: f.bytes }];
      const mock = garmentMode ? await mockupBlob() : null;
      if (mock) entries.push({ name: `${fileName}_${t('dtf.fileMockup')}.png`, data: new Uint8Array(await mock.arrayBuffer()) });
      entries.push({ name: `${fileName}_${t('dtf.fileTicket')}.txt`, data: ticketText(pngName) });
      const zip = createZip(entries);
      const zipName = `${fileName}_${t('dtf.filePackage')}.zip`;
      saveFile(zip, zipName, 'application/zip');
      setStatus(t('dtf.saved', { name: zipName, w: f.width, h: f.height, mb: num(zip.length / 1e6, 1) }));
    } catch (e) {
      setError(err(e));
    } finally {
      setBusy(false);
    }
  };

  // ---- Keyboard & menu ------------------------------------------------------------
  useCommandHandler((command) => {
    switch (command) {
      case 'export':
        if (!busy && heavy !== null) void exportFile('png');
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

  // ---- Summary banner -----------------------------------------------------------
  const errorCount = analysis?.checks.filter((c) => c.level === 'error').length ?? 0;
  const warnCount = analysis?.checks.filter((c) => c.level === 'warn').length ?? 0;
  const banner: { kind: 'pending' | 'ok' | 'warn' | 'error'; title: string; text: string } =
    analysis === null
      ? { kind: 'pending', title: t('dtf.statusChecking'), text: '' }
      : errorCount > 0
        ? {
            kind: 'error',
            title: errorCount === 1 ? t('dtf.statusError.one') : t('dtf.statusError.other', { n: errorCount }),
            text: t('dtf.statusErrorText'),
          }
        : warnCount > 0
          ? {
              kind: 'warn',
              title: warnCount === 1 ? t('dtf.statusWarn.one') : t('dtf.statusWarn.other', { n: warnCount }),
              text: t('dtf.statusWarnText'),
            }
          : { kind: 'ok', title: t('dtf.statusReady'), text: t('dtf.statusReadyText') };

  const showProblems = (): void => {
    setView('problems');
    checkRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const eff = effectiveMinDotMm(s);
  const activeLook = LOOKS.find((l) => sameKnockout(l.knockout, s.knockout))?.id ?? null;
  const garmentId = garmentOf(s.garment)?.id ?? 'custom';
  const films = FILM_WIDTHS.filter((f) => s.widthMm <= f.mm).map((f) => core(f.name)).join(', ');

  return (
    <div className="studio">
      <div className="studio-bar">
        <strong>{t('studio.title')}</strong>
        {headerExtra}
        <span className="studio-sub">{t('dtf.sub')}</span>
        <span className="spacer" />
        <div className="seg" role="group" title={t('dtf.modeTitle')}>
          <button className={`btn${simple ? ' active' : ''}`} aria-pressed={simple} onClick={() => setPref('dtfSimple', true)}>
            {t('dtf.simple')}
          </button>
          <button className={`btn${!simple ? ' active' : ''}`} aria-pressed={!simple} onClick={() => setPref('dtfSimple', false)}>
            {t('dtf.advanced')}
          </button>
        </div>
        {busy ? <span className="badge">{t('dtf.working')}</span> : null}
        <button className="btn" onClick={onClose} title={t('common.closeEsc')}>{t('common.close')}</button>
      </div>

      <div className="studio-body">
        <div className="panel left">
          <Section title={t('dtf.source')}>
            {renderImage !== null ? (
              <div className="field">
                <div className="label"><span>{t('studio.fromWhich')}</span></div>
                <select value={useRender ? 'render' : 'source'} onChange={(e) => setUseRender(e.target.value === 'render')} aria-label={t('studio.fromWhich')}>
                  <option value="source">{t('studio.original')}</option>
                  <option value="render">{t('studio.render')}</option>
                </select>
              </div>
            ) : null}
            <div className="hint">
              {t('dtf.dpiAtSize', {
                w: activeImage.width,
                h: activeImage.height,
                dpi: Math.round(activeImage.width / (Math.min(MAX_PRINT_MM, s.widthMm) / IN)),
              })}
            </div>
            <div className="hint">{t('dtf.whereEffects')}</div>
          </Section>

          <Section title={t('dtf.shirt')}>
            <div className="field">
              <div className="label"><span>{t('dtf.shirtColor')}</span></div>
              <select
                value={garmentId}
                aria-label={t('dtf.shirtColor')}
                onChange={(e) => {
                  const g = GARMENTS.find((x) => x.id === e.target.value);
                  if (g) patch({ garment: g.color });
                }}
              >
                {GARMENTS.map((g) => <option key={g.id} value={g.id}>{core(g.name)}</option>)}
                <option value="custom" disabled>{t('dtf.custom')}</option>
              </select>
              <div className="color-field">
                <input
                  type="color"
                  className="swatch-input"
                  aria-label={t('dtf.shirtColor')}
                  value={rgbToHex(s.garment.r, s.garment.g, s.garment.b)}
                  onChange={(e) => {
                    const [r, g, b] = hexToRgb(e.target.value);
                    patch({ garment: { r, g, b } });
                  }}
                />
                <input type="text" readOnly aria-label={t('dtf.shirtColor')} value={rgbToHex(s.garment.r, s.garment.g, s.garment.b)} />
              </div>
              <div className="hint">{t('dtf.shirtColorHint')}</div>
            </div>
          </Section>

          <Section title={t('dtf.placement')}>
            <NumberSlider
              label={t('dtf.width')}
              value={s.widthMm}
              min={20}
              max={MAX_PRINT_MM}
              step={1}
              unit="mm"
              onChange={(v) => patch({ widthMm: Math.round(v) })}
              onCommit={() => undefined}
            />
            <div className="hint">
              {t('dtf.dims', {
                w: num(s.widthMm / 10, 1),
                h: num(full.heightMm / 10, 1),
                wi: num(s.widthMm / IN, 1),
                hi: num(full.heightMm / IN, 1),
              })}
            </div>
            <div className="field">
              <div className="label"><span>{t('dtf.fileRes')}</span></div>
              <select value={String(s.dpi)} onChange={(e) => patch({ dpi: Number(e.target.value) })} aria-label={t('dtf.fileRes')}>
                <option value="300">{t('dtf.dpi300')}</option>
                <option value="360">360 DPI</option>
                <option value="600">600 DPI</option>
              </select>
              <div className="hint">{t('dtf.px', { w: full.width, h: full.height })}</div>
            </div>
          </Section>

          <Section title={t('dtf.improve')}>
            <NumberSlider label={t('dtf.contrast')} value={s.adjust.contrast} min={-0.5} max={0.8} step={0.01} defaultValue={0}
              onChange={(v) => patchAdjust({ contrast: v })} onCommit={() => undefined} />
            <NumberSlider label={t('dtf.saturation')} value={s.adjust.saturation} min={-1} max={1} step={0.01} defaultValue={0}
              onChange={(v) => patchAdjust({ saturation: v })} onCommit={() => undefined} />
            <NumberSlider label={t('dtf.sharpen')} value={s.adjust.sharpen} min={0} max={2} step={0.01} defaultValue={0}
              onChange={(v) => patchAdjust({ sharpen: v })} onCommit={() => undefined} />
          </Section>

          <Section title={t('spot.section')} defaultOpen={false}>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={s.spot.enabled}
                onChange={(e) => patchSpot({ enabled: e.target.checked })}
              />
              <span>{t('spot.on')}</span>
            </label>
            <div className="hint">{t('spot.intro')}</div>
            {s.spot.enabled ? (
              <>
                <div className="field">
                  <div className="label">
                    <span>{t('spot.fromImage')}</span>
                    <button className="btn small" onClick={() => setInkCandidates(null)}>{t('spot.reread')}</button>
                  </div>
                  {inkCandidates === null || inkCandidates.length === 0 ? (
                    <div className="hint">{t('spot.waiting')}</div>
                  ) : (
                    <>
                      <div className="spot-row">
                        {inkCandidates.map((c) => {
                          const hex = inkHex(c.color);
                          const on = s.spot.colors.some((x) => inkHex(x) === hex);
                          const label = `${hex} — ${t('spot.share', { pct: num(c.share * 100, 1) })}`;
                          return (
                            <button
                              key={hex}
                              className={`spot-swatch${on ? ' active' : ''}`}
                              style={{ background: hex }}
                              title={label}
                              aria-label={label}
                              aria-pressed={on}
                              onClick={() => toggleInk(c.color)}
                            >
                              <span className="spot-pct">{num(c.share * 100, 0)}%</span>
                            </button>
                          );
                        })}
                      </div>
                      <div className="hint">{t('spot.pick')}</div>
                    </>
                  )}
                </div>

                <div className="field">
                  <div className="label"><span>{t('spot.picked')}</span></div>
                  {s.spot.colors.length === 0 ? <div className="hint">{t('spot.none')}</div> : null}
                  {s.spot.colors.map((c, i) => (
                    <div className="color-field" key={`${inkHex(c)}-${i}`}>
                      <input
                        type="color"
                        className="swatch-input"
                        aria-label={t('spot.picked')}
                        value={inkHex(c)}
                        onChange={(e) => setInk(i, e.target.value)}
                      />
                      <input type="text" readOnly aria-label={t('spot.picked')} value={inkHex(c)} />
                      <button className="btn small" title={t('spot.remove')} aria-label={t('spot.remove')} onClick={() => removeInk(i)}>
                        ×
                      </button>
                    </div>
                  ))}
                  {s.spot.colors.length < MAX_SPOT_COLORS ? (
                    <button className="btn wide" style={{ marginTop: 6 }} onClick={addInk}>{t('spot.add')}</button>
                  ) : (
                    <div className="hint">{t('spot.limit', { n: MAX_SPOT_COLORS })}</div>
                  )}
                </div>

                <div className="field">
                  <div className="label"><span>{t('spot.other')}</span></div>
                  <select
                    value={s.spot.other}
                    aria-label={t('spot.other')}
                    onChange={(e) => patchSpot({ other: e.target.value as SpotOther })}
                  >
                    <option value="remove">{t('spot.otherRemove')}</option>
                    <option value="nearest">{t('spot.otherNearest')}</option>
                    <option value="color">{t('spot.otherColor')}</option>
                  </select>
                  {s.spot.other === 'color' ? (
                    <div className="color-field" style={{ marginTop: 4 }}>
                      <input
                        type="color"
                        className="swatch-input"
                        aria-label={t('spot.otherColor')}
                        value={inkHex(s.spot.otherColor)}
                        onChange={(e) => {
                          const [r, g, b] = hexToRgb(e.target.value);
                          patchSpot({ otherColor: { r, g, b } });
                        }}
                      />
                      <input type="text" readOnly aria-label={t('spot.otherColor')} value={inkHex(s.spot.otherColor)} />
                    </div>
                  ) : null}
                </div>

                <NumberSlider
                  label={t('spot.tolerance')}
                  value={s.spot.tolerance}
                  defaultValue={DEFAULT_SPOT_TOLERANCE}
                  min={5}
                  max={100}
                  step={1}
                  onChange={(v) => patchSpot({ tolerance: Math.round(v) })}
                  onCommit={() => undefined}
                />
                <div className="hint">{t('spot.toleranceHint')}</div>
                <div className="hint">{t('spot.hint')}</div>
              </>
            ) : null}
          </Section>


          {!simple ? (
            <>
              <Section title={t('dtf.knockout')}>
                <label className="checkbox">
                  <input type="checkbox" checked={s.knockout.enabled} onChange={(e) => patchKo({ enabled: e.target.checked })} />
                  <span>{t('dtf.knockoutOn')}</span>
                </label>
                {s.knockout.enabled ? (
                  <>
                    <div className="look-row">
                      {LOOKS.map((l) => (
                        <button
                          key={l.id}
                          className={`btn${activeLook === l.id ? ' active' : ''}`}
                          onClick={() => patchKo(l.knockout)}
                          title={core(l.note)}
                        >
                          {core(l.name)}
                        </button>
                      ))}
                    </div>
                    <div className="hint">
                      {activeLook !== null ? core(LOOKS.find((l) => l.id === activeLook)?.note ?? '') : t('dtf.customLook')}
                    </div>
                    <NumberSlider
                      label={t('dtf.tolerance')}
                      value={s.knockout.tolerance}
                      defaultValue={DEFAULT_TRANSFER.knockout.tolerance}
                      min={0}
                      max={0.4}
                      step={0.005}
                      onChange={(v) => patchKo({ tolerance: v })}
                      onCommit={() => undefined}
                    />
                    <div className="hint">{t('dtf.toleranceHint')}</div>
                    <NumberSlider
                      label={t('dtf.solid')}
                      value={s.knockout.solidPoint}
                      defaultValue={DEFAULT_TRANSFER.knockout.solidPoint}
                      // The solid point has to sit above the tolerance. The scale
                      // starts there, so the fader cannot be dragged to a value it
                      // would silently jump back from.
                      min={Math.min(0.99, Math.max(0.1, Math.round((s.knockout.tolerance + 0.01) * 100) / 100))}
                      max={1}
                      step={0.01}
                      onChange={(v) => patchKo({ solidPoint: Math.max(v, s.knockout.tolerance + 0.01) })}
                      onCommit={() => undefined}
                    />
                    <div className="hint">{t('dtf.solidHint')}</div>
                    <NumberSlider
                      label={t('dtf.density')}
                      value={s.knockout.density}
                      defaultValue={DEFAULT_TRANSFER.knockout.density}
                      min={0.5}
                      max={2}
                      step={0.01}
                      onChange={(v) => patchKo({ density: v })}
                      onCommit={() => undefined}
                    />
                  </>
                ) : null}
              </Section>

              <Section title={t('dtf.edgeFade')} defaultOpen={false}>
                <div className="field">
                  <div className="label"><span>{t('dtf.shape')}</span></div>
                  <select
                    value={s.edgeFade.shape}
                    aria-label={t('dtf.shape')}
                    onChange={(e) => patch({ edgeFade: { ...s.edgeFade, shape: e.target.value as EdgeFadeShape } })}
                  >
                    <option value="none">{t('dtf.fadeNone')}</option>
                    <option value="rect">{t('dtf.fadeRect')}</option>
                    <option value="ellipse">{t('dtf.fadeEllipse')}</option>
                  </select>
                </div>
                {s.edgeFade.shape !== 'none' ? (
                  <NumberSlider label={t('dtf.fadeWidth')} value={s.edgeFade.widthMm} min={2} max={80} step={1} unit="mm"
                    onChange={(v) => patch({ edgeFade: { ...s.edgeFade, widthMm: v } })} onCommit={() => undefined} />
                ) : null}
                <div className="hint">{t('dtf.fadeHint')}</div>
              </Section>

            </>
          ) : null}

          {/* Everything that is about the garment rather than about the file.
              Switched off, the studio is a transfer maker for any material. */}
          <Section title={t('dtf.garment')} defaultOpen={garmentMode}>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={garmentMode}
                onChange={(e) => setPref('dtfGarment', e.target.checked)}
              />
              <span>{t('dtf.garmentOn')}</span>
            </label>
            <div className="hint">{t('dtf.garmentHint')}</div>
            {garmentMode ? (
              <>
                <div className="field">
                  <div className="label"><span>{t('dtf.where')}</span></div>
                  <select value={placementId} onChange={(e) => setPlacementId(e.target.value)} aria-label={t('dtf.where')}>
                    {PLACEMENTS.map((x) => <option key={x.id} value={x.id}>{core(x.name)}</option>)}
                  </select>
                  <div className="hint">{core(placement.note)}</div>
                  <button className="btn wide" onClick={() => choosePlacement(placementId)}>{t('dtf.sizeUse')}</button>
                </div>
                <div className="field">
                  <div className="label"><span>{t('dtf.size')}</span></div>
                  <select value={shirtId} onChange={(e) => setShirtId(e.target.value)} aria-label={t('dtf.size')}>
                    {SHIRT_SIZES.map((x) => (
                      <option key={x.id} value={x.id}>{t('dtf.sizeOption', { id: x.id, cm: num(x.halfChestMm / 10, 1) })}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <div className="label"><span>{t('dtf.fabric')}</span></div>
                  <select value={fabricId} onChange={(e) => setFabricId(e.target.value)} aria-label={t('dtf.fabric')}>
                    {PRESS_SETTINGS.map((x) => <option key={x.id} value={x.id}>{core(x.fabric)}</option>)}
                  </select>
                </div>
              </>
            ) : null}
          </Section>
          <div className="panel-foot">
            <button className="btn wide" onClick={resetToRecommended}>{t('dtf.resetDefaults')}</button>
          </div>

        </div>

        <div className="studio-canvas">
          <div className={`status-banner ${banner.kind}`} role="status">
            <span className="sb-mark" aria-hidden="true">
              <Icon name={banner.kind === 'ok' ? 'check' : banner.kind === 'warn' ? 'alert' : banner.kind === 'error' ? 'cross' : 'dots'} size={11} />
            </span>
            <strong>{banner.title}</strong>
            {banner.text ? <span className="sb-text">{banner.text}</span> : <span className="sb-text" />}
            {banner.kind === 'warn' || banner.kind === 'error' ? (
              <button className="btn small" onClick={showProblems}>{t('dtf.statusShow')}</button>
            ) : null}
          </div>
          <div className="view-tabs">
            <div className="view-scroll" role="tablist">
            {VIEWS.filter(([id]) => id !== 'shirt' || garmentMode).map(([id, key]) => (
              <button
                key={id}
                role="tab"
                aria-selected={view === id}
                className={`btn${view === id ? ' active' : ''}`}
                onClick={() => chooseView(id)}
              >
                {t(key)}
                {id === 'problems' && errorCount + warnCount > 0 ? <span className="cov"> {errorCount + warnCount}</span> : null}
              </button>
            ))}
            </div>
            <span className="spacer" />
            {view === 'background' ? (
              <span className="bg-picker" role="group" aria-label={t('view.bgLabel')}>
                <span className="bg-label">{t('view.bgLabel')}</span>
                <button
                  className={`bg-swatch${bgColor === null ? ' active' : ''}`}
                  style={{ background: garmentKey }}
                  title={t('view.bgShirt')}
                  aria-label={t('view.bgShirt')}
                  onClick={() => chooseBackground(null)}
                />
                {BG_SWATCHES.map(([hex, key]) => (
                  <button
                    key={hex}
                    className={`bg-swatch${(bgColor ?? '').toLowerCase() === hex ? ' active' : ''}`}
                    style={{ background: hex }}
                    title={t(key)}
                    aria-label={t(key)}
                    onClick={() => chooseBackground(hex)}
                  />
                ))}
                <input
                  type="color"
                  className="swatch-input"
                  value={bgHex}
                  title={t('view.bgCustom')}
                  aria-label={t('view.bgCustom')}
                  onChange={(e) => chooseBackground(e.target.value)}
                />
              </span>
            ) : null}
          </div>
          <ZoomPanView
            ref={viewerRef}
            label={t(VIEWS.find(([id]) => id === view)?.[1] ?? 'dtf.viewShirt')}
            content={viewContent}
            layers={viewLayers}
            backdrop={backdrop}
            fitKey={view === 'shirt' ? 'shirt' : 'print'}
            maxZoom={view === 'shirt' ? 6 : 16}
            outline={view === 'background' || view === 'detail'}
            badge={preview === null ? t('dtf.calculating') : detailLoading ? t('view.loadingDetail') : null}
            onViewChange={onViewChange}
          />
          {/* The wall readout: the six numbers the job is actually specified by,
              in one place, so nothing has to be dug out of a panel again. */}
          <div className="readout" role="group" aria-label={t('dtf.check')}>
            <span className="readout-cell">
              <span className="readout-label">{t('readout.size')}</span>
              <span className="readout-value">{num(s.widthMm / 10, 1)} × {num(full.heightMm / 10, 1)} cm</span>
            </span>
            <span className="readout-cell">
              <span className="readout-label">{t('readout.file')}</span>
              <span className="readout-value">{full.width} × {full.height} px</span>
            </span>
            <span className="readout-cell">
              <span className="readout-label">{t('readout.res')}</span>
              <span className="readout-value">{s.dpi} DPI</span>
            </span>
            <span className="readout-cell">
              <span className="readout-label">{t('readout.screen')}</span>
              <span className="readout-value">
                {s.screen.kind === 'am' ? `${s.screen.lpi} LPI · ${num(s.screen.angle, 1)}°` : t('dtf.fm')}
              </span>
            </span>
            <span className="readout-cell">
              <span className="readout-label">{t('readout.dot')}</span>
              <span className="readout-value">{num(eff, 2)} mm</span>
            </span>
            <span className="readout-cell">
              <span className="readout-label">{t('readout.ink')}</span>
              <span className="readout-value">
                {analysis === null ? t('readout.pending') : `${num(analysis.stats.inkFraction * 100, 1)} %`}
              </span>
            </span>
          </div>
          <div className="film-note">
            <span>
              {view === 'shirt' && t('dtf.noteShirt')}
              {view === 'file' && t('dtf.noteFile')}
              {view === 'background' && t('dtf.noteBackground')}
              {view === 'white' && t('dtf.noteWhite', { choke: num(s.chokeMm, 2) })}
              {view === 'problems' && `${t('dtf.noteProblems')} ${t('view.previewRes')}`}
              {view === 'detail' &&
                t('dtf.noteDetail', { dpi: s.dpi, cell: num(25.4 / s.screen.lpi, 2), dot: num(eff, 2) })}
            </span>
            <span className="film-hint">{wheelMode === 'pan' ? t('view.hintPan') : t('view.hint')}</span>
          </div>
        </div>

        <div className="panel right">
          <Section title={`${t('dtf.auto')}${tuning ? t('dtf.tuning') : ''}`}>
            <label className="checkbox">
              <input type="checkbox" checked={autoTuneOn} onChange={(e) => setAutoTuneOn(e.target.checked)} />
              <span>{t('dtf.autoOn')}</span>
            </label>
            <div className="field">
              <div className="label"><span>{t('dtf.aim')}</span></div>
              <select value={preference} onChange={(e) => setPreference(e.target.value as TunePreference)} aria-label={t('dtf.aim')}>
                <option value="photo">{t('dtf.aimPhoto')}</option>
                <option value="balanced">{t('dtf.aimBalanced')}</option>
                <option value="vintage">{t('dtf.aimVintage')}</option>
              </select>
            </div>
            <button className="btn wide" disabled={tuning || heavy === null} onClick={() => void runTune()}>
              {t('dtf.retune')}
            </button>
            {tune ? (
              <div className="tune-box">
                <div className="tune-metric">
                  <span>{t('dtf.milkyRisk')}</span>
                  <strong className={tune.metrics.milky > MILKY_LIMIT ? 'bad' : 'good'}>
                    {Math.round(tune.before.milky * 100)}% → {Math.round(tune.metrics.milky * 100)}%
                  </strong>
                </div>
                <ul className="tune-notes">
                  {tune.notes.map((n, i) => <li key={i}>{core(n)}</li>)}
                </ul>
                {tune.candidates.length > 1 ? (
                  <div className="look-row">
                    {tune.candidates.map((c, i) => (
                      <button
                        key={i}
                        className={`btn${sameKnockout(c.settings.knockout, s.knockout) ? ' active' : ''}`}
                        title={t('dtf.candidateTitle', {
                          milky: Math.round(c.metrics.milky * 100),
                          dots: Math.round(c.metrics.dotShare * 100),
                        })}
                        onClick={() => patchKo(c.settings.knockout)}
                      >
                        {core(c.label)}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="hint">{t('dtf.autoFree')}</div>
          </Section>

          <Section title={t('claude.section')} defaultOpen={false}>
            <div className="hint">{t('claude.optional')}</div>
            <div className="claude-box">
              <div className="claude-head">
                <strong>{t('claude.title')}</strong>
                <span className="dim">{CLAUDE_MODEL}</span>
              </div>
              {claudeKey === '' ? (
                <>
                  <div className="hint">{t('claude.intro')}</div>
                  <div className="slider-row" style={{ marginTop: 6 }}>
                    <input
                      type="password"
                      autoComplete="off"
                      aria-label={t('claude.keyPlaceholder')}
                      placeholder={t('claude.keyPlaceholder')}
                      value={keyDraft}
                      onChange={(e) => setKeyDraft(e.target.value)}
                    />
                    <button className="btn" disabled={keyDraft.trim() === ''} onClick={saveKey}>{t('claude.saveKey')}</button>
                  </div>
                  <div className="hint">{t('claude.keyLocal')}</div>
                </>
              ) : (
                <>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={claudeConsent}
                      onChange={(e) => {
                        setClaudeConsent(e.target.checked);
                        writeLocal('ditherlab.claude.consent', e.target.checked ? '1' : '0');
                      }}
                    />
                    <span>{t('claude.consent')}</span>
                  </label>
                  <div className="hint">{t('claude.consentHint')}</div>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={claudeAuto}
                      onChange={(e) => {
                        setClaudeAuto(e.target.checked);
                        writeLocal('ditherlab.claude.auto', e.target.checked ? '1' : '0');
                      }}
                    />
                    <span>{t('claude.auto')}</span>
                  </label>
                  <div className="row" style={{ marginTop: 6 }}>
                    <button
                      className="btn primary"
                      disabled={!claudeReady || claudeBusy || tune === null}
                      onClick={() => {
                        if (tune) void runClaude(tune);
                      }}
                    >
                      {claudeBusy ? t('claude.busy') : t('claude.run')}
                    </button>
                    <button
                      className="btn"
                      onClick={() => {
                        setClaudeKey('');
                        writeLocal('ditherlab.claude.key', null);
                        setClaudeResult(null);
                      }}
                    >
                      {t('claude.removeKey')}
                    </button>
                  </div>
                  {claudeResult ? (
                    <div className={`claude-result${claudeResult.applied ? '' : ' rejected'}`}>
                      <div>{core(claudeResult.proposal.summary)}</div>
                      {claudeResult.proposal.risks.length > 0 ? (
                        <ul className="tune-notes">
                          {claudeResult.proposal.risks.map((r, i) => <li key={i}>{r}</li>)}
                        </ul>
                      ) : null}
                      <div className="dim">{t(claudeResult.note.key, claudeResult.note.vars)}</div>
                    </div>
                  ) : null}
                  {claudeError ? <div className="error">{claudeError}</div> : null}
                  <div className="hint">{t('claude.fallback')}</div>
                </>
              )}
            </div>
          </Section>

          {!simple ? (
            <>
              <Section title={t('dtf.screen')}>
                <div className="field">
                  <div className="label"><span>{t('dtf.type')}</span></div>
                  <select value={s.screen.kind} onChange={(e) => patchScreen({ kind: e.target.value as TransferScreen })} aria-label={t('dtf.type')}>
                    <option value="am">{t('dtf.am')}</option>
                    <option value="fm">{t('dtf.fm')}</option>
                  </select>
                </div>
                {s.screen.kind === 'am' ? (
                  <>
                    <NumberSlider label={t('dtf.lpi')} value={s.screen.lpi} min={15} max={60} step={1} unit="LPI" defaultValue={DEFAULT_TRANSFER.screen.lpi}
                      onChange={(v) => patchScreen({ lpi: Math.round(v) })} onCommit={() => undefined} />
                    <div className="hint">{t('dtf.lpiHint')}</div>
                    <NumberSlider label={t('dtf.angle')} value={s.screen.angle} min={0} max={90} step={0.5} unit="°" defaultValue={DEFAULT_TRANSFER.screen.angle}
                      onChange={(v) => patchScreen({ angle: v })} onCommit={() => undefined} />
                    <div className="field">
                      <div className="label"><span>{t('dtf.dotShape')}</span></div>
                      <select value={s.screen.shape} onChange={(e) => patchScreen({ shape: e.target.value as TransferDotShape })} aria-label={t('dtf.dotShape')}>
                        <option value="euclidean">{t('dtf.shapeEuclidean')}</option>
                        <option value="round">{t('dtf.shapeRound')}</option>
                        <option value="square">{t('dtf.shapeSquare')}</option>
                        <option value="ellipse">{t('dtf.shapeEllipse')}</option>
                      </select>
                      <div className="hint">
                        {s.screen.shape === 'euclidean'
                          ? t('dtf.shapeHintEuclidean')
                          : s.screen.shape === 'round'
                            ? t('dtf.shapeHintRound')
                            : t('dtf.shapeHintOther')}
                      </div>
                    </div>
                  </>
                ) : null}
                <NumberSlider label={t('dtf.minDot')} value={s.screen.minDotMm} min={0.3} max={1.2} step={0.01} unit="mm" defaultValue={DEFAULT_TRANSFER.screen.minDotMm}
                  onChange={(v) => patchScreen({ minDotMm: v })} onCommit={() => undefined} />
                <div className="hint">
                  {t('dtf.minDotHint')}
                  {eff > s.screen.minDotMm + 1e-6 ? t('dtf.minDotChoke', { mm: num(eff, 2) }) : ''}
                </div>
              </Section>

              <Section title={t('dtf.rip')}>
                <NumberSlider label={t('dtf.choke')} value={s.chokeMm} min={0} max={0.5} step={0.01} unit="mm" defaultValue={DEFAULT_TRANSFER.chokeMm}
                  onChange={(v) => patch({ chokeMm: v })} onCommit={() => undefined} />
                <div className="hint">{t('dtf.chokeHint', { px: num(mmToPx(s.chokeMm, 300), 1) })}</div>
                <label className="checkbox">
                  <input type="checkbox" checked={s.cleanup} onChange={(e) => patch({ cleanup: e.target.checked })} />
                  <span>{t('dtf.cleanup')}</span>
                </label>
                <label className="checkbox">
                  <input type="checkbox" checked={s.mirror} onChange={(e) => patch({ mirror: e.target.checked })} />
                  <span>{t('dtf.mirror')}</span>
                </label>
                <div className="hint">{t('dtf.mirrorHint')}</div>
              </Section>
            </>
          ) : null}

          <div ref={checkRef}>
            <Section title={`${t('dtf.check')}${analyzing ? t('dtf.checkRunning') : ''}`}>
              {analysis === null ? (
                <div className="hint">{t('dtf.checking')}</div>
              ) : (
                <div className="check-list">
                  {analysis.checks.map((c) => (
                    <div key={c.id} className={`check ${c.level}`}>
                      <span className="mark" aria-hidden="true">
                        <Icon name={c.level === 'ok' ? 'check' : c.level === 'info' ? 'info' : c.level === 'warn' ? 'alert' : 'cross'} size={11} />
                      </span>
                      <div>
                        <div className="check-title">{core(c.title)}</div>
                        <div className="check-detail">{core(c.detail)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Section>
          </div>

          {garmentMode ? (
          <Section title={t('dtf.press')}>
            <div className="press-card">
              <div className="press-fabric">{core(press.fabric)}</div>
              <div className="press-row"><span>{t('dtf.temp')}</span><strong>{press.tempC[0]}–{press.tempC[1]} °C</strong></div>
              <div className="press-row"><span></span><span className="dim">{press.tempF[0]}–{press.tempF[1]} °F</span></div>
              <div className="press-row"><span>{t('dtf.time')}</span><strong>{press.seconds[0]}–{press.seconds[1]} s</strong></div>
              <div className="press-row"><span>{t('dtf.pressure')}</span><span>{core(press.pressure)}</span></div>
              <div className="press-row"><span>{t('dtf.peel')}</span><span>{core(press.peel)}</span></div>
              <div className="press-row"><span>{t('dtf.finish')}</span><span>{core(press.finish)}</span></div>
            </div>
            <div className="hint">{t('dtf.pressHint')}</div>
          </Section>
          ) : null}

          <Section title={t('dtf.save')}>
            <button className="btn primary wide" disabled={busy || heavy === null} onClick={() => void exportFile('png')}>
              {t('dtf.savePng', { dpi: s.dpi })}
            </button>
            <button
              className="btn wide"
              style={{ marginTop: 6 }}
              disabled={busy || heavy === null || preview === null}
              onClick={() => void exportPackage()}
              title={t(garmentMode ? 'dtf.packageHintGarment' : 'dtf.packageHint')}
            >
              {t('dtf.savePackage')}
            </button>
            <div className="row" style={{ marginTop: 6 }}>
              <button className="btn" disabled={busy || heavy === null} onClick={() => void exportFile('tiff')}>{t('dtf.saveTiff')}</button>
              {garmentMode ? (
                <button className="btn" disabled={preview === null} onClick={() => void exportMockup()}>{t('dtf.saveMockup')}</button>
              ) : null}
              <button className="btn" onClick={exportTicket}>{t('dtf.saveTicket')}</button>
            </div>
            <div className="hint">{t(garmentMode ? 'dtf.packageHintGarment' : 'dtf.packageHint')}</div>
            <div className="hint">
              {t('dtf.exportHint', { cm: num(s.widthMm / 10, 1), films: films || t('dtf.noFilm') })}
            </div>
          </Section>

          {status ? <div className="hint panel-note">{status}</div> : null}
          {error ? <div className="error panel-note">{error}</div> : null}
        </div>
      </div>
    </div>
  );
}
