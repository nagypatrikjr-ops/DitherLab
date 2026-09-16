/**
 * The icon set.
 *
 * Every mark is drawn on the same 16-unit grid with the same 1.5-unit stroke,
 * so a row of them lines up the way engraved control labels do. Unicode
 * symbols were used here before; they are a different size, weight and
 * baseline in every font the app can land on, which is exactly the kind of
 * accidental variation a control panel must not have.
 */

export type IconName =
  | 'undo'
  | 'redo'
  | 'settings'
  | 'close'
  | 'duplicate'
  | 'grip'
  | 'lampOn'
  | 'lampOff'
  | 'chevron'
  | 'plus'
  | 'minus'
  | 'check'
  | 'alert'
  | 'cross'
  | 'info'
  | 'dots'
  | 'zoomIn'
  | 'zoomOut'
  | 'fit'
  | 'search'
  | 'folder'
  | 'raise'
  | 'refresh';

interface Props {
  readonly name: IconName;
  /** Edge length in pixels. Stays on the 16-grid, so strokes keep their weight. */
  readonly size?: number;
  readonly className?: string;
}

/** Stroked outlines. Anything filled is listed in `FILLED` instead. */
const PATHS: Record<IconName, string> = {
  undo: 'M3.2 7.5h6.3a3.4 3.4 0 1 1 0 6.8H6.3M6.2 4.5 3.2 7.5l3 3',
  redo: 'M12.8 7.5H6.5a3.4 3.4 0 1 0 0 6.8h3.2M9.8 4.5l3 3-3 3',
  settings: 'M2.5 4.5h11M2.5 8h11M2.5 11.5h11',
  close: 'M4 4l8 8M12 4l-8 8',
  duplicate: 'M6 6h7v7H6zM10.5 6V3H3.5v7H6',
  grip: '',
  lampOn: '',
  lampOff: '',
  chevron: 'M6.2 3.8 10.4 8l-4.2 4.2',
  plus: 'M8 3v10M3 8h10',
  minus: 'M3 8h10',
  check: 'M3.4 8.4l3.1 3.1 6.1-6.4',
  alert: 'M8 2.6 14.4 13.4H1.6zM8 6.6v3.1',
  cross: 'M4.6 4.6l6.8 6.8M11.4 4.6l-6.8 6.8',
  info: 'M8 7.4v4.2',
  dots: '',
  zoomIn: 'M11.1 11.1 14 14M4.9 7.1h4.4M7.1 4.9v4.4',
  zoomOut: 'M11.1 11.1 14 14M4.9 7.1h4.4',
  fit: 'M2.6 6V2.6H6M10 2.6h3.4V6M13.4 10v3.4H10M6 13.4H2.6V10',
  search: 'M11.1 11.1 14 14',
  folder: 'M2 12.8V3.6h3.9l1.3 1.7h6.8v7.5z',
  raise: 'M8 12.8V3.6M4.4 7.2 8 3.6l3.6 3.6',
  refresh: 'M13 8a5 5 0 1 1-1.6-3.7M13.3 2.6v2.9h-2.9',
};

/** Icons whose shape is a set of discs rather than a stroked path. */
const FILLED: Partial<Record<IconName, [number, number, number][]>> = {
  grip: [
    [6, 4, 1],
    [10, 4, 1],
    [6, 8, 1],
    [10, 8, 1],
    [6, 12, 1],
    [10, 12, 1],
  ],
  lampOn: [[8, 8, 3.1]],
  dots: [
    [3.2, 8, 1.15],
    [8, 8, 1.15],
    [12.8, 8, 1.15],
  ],
  alert: [[8, 12.3, 0.85]],
  info: [[8, 4.9, 0.85]],
};

/** Icons that also need a plain stroked circle, drawn before the paths. */
const RING: Partial<Record<IconName, [number, number, number]>> = {
  lampOn: [8, 8, 5],
  lampOff: [8, 8, 5],
  zoomIn: [7.1, 7.1, 4.3],
  zoomOut: [7.1, 7.1, 4.3],
  search: [7.1, 7.1, 4.3],
};

export function Icon({ name, size = 14, className }: Props): JSX.Element {
  const ring = RING[name];
  const discs = FILLED[name];
  const path = PATHS[name];
  return (
    <svg
      className={className === undefined ? 'icon' : `icon ${className}`}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      {ring ? <circle cx={ring[0]} cy={ring[1]} r={ring[2]} /> : null}
      {path ? <path d={path} /> : null}
      {discs?.map(([cx, cy, r]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} className="ic-fill" />)}
    </svg>
  );
}
