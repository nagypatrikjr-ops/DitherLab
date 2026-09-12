import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';

interface Props {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  curve?: 'linear' | 'log';
  onChange: (value: number, transient: boolean) => void;
  onCommit: () => void;
}

function toNorm(value: number, min: number, max: number, log: boolean): number {
  if (!log) return (value - min) / (max - min || 1);
  const lo = Math.log(Math.max(1e-6, min));
  const hi = Math.log(Math.max(1e-6, max));
  return (Math.log(Math.max(1e-6, value)) - lo) / (hi - lo || 1);
}

function fromNorm(t: number, min: number, max: number, log: boolean): number {
  if (!log) return min + t * (max - min);
  const lo = Math.log(Math.max(1e-6, min));
  const hi = Math.log(Math.max(1e-6, max));
  return Math.exp(lo + t * (hi - lo));
}

/**
 * Slider with a paired numeric field.
 *
 * Dragging emits transient updates (no undo entry); releasing commits one.
 * Holding shift divides the travel by ten for fine tuning. The track is also
 * a keyboard slider: arrows step, Shift+arrows step ten, Home/End jump.
 */
export function NumberSlider({
  label, value, min, max, step = 0.01, unit, curve, onChange, onCommit,
}: Props): JSX.Element {
  const { t, lang } = useI18n();
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const fineAnchor = useRef<{ x: number; value: number } | null>(null);
  const [text, setText] = useState<string>(String(value));
  const [editing, setEditing] = useState(false);
  const log = curve === 'log';

  useEffect(() => {
    if (!editing) setText(formatValue(value, step, lang === 'hu'));
  }, [value, step, editing, lang]);

  const quantize = useCallback(
    (v: number): number => {
      const clamped = Math.min(max, Math.max(min, v));
      if (step <= 0) return clamped;
      const snapped = Math.round((clamped - min) / step) * step + min;
      return Math.min(max, Math.max(min, Number(snapped.toFixed(6))));
    },
    [min, max, step],
  );

  const applyFromPointer = useCallback(
    (clientX: number, shift: boolean) => {
      const el = trackRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (shift) {
        if (fineAnchor.current === null) {
          fineAnchor.current = { x: clientX, value };
        }
        const dx = (clientX - fineAnchor.current.x) / rect.width;
        const base = toNorm(fineAnchor.current.value, min, max, log);
        onChange(quantize(fromNorm(Math.min(1, Math.max(0, base + dx * 0.1)), min, max, log)), true);
        return;
      }
      fineAnchor.current = null;
      const tNorm = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      onChange(quantize(fromNorm(tNorm, min, max, log)), true);
    },
    [min, max, log, onChange, quantize, value],
  );

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    dragging.current = true;
    fineAnchor.current = null;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    applyFromPointer(e.clientX, e.shiftKey);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return;
    applyFromPointer(e.clientX, e.shiftKey);
  };

  const endDrag = (): void => {
    if (!dragging.current) return;
    dragging.current = false;
    fineAnchor.current = null;
    onCommit();
  };

  const handleKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const unitStep = step > 0 ? step : (max - min) / 100;
    const big = e.shiftKey ? 10 : 1;
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = value + unitStep * big;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = value - unitStep * big;
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    if (next === null) return;
    e.preventDefault();
    onChange(quantize(next), false);
  };

  const commitText = (): void => {
    setEditing(false);
    const parsed = Number(text.replace(',', '.'));
    if (Number.isFinite(parsed)) {
      onChange(quantize(parsed), false);
    } else {
      setText(formatValue(value, step, lang === 'hu'));
    }
  };

  const norm = toNorm(value, min, max, log);
  const pct = `${Math.min(100, Math.max(0, norm * 100))}%`;
  const shown = formatValue(value, step, lang === 'hu');

  return (
    <div className="field">
      <div className="label">
        <span>{label}</span>
        {unit ? <span className="unit">{unit}</span> : null}
      </div>
      <div className="slider-row">
        <div
          className="slider"
          ref={trackRef}
          role="slider"
          tabIndex={0}
          aria-label={label}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          aria-valuetext={unit ? `${shown} ${unit}` : shown}
          title={t('params.fine')}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={handleKey}
          onDoubleClick={() => {
            onChange(quantize(value), false);
          }}
        >
          <div className="track" />
          <div className="fill" style={{ width: pct }} />
          <div className="knob" style={{ left: pct }} />
        </div>
        <input
          className="num"
          value={text}
          inputMode="decimal"
          aria-label={label}
          onFocus={() => setEditing(true)}
          onChange={(e) => setText(e.target.value)}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              setText(formatValue(value, step, lang === 'hu'));
              setEditing(false);
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      </div>
    </div>
  );
}

function formatValue(v: number, step: number, comma: boolean): string {
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
  const s = v.toFixed(decimals).replace(/\.?0+$/, (m) => (m.includes('.') ? '' : m));
  return comma ? s.replace('.', ',') : s;
}
