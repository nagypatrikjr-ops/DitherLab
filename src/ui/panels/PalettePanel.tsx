import { useEffect, useMemo, useRef, useState } from 'react';
import { Section } from '../components/Section';
import { activePalette, allPalettesFor, useStore } from '../../state/store';
import { rgbToHex, hexToRgb } from '../../core/palette/builtin';
import {
  detectFormat,
  fetchLospecPalette,
  parseAse,
  parseGpl,
  parseHexPalette,
  parsePal,
  paletteToGpl,
  paletteToHexText,
} from '../../core/palette/io';
import { extractPalette } from '../../core/palette/extract';
import { bufferFromRgba } from '../../core/buffer';
import type { DistanceMetric } from '../../core/types';
import { useI18n, type MessageKey } from '../../i18n';
import { saveFile } from '../save';
import { Icon } from '../components/Icon';

const METRICS: { value: DistanceMetric; key?: MessageKey; label?: string }[] = [
  { value: 'rgb', key: 'palette.metricRgb' },
  { value: 'weightedRgb', key: 'palette.metricWeighted' },
  { value: 'cie76', label: 'CIE76 (Lab)' },
  { value: 'ciede2000', label: 'CIEDE2000' },
];

export function PalettePanel(): JSX.Element {
  const { t, core, err } = useI18n();
  const doc = useStore((s) => s.doc);
  const source = useStore((s) => s.source);
  const setPalette = useStore((s) => s.setPalette);
  const addCustomPalette = useStore((s) => s.addCustomPalette);
  const updateColors = useStore((s) => s.updateCustomPaletteColors);
  const setDistance = useStore((s) => s.setDistance);
  const setGamma = useStore((s) => s.setGamma);
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [lospec, setLospec] = useState('');
  const [method, setMethod] = useState<'medianCut' | 'kmeans' | 'octree'>('medianCut');
  const [colorCount, setColorCount] = useState(8);

  const palettes = useMemo(() => allPalettesFor(doc), [doc]);
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const p of palettes) set.add(p.category);
    return [...set];
  }, [palettes]);

  const current = activePalette(doc);
  const [category, setCategory] = useState<string>(current?.category ?? categories[0]);

  // Follow the active palette: loading a preset or a starter switches the
  // palette directly, and leaving the category picker behind would show an
  // empty dropdown for a palette that is in fact selected.
  useEffect(() => {
    if (current && current.category !== category) setCategory(current.category);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  const inCategory = palettes.filter((p) => p.category === category);

  const colors = current
    ? Array.from({ length: current.colors.length / 3 }, (_, i) => ({
        hex: rgbToHex(current.colors[i * 3], current.colors[i * 3 + 1], current.colors[i * 3 + 2]),
        i,
      }))
    : [];

  const writeColors = (next: string[]): void => {
    if (!current) return;
    const flat = new Float32Array(next.length * 3);
    next.forEach((hex, i) => {
      try {
        const [r, g, b] = hexToRgb(hex);
        flat[i * 3] = r;
        flat[i * 3 + 1] = g;
        flat[i * 3 + 2] = b;
      } catch {
        /* leave black */
      }
    });
    updateColors(current.id, flat);
  };

  const handleFile = async (file: File): Promise<void> => {
    setError(null);
    try {
      const format = detectFormat(file.name);
      if (format === 'gpl') addCustomPalette(parseGpl(await file.text(), file.name));
      else if (format === 'hex') addCustomPalette(parseHexPalette(await file.text(), file.name));
      else if (format === 'ase') addCustomPalette(parseAse(await file.arrayBuffer(), file.name));
      else if (format === 'pal') addCustomPalette(parsePal(await file.arrayBuffer(), file.name));
      else throw new Error(t('palette.unknownExt'));
    } catch (e) {
      setError(err(e));
    }
  };

  const handleExtract = (): void => {
    if (!source) return;
    setError(null);
    const buf = bufferFromRgba(source.imageData.data, source.width, source.height);
    addCustomPalette(extractPalette(buf, method, colorCount, doc.seed));
  };

  return (
    <>
      <Section title={t('palette.title')}>
        <div className="field">
          <div className="label"><span>{t('palette.category')}</span></div>
          <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label={t('palette.category')}>
            {categories.map((c) => <option key={c} value={c}>{core(c)}</option>)}
          </select>
        </div>
        <div className="field">
          <div className="label">
            <span>{t('palette.palette')}</span>
            <span className="unit">{current ? t('palette.colors', { n: current.colors.length / 3 }) : ''}</span>
          </div>
          <select
            aria-label={t('palette.palette')}
            value={inCategory.some((p) => p.id === doc.paletteId) ? doc.paletteId : ''}
            onChange={(e) => setPalette(e.target.value)}
          >
            {!inCategory.some((p) => p.id === doc.paletteId) ? <option value="">{t('palette.choose')}</option> : null}
            {inCategory.map((p) => <option key={p.id} value={p.id}>{core(p.name)}</option>)}
          </select>
        </div>

        <div className="swatches">
          {colors.slice(0, 64).map((c) => (
            <div key={c.i} className="swatch" style={{ background: c.hex }} title={c.hex} />
          ))}
        </div>

        <div className="color-rows">
          {colors.map((c) => (
            <div className="color-row" key={c.i}>
              <label style={{ position: 'relative', display: 'inline-flex' }}>
                <span className="chip" style={{ background: c.hex }} />
                <input
                  type="color"
                  aria-label={c.hex}
                  value={c.hex}
                  onChange={(e) => {
                    const next = colors.map((x) => x.hex);
                    next[c.i] = e.target.value.toUpperCase();
                    writeColors(next);
                  }}
                />
              </label>
              <input
                type="text"
                aria-label={c.hex}
                value={c.hex}
                onChange={(e) => {
                  const next = colors.map((x) => x.hex);
                  next[c.i] = e.target.value;
                  writeColors(next);
                }}
              />
              <button
                className="mini"
                title={t('common.moveUp')}
                aria-label={t('common.moveUp')}
                disabled={c.i === 0}
                onClick={() => {
                  if (c.i === 0) return;
                  const next = colors.map((x) => x.hex);
                  [next[c.i - 1], next[c.i]] = [next[c.i], next[c.i - 1]];
                  writeColors(next);
                }}
              ><Icon name="raise" size={11} /></button>
              <button
                className="mini"
                title={t('common.remove')}
                aria-label={t('common.remove')}
                disabled={colors.length <= 2}
                onClick={() => {
                  if (colors.length <= 2) return;
                  writeColors(colors.filter((x) => x.i !== c.i).map((x) => x.hex));
                }}
              ><Icon name="close" size={11} /></button>
            </div>
          ))}
        </div>

        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn" onClick={() => writeColors([...colors.map((c) => c.hex), '#808080'])}>
            {t('palette.addColor')}
          </button>
          <button className="btn" onClick={() => fileRef.current?.click()} title={t('palette.importTitle')}>
            {t('palette.import')}
          </button>
          <button
            className="btn"
            disabled={!current}
            onClick={() => {
              if (!current) return;
              saveFile(paletteToGpl(current), `${current.name}.gpl`, 'text/plain');
            }}
          >
            .gpl
          </button>
          <button
            className="btn"
            disabled={!current}
            onClick={() => {
              if (!current) return;
              saveFile(paletteToHexText(current), `${current.name}.hex`, 'text/plain');
            }}
          >
            .hex
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".hex,.gpl,.ase,.pal,.txt"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
            e.target.value = '';
          }}
        />

        <div className="field">
          <div className="label"><span>{t('palette.lospec')}</span></div>
          <div className="slider-row">
            <input
              type="text"
              aria-label={t('palette.lospec')}
              placeholder="lospec.com/palette-list/..."
              value={lospec}
              onChange={(e) => setLospec(e.target.value)}
            />
            <button
              className="btn"
              onClick={() => {
                setError(null);
                fetchLospecPalette(lospec)
                  .then(addCustomPalette)
                  .catch((e: unknown) => setError(err(e)));
              }}
            >
              {t('palette.load')}
            </button>
          </div>
        </div>
        {error ? <div className="error">{error}</div> : null}
      </Section>

      <Section title={t('palette.extract')} defaultOpen={false}>
        <div className="field">
          <div className="label"><span>{t('palette.method')}</span></div>
          <select value={method} onChange={(e) => setMethod(e.target.value as typeof method)} aria-label={t('palette.method')}>
            <option value="medianCut">Median cut</option>
            <option value="kmeans">k-means</option>
            <option value="octree">Octree</option>
          </select>
        </div>
        <div className="field">
          <div className="label">
            <span>{t('palette.count')}</span>
            <span className="unit">{colorCount}</span>
          </div>
          <input
            type="range" min={2} max={256} value={colorCount}
            aria-label={t('palette.count')}
            onChange={(e) => setColorCount(Number(e.target.value))}
            style={{ width: '100%', accentColor: 'var(--accent)' }}
          />
        </div>
        <button className="btn primary" disabled={source === null} onClick={handleExtract}>
          {t('palette.extractBtn')}
        </button>
        {source === null ? <div className="hint">{t('common.openImageFirst')}</div> : null}
      </Section>

      <Section title={t('palette.colorMgmt')} defaultOpen={false}>
        <div className="field">
          <div className="label"><span>{t('palette.metric')}</span></div>
          <select value={doc.distance} onChange={(e) => setDistance(e.target.value as DistanceMetric)} aria-label={t('palette.metric')}>
            {METRICS.map((m) => (
              <option key={m.value} value={m.value}>{m.key ? t(m.key) : m.label}</option>
            ))}
          </select>
        </div>
        <div className="row">
          <label className="checkbox">
            <input type="checkbox" checked={doc.gammaCorrect} onChange={(e) => setGamma(e.target.checked)} />
            <span>{t('palette.linear')}</span>
          </label>
        </div>
        <div className="hint">{t('palette.linearHint')}</div>
      </Section>
    </>
  );
}
