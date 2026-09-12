import { useState } from 'react';
import { Section } from '../components/Section';
import { activePalette, useStore } from '../../state/store';
import { encodeTiff, encodeViaCanvas } from '../../io/image';
import { collectPalette, encodePngIndexed, encodePngRgba, toIndexed } from '../../io/png';
import { toPdf, toSvg, vectorize } from '../../core/vector';
import { bufferFromRgba } from '../../core/buffer';
import { useI18n } from '../../i18n';
import { saveFile } from '../save';

interface Props {
  /** Full-resolution render; null while it has not been produced yet. */
  getFullRender: () => Promise<ImageData>;
  busy: boolean;
}

export function ExportPanel({ getFullRender, busy }: Props): JSX.Element {
  const { t, err, num } = useI18n();
  const doc = useStore((s) => s.doc);
  const source = useStore((s) => s.source);
  const [status, setStatus] = useState<string | null>(null);
  const [quality, setQuality] = useState(0.92);
  const [minPathArea, setMinPathArea] = useState(0.5);
  const [simplify, setSimplify] = useState(0);
  const [mergeAdjacent, setMergeAdjacent] = useState(true);
  const [strokeMode, setStrokeMode] = useState(false);
  const [threshold, setThreshold] = useState(0.5);
  const [running, setRunning] = useState(false);

  const baseName = (source?.name ?? 'ditherlab').replace(/\.[^.]+$/, '');

  const guard = async (label: string, fn: () => Promise<void>): Promise<void> => {
    setRunning(true);
    setStatus(`${label}…`);
    try {
      await fn();
      setStatus(t('common.done', { label }));
    } catch (e) {
      setStatus(err(e));
    } finally {
      setRunning(false);
    }
  };

  const disabled = source === null || busy || running;

  return (
    <>
      <Section title={t('export.title')}>
        <div className="row">
          <button
            className="btn primary"
            disabled={disabled}
            onClick={() => guard('PNG', async () => {
              const image = await getFullRender();
              const png = await encodePngRgba(image.data, image.width, image.height);
              saveFile(png, `${baseName}-dither.png`, 'image/png');
            })}
          >PNG</button>
          <button
            className="btn"
            disabled={disabled}
            title={t('export.indexedTitle')}
            onClick={() => guard(t('export.indexed'), async () => {
              const image = await getFullRender();
              const palette = activePalette(doc);
              const found = collectPalette(image.data, 256);
              const used = found ?? palette?.colors ?? null;
              if (used === null) throw new Error(t('export.tooManyColors'));
              const indexed = toIndexed(image.data, image.width, image.height, used);
              const png = await encodePngIndexed(indexed);
              saveFile(png, `${baseName}-indexed.png`, 'image/png');
            })}
          >{t('export.indexed')}</button>
        </div>
        <div className="row">
          <button
            className="btn"
            disabled={disabled}
            onClick={() => guard('WEBP', async () => {
              const image = await getFullRender();
              saveFile(await encodeViaCanvas(image, 'image/webp', quality), `${baseName}.webp`, 'image/webp');
            })}
          >WEBP</button>
          <button
            className="btn"
            disabled={disabled}
            onClick={() => guard('JPG', async () => {
              const image = await getFullRender();
              saveFile(await encodeViaCanvas(image, 'image/jpeg', quality), `${baseName}.jpg`, 'image/jpeg');
            })}
          >JPG</button>
          <button
            className="btn"
            disabled={disabled}
            onClick={() => guard('TIFF', async () => {
              const image = await getFullRender();
              saveFile(encodeTiff(image), `${baseName}.tif`, 'image/tiff');
            })}
          >TIFF</button>
        </div>
        <div className="field">
          <div className="label">
            <span>{t('export.quality')}</span>
            <span className="unit">{Math.round(quality * 100)}%</span>
          </div>
          <input
            type="range" min={1} max={100} value={Math.round(quality * 100)}
            aria-label={t('export.quality')}
            onChange={(e) => setQuality(Number(e.target.value) / 100)}
            style={{ width: '100%', accentColor: 'var(--accent)' }}
          />
        </div>
        <div className="hint">{t('export.fullRes')}</div>
      </Section>

      <Section title={t('export.vector')} defaultOpen={false}>
        <div className="hint">{t('export.vectorHint')}</div>
        <div className="field">
          <div className="label">
            <span>{t('export.threshold')}</span>
            <span className="unit">{num(threshold, 2)}</span>
          </div>
          <input
            type="range" min={0} max={100} value={Math.round(threshold * 100)}
            aria-label={t('export.threshold')}
            onChange={(e) => setThreshold(Number(e.target.value) / 100)}
            style={{ width: '100%', accentColor: 'var(--accent)' }}
          />
        </div>
        <div className="field">
          <div className="label">
            <span>{t('export.minArea')}</span>
            <span className="unit">{num(minPathArea)} px²</span>
          </div>
          <input
            type="range" min={0} max={40} step={0.5} value={minPathArea}
            aria-label={t('export.minArea')}
            onChange={(e) => setMinPathArea(Number(e.target.value))}
            style={{ width: '100%', accentColor: 'var(--accent)' }}
          />
        </div>
        <div className="field">
          <div className="label">
            <span>{t('export.simplify')}</span>
            <span className="unit">{num(simplify, 2)} px</span>
          </div>
          <input
            type="range" min={0} max={400} value={Math.round(simplify * 100)}
            aria-label={t('export.simplify')}
            onChange={(e) => setSimplify(Number(e.target.value) / 100)}
            style={{ width: '100%', accentColor: 'var(--accent)' }}
          />
        </div>
        <label className="checkbox" style={{ margin: '6px 0' }}>
          <input type="checkbox" checked={mergeAdjacent} onChange={(e) => setMergeAdjacent(e.target.checked)} />
          <span>{t('export.merge')}</span>
        </label>
        <label className="checkbox" style={{ margin: '6px 0' }}>
          <input type="checkbox" checked={strokeMode} onChange={(e) => setStrokeMode(e.target.checked)} />
          <span>{t('export.stroke')}</span>
        </label>
        <div className="row">
          <button
            className="btn"
            disabled={disabled}
            onClick={() => guard('SVG', async () => {
              const image = await getFullRender();
              const buf = bufferFromRgba(image.data, image.width, image.height);
              const opts = { threshold, minPathArea, simplifyTolerance: simplify, mergeAdjacent, strokeMode };
              const result = vectorize(buf, opts);
              if (result.pointCount > 2_000_000) {
                setStatus(t('export.bigVector', { rings: result.rings.length, points: result.pointCount }));
              }
              saveFile(toSvg(result, opts), `${baseName}.svg`, 'image/svg+xml');
            })}
          >SVG</button>
          <button
            className="btn"
            disabled={disabled}
            onClick={() => guard('PDF', async () => {
              const image = await getFullRender();
              const buf = bufferFromRgba(image.data, image.width, image.height);
              const opts = { threshold, minPathArea, simplifyTolerance: simplify, mergeAdjacent, strokeMode };
              const result = vectorize(buf, opts);
              saveFile(toPdf(result, opts), `${baseName}.pdf`, 'application/pdf');
            })}
          >PDF</button>
        </div>
      </Section>

      {status ? <div className="hint" style={{ padding: '6px 10px' }}>{status}</div> : null}
    </>
  );
}
