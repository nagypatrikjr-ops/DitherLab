import { Fragment } from 'react';
import type { ParamBag, ParamSchema, ParamValue, RGB } from '../../core/types';
import { rgbToHex, hexToRgb } from '../../core/palette/builtin';
import { useI18n } from '../../i18n';
import { NumberSlider } from './NumberSlider';

interface Props {
  schema: ParamSchema;
  values: ParamBag;
  onChange: (key: string, value: ParamValue, transient: boolean) => void;
  onCommit: () => void;
}

/**
 * Renders a whole parameter panel straight from the schema, so adding a
 * parameter to an algorithm is enough to make it appear in the UI. Labels come
 * from the core and are translated on the way to the screen.
 */
export function ParamControls({ schema, values, onChange, onCommit }: Props): JSX.Element {
  const { t, core } = useI18n();
  const groups = new Map<string, string[]>();
  for (const key of Object.keys(schema)) {
    const g = schema[key].group ?? '';
    const list = groups.get(g);
    if (list) list.push(key);
    else groups.set(g, [key]);
  }

  return (
    <>
      {[...groups.entries()].map(([group, groupKeys]) => (
        <Fragment key={group}>
          <div className="group-title">{group === '' ? t('params.general') : core(group)}</div>
          {groupKeys.map((key) => (
            <Control key={key} name={key} schema={schema} values={values} onChange={onChange} onCommit={onCommit} />
          ))}
        </Fragment>
      ))}
    </>
  );
}

function Control({ name, schema, values, onChange, onCommit }: Props & { name: string }): JSX.Element | null {
  const { t, core } = useI18n();
  const spec = schema[name];
  const value = values[name];
  const label = core(spec.label);

  switch (spec.kind) {
    case 'float':
    case 'int':
      return (
        <NumberSlider
          label={label}
          value={typeof value === 'number' ? value : spec.default}
          min={spec.min}
          max={spec.max}
          step={spec.kind === 'int' ? 1 : spec.step}
          unit={spec.unit === undefined ? undefined : core(spec.unit)}
          curve={spec.kind === 'float' ? spec.curve : 'linear'}
          onChange={(v, transient) => onChange(name, spec.kind === 'int' ? Math.round(v) : v, transient)}
          onCommit={onCommit}
        />
      );

    case 'angle':
      return (
        <NumberSlider
          label={label}
          value={typeof value === 'number' ? value : spec.default}
          min={-360}
          max={360}
          step={0.5}
          unit="°"
          onChange={(v, transient) => onChange(name, v, transient)}
          onCommit={onCommit}
        />
      );

    case 'seed':
      return (
        <div className="field">
          <div className="label"><span>{label}</span></div>
          <div className="slider-row">
            <input
              className="num"
              style={{ flex: 1, textAlign: 'left' }}
              aria-label={label}
              value={String(typeof value === 'number' ? value : spec.default)}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) onChange(name, Math.floor(n), false);
              }}
            />
            <button
              className="btn icon"
              title={t('common.newSeed')}
              aria-label={t('common.newSeed')}
              onClick={() => onChange(name, Math.floor(Math.random() * 100000), false)}
            >
              ⟳
            </button>
          </div>
        </div>
      );

    case 'bool':
      return (
        <div className="row">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={typeof value === 'boolean' ? value : spec.default}
              onChange={(e) => onChange(name, e.target.checked, false)}
            />
            <span>{label}</span>
          </label>
        </div>
      );

    case 'enum':
      return (
        <div className="field">
          <div className="label"><span>{label}</span></div>
          <select
            aria-label={label}
            value={typeof value === 'string' ? value : spec.default}
            onChange={(e) => onChange(name, e.target.value, false)}
          >
            {spec.options.map((o) => (
              <option key={o.value} value={o.value}>{core(o.label)}</option>
            ))}
          </select>
        </div>
      );

    case 'text':
      return (
        <div className="field">
          <div className="label"><span>{label}</span></div>
          {spec.default.includes('\n') ? (
            <textarea
              rows={4}
              aria-label={label}
              value={typeof value === 'string' ? value : spec.default}
              onChange={(e) => onChange(name, e.target.value, false)}
            />
          ) : (
            <input
              type="text"
              aria-label={label}
              value={typeof value === 'string' ? value : spec.default}
              onChange={(e) => onChange(name, e.target.value, false)}
            />
          )}
        </div>
      );

    case 'color': {
      const rgb: RGB = typeof value === 'object' && value !== null && 'r' in value ? (value as RGB) : spec.default;
      return (
        <div className="field">
          <div className="label"><span>{label}</span></div>
          <div className="slider-row">
            <input
              type="color"
              aria-label={label}
              style={{ width: 28, height: 22, padding: 0, background: 'none', border: 'none' }}
              value={rgbToHex(rgb.r, rgb.g, rgb.b)}
              onChange={(e) => {
                const [r, g, b] = hexToRgb(e.target.value);
                onChange(name, { r, g, b }, false);
              }}
            />
            <input
              type="text"
              aria-label={label}
              value={rgbToHex(rgb.r, rgb.g, rgb.b)}
              onChange={(e) => {
                try {
                  const [r, g, b] = hexToRgb(e.target.value);
                  onChange(name, { r, g, b }, false);
                } catch {
                  /* keep typing */
                }
              }}
            />
          </div>
        </div>
      );
    }

    case 'matrix': {
      const values2 = Array.isArray(value) ? (value as readonly number[]) : spec.default;
      return (
        <div className="field">
          <div className="label"><span>{label}</span></div>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${spec.cols}, 1fr)`, gap: 3 }}>
            {Array.from({ length: spec.rows * spec.cols }, (_, i) => {
              const isOrigin = i === Math.floor((spec.cols - 1) / 2);
              return (
                <input
                  key={i}
                  className="num"
                  style={{
                    width: '100%',
                    textAlign: 'center',
                    opacity: isOrigin ? 0.45 : 1,
                    borderColor: isOrigin ? 'var(--accent-dim)' : undefined,
                  }}
                  title={isOrigin ? t('params.origin') : undefined}
                  value={String(values2[i] ?? 0)}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    const next = [...values2];
                    next[i] = Number.isFinite(n) ? n : 0;
                    onChange(name, next, false);
                  }}
                />
              );
            })}
          </div>
          <div className="hint">{t('params.matrixHint')}</div>
        </div>
      );
    }
  }
}
