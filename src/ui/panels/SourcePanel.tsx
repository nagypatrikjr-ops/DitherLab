import { useRef, useState } from 'react';
import { Section } from '../components/Section';
import { activePalette, createLayer, useStore, type DitherDocument } from '../../state/store';
import { parsePreset, presetFromFragment, presetToFragment, serializePreset } from '../../io/preset';
import { defaultParams, requireProcessor } from '../../core/dither/registry';
import type { EffectLayer, NoiseMode } from '../../core/types';
import { useI18n, type MessageKey } from '../../i18n';
import { saveFile } from '../save';
import { isDesktop, mod } from '../platform';

interface Props {
  onOpen: () => void;
}

/** One-click starting points; each is just a normal layer stack. */
const STARTERS: { key: MessageKey; paletteId: string; layers: [string, Record<string, unknown>][] }[] = [
  {
    key: 'starter.fs1bit',
    paletteId: 'bw1',
    layers: [['fx:adjust', { contrast: 0.15 }], ['ed:floyd-steinberg', { colorMode: 'mono', pixelScale: 2 }]],
  },
  {
    key: 'starter.bayer',
    paletteId: 'bw1',
    layers: [['ord:bayer8', { colorMode: 'mono', pixelScale: 8 }]],
  },
  {
    key: 'starter.gameboy',
    paletteId: 'gb-dmg',
    layers: [['fx:adjust', { contrast: 0.2, saturation: -0.3 }], ['ed:atkinson', { colorMode: 'palette', pixelScale: 4 }]],
  },
  {
    key: 'starter.newsprint',
    paletteId: 'newsprint',
    layers: [['ht:halftone', { separation: 'mono', dotShape: 'newsprint', frequency: 32 }]],
  },
  {
    key: 'starter.riso',
    paletteId: 'riso-pink-blue',
    layers: [['fx:adjust', { contrast: 0.25 }], ['ord:blue-noise', { colorMode: 'palette', pixelScale: 3 }]],
  },
  {
    key: 'starter.crt',
    paletteId: 'plasma',
    layers: [
      ['fx:chromatic', { amount: 4 }],
      ['ord:bayer4', { colorMode: 'palette', pixelScale: 3 }],
      ['fx:crt', {}],
      ['fx:jpeg', { quality: 18, dcDrift: 0.3 }],
    ],
  },
];

export function SourcePanel({ onOpen }: Props): JSX.Element {
  const { t, core, err, num } = useI18n();
  const source = useStore((s) => s.source);
  const doc = useStore((s) => s.doc);
  const loadDocument = useStore((s) => s.loadDocument);
  const setSeed = useStore((s) => s.setSeed);
  const setNoiseMode = useStore((s) => s.setNoiseMode);
  const presetRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);

  const applyStarter = (starter: (typeof STARTERS)[number]): void => {
    const layers: EffectLayer[] = starter.layers.map(([type, overrides]) => {
      const proc = requireProcessor(type);
      const base = createLayer(type);
      return { ...base, params: { ...defaultParams(proc.params), ...overrides } as EffectLayer['params'] };
    });
    const next: DitherDocument = { ...doc, layers, paletteId: starter.paletteId };
    loadDocument(next);
  };

  const palette = activePalette(doc);

  return (
    <>
      <Section title={t('source.title')}>
        <div className="row">
          <button className="btn primary" onClick={onOpen}>
            {t('source.open')}
          </button>
        </div>
        {source ? (
          <div className="hint">
            <div><strong>{source.name}</strong></div>
            <div>{source.width} × {source.height} px</div>
            <div>{t('source.megapixel', { mp: num((source.width * source.height) / 1e6, 1) })}</div>
          </div>
        ) : (
          <div className="hint">{t('source.hint', { key: mod('V') })}</div>
        )}
      </Section>

      <Section title={t('source.quick')}>
        <div className="add-grid">
          {STARTERS.map((s) => (
            <button key={s.key} className="btn" onClick={() => applyStarter(s)}>
              {t(s.key)}
            </button>
          ))}
        </div>
        <div className="hint">{t('source.quickHint')}</div>
      </Section>

      <Section title={t('source.determinism')} defaultOpen={false}>
        <div className="field">
          <div className="label"><span>{t('source.seed')}</span></div>
          <div className="slider-row">
            <input
              className="num"
              style={{ flex: 1, textAlign: 'left' }}
              aria-label={t('source.seed')}
              value={String(doc.seed)}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) setSeed(Math.floor(n));
              }}
            />
            <button
              className="btn icon"
              onClick={() => setSeed(Math.floor(Math.random() * 100000))}
              title={t('source.newSeed')}
              aria-label={t('source.newSeed')}
            >⟳</button>
          </div>
        </div>
        <div className="field">
          <div className="label"><span>{t('source.temporal')}</span></div>
          <select value={doc.noiseMode} onChange={(e) => setNoiseMode(e.target.value as NoiseMode)} aria-label={t('source.temporal')}>
            <option value="static">{t('source.static')}</option>
            <option value="perFrame">{t('source.perFrame')}</option>
            <option value="cycling">{t('source.cycling')}</option>
          </select>
        </div>
        {doc.noiseMode === 'cycling' ? (
          <div className="field">
            <div className="label">
              <span>{t('source.loop')}</span>
              <span className="unit">{t('source.frames', { n: doc.cycleLength })}</span>
            </div>
            <input
              type="range" min={2} max={120} value={doc.cycleLength}
              aria-label={t('source.loop')}
              onChange={(e) => setNoiseMode('cycling', Number(e.target.value))}
              style={{ width: '100%', accentColor: 'var(--accent)' }}
            />
          </div>
        ) : null}
        <div className="hint">{t('source.seedHint')}</div>
      </Section>

      <Section title={t('source.presets')} defaultOpen={false}>
        <div className="row">
          <button
            className="btn"
            onClick={() =>
              saveFile(serializePreset(doc, palette?.name ?? 'preset'), 'ditherlab-preset.json', 'application/json')
            }
          >
            {t('source.save')}
          </button>
          <button className="btn" onClick={() => presetRef.current?.click()}>{t('source.load')}</button>
          {!isDesktop() ? (
            <button
              className="btn"
              onClick={() => {
                const fragment = presetToFragment(doc, t('source.sharedName'));
                const url = `${location.origin}${location.pathname}#p=${fragment}`;
                void navigator.clipboard?.writeText(url);
                setMessage(t('source.linkCopied', { n: url.length }));
              }}
            >
              {t('source.share')}
            </button>
          ) : null}
        </div>
        <input
          ref={presetRef}
          type="file"
          accept=".json"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            try {
              const { doc: next, warnings } = parsePreset(await f.text());
              loadDocument(next);
              setMessage(warnings.length > 0 ? warnings.map(core).join(' · ') : t('source.presetLoaded'));
            } catch (error) {
              setMessage(err(error));
            }
          }}
        />
        {!isDesktop() ? (
          <button
            className="btn"
            style={{ marginTop: 6 }}
            onClick={() => {
              const fragment = location.hash.startsWith('#p=') ? location.hash.slice(3) : '';
              if (!fragment) {
                setMessage(t('source.noPresetInUrl'));
                return;
              }
              try {
                const { doc: next } = presetFromFragment(fragment);
                loadDocument(next);
                setMessage(t('source.presetFromLink'));
              } catch (error) {
                setMessage(err(error));
              }
            }}
          >
            {t('source.loadFromUrl')}
          </button>
        ) : null}
        {message ? <div className="hint">{message}</div> : null}
      </Section>
    </>
  );
}
