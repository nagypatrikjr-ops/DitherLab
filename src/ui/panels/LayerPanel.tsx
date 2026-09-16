import { useMemo, useState } from 'react';
import { Section } from '../components/Section';
import { Icon } from '../components/Icon';
import { ParamControls } from '../components/ParamControls';
import { NumberSlider } from '../components/NumberSlider';
import { useStore } from '../../state/store';
import { allProcessors, getProcessor } from '../../core/dither/registry';
import { BLEND_MODES } from '../../core/blend';
import type { BlendMode, ProcessorCategory } from '../../core/types';
import { useI18n, type MessageKey } from '../../i18n';

const CATEGORY_KEYS: Record<ProcessorCategory, MessageKey> = {
  errorDiffusion: 'cat.errorDiffusion',
  ordered: 'cat.ordered',
  halftone: 'cat.halftone',
  modulated: 'cat.modulated',
  adjust: 'cat.adjust',
  stylize: 'cat.stylize',
  glitch: 'cat.glitch',
  blur: 'cat.blur',
};

const CATEGORY_ORDER: ProcessorCategory[] = [
  'errorDiffusion', 'ordered', 'halftone', 'modulated',
  'adjust', 'blur', 'stylize', 'glitch',
];

export function LayerPanel(): JSX.Element {
  const { t, core } = useI18n();
  const layers = useStore((s) => s.doc.layers);
  const selectedId = useStore((s) => s.selectedLayerId);
  const addLayer = useStore((s) => s.addLayer);
  const removeLayer = useStore((s) => s.removeLayer);
  const duplicateLayer = useStore((s) => s.duplicateLayer);
  const moveLayer = useStore((s) => s.moveLayer);
  const toggleLayer = useStore((s) => s.toggleLayer);
  const selectLayer = useStore((s) => s.selectLayer);
  const setLayerOpacity = useStore((s) => s.setLayerOpacity);
  const setLayerBlend = useStore((s) => s.setLayerBlend);
  const setParam = useStore((s) => s.setParam);
  const commitDrag = useStore((s) => s.commitDrag);

  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const grouped = useMemo(() => {
    const procs = allProcessors();
    return CATEGORY_ORDER.map((c) => ({
      category: c,
      items: procs.filter((p) => p.category === c),
    })).filter((g) => g.items.length > 0);
  }, []);

  const selected = layers.find((l) => l.id === selectedId) ?? null;
  const proc = selected ? getProcessor(selected.type) : null;

  return (
    <>
      <Section
        title={t('layers.title', { n: layers.length })}
        right={
          <select
            value=""
            style={{ width: 108 }}
            aria-label={t('layers.addTitle')}
            title={t('layers.addTitle')}
            onChange={(e) => {
              if (e.target.value) addLayer(e.target.value);
              e.target.value = '';
            }}
          >
            <option value="">{t('layers.add')}</option>
            {grouped.map((g) => (
              <optgroup key={g.category} label={t(CATEGORY_KEYS[g.category])}>
                {g.items.map((p) => (
                  <option key={p.id} value={p.id}>{core(p.name)}</option>
                ))}
              </optgroup>
            ))}
          </select>
        }
      >
        {layers.length === 0 ? <div className="hint">{t('layers.empty')}</div> : null}
        <div className="layer-list">
          {layers.map((layer, index) => {
            const p = getProcessor(layer.type);
            const name = core(layer.name ?? p?.name ?? layer.type);
            return (
              <div
                key={layer.id}
                className={[
                  'layer',
                  layer.id === selectedId ? 'selected' : '',
                  layer.enabled ? '' : 'disabled',
                  dropIndex === index ? 'drop-target' : '',
                ].join(' ').trim()}
                onClick={() => selectLayer(layer.id)}
                draggable
                onDragStart={(e) => {
                  setDragId(layer.id);
                  // Firefox refuses to start a drag that carries no payload.
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', layer.id);
                }}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropIndex(index); }}
                onDragLeave={() => setDropIndex((v) => (v === index ? null : v))}
                onDrop={(e) => {
                  e.preventDefault();
                  const id = dragId ?? e.dataTransfer.getData('text/plain');
                  if (id) moveLayer(id, index);
                  setDragId(null);
                  setDropIndex(null);
                }}
                onDragEnd={() => { setDragId(null); setDropIndex(null); }}
                onKeyDown={(e) => {
                  // Alt + arrows move the layer; plain arrows still scroll.
                  if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
                  e.preventDefault();
                  const to = e.key === 'ArrowUp' ? index - 1 : index + 1;
                  if (to >= 0 && to < layers.length) moveLayer(layer.id, to);
                }}
              >
                <span className="idx">{index + 1}</span>
                <span className="drag" title={t('layers.drag')}><Icon name="grip" size={12} /></span>
                <button
                  className="mini"
                  title={layer.enabled ? t('layers.disable') : t('layers.enable')}
                  aria-label={layer.enabled ? t('layers.disable') : t('layers.enable')}
                  aria-pressed={layer.enabled}
                  onClick={(e) => { e.stopPropagation(); toggleLayer(layer.id); }}
                >
                  <Icon name={layer.enabled ? 'lampOn' : 'lampOff'} size={12} />
                </button>
                <button
                  className="layer-name"
                  onClick={(e) => { e.stopPropagation(); selectLayer(layer.id); }}
                  aria-current={layer.id === selectedId}
                >
                  {name}
                </button>
                <button
                  className="mini"
                  title={t('common.duplicate')}
                  aria-label={t('common.duplicate')}
                  onClick={(e) => { e.stopPropagation(); duplicateLayer(layer.id); }}
                ><Icon name="duplicate" size={12} /></button>
                <button
                  className="mini"
                  title={t('common.remove')}
                  aria-label={t('common.remove')}
                  onClick={(e) => { e.stopPropagation(); removeLayer(layer.id); }}
                ><Icon name="close" size={12} /></button>
              </div>
            );
          })}
        </div>
      </Section>

      {selected && proc ? (
        <Section title={core(proc.name)}>
          <div className="field">
            <div className="label"><span>{t('layers.blend')}</span></div>
            <select
              aria-label={t('layers.blend')}
              value={selected.blendMode}
              onChange={(e) => setLayerBlend(selected.id, e.target.value as BlendMode)}
            >
              {BLEND_MODES.map((m) => (
                <option key={m.value} value={m.value}>{core(m.label)}</option>
              ))}
            </select>
          </div>
          <NumberSlider
            label={t('layers.opacity')}
            value={selected.opacity}
            min={0}
            max={1}
            step={0.01}
            onChange={(v, transient) => setLayerOpacity(selected.id, v, transient)}
            onCommit={commitDrag}
          />
          <ParamControls
            schema={proc.params}
            values={selected.params}
            onChange={(key, value, transient) => setParam(selected.id, key, value, transient)}
            onCommit={commitDrag}
          />
          <div className="hint" style={{ marginTop: 10 }}>
            {proc.vectorizable ? t('layers.vectorizable') : t('layers.notVector')}
          </div>
        </Section>
      ) : (
        <Section title={t('layers.params')}>
          <div className="hint">{t('layers.select')}</div>
        </Section>
      )}
    </>
  );
}
