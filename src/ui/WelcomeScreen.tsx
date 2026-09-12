import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n';
import { clearRecent, listRecent, removeRecent, type RecentMeta } from '../io/recent';
import { usePrefs } from '../state/prefs';
import { mod } from './platform';
import type { StudioMode } from './ShirtStudio';

interface Props {
  onOpen: (then?: StudioMode) => void;
  onSample: () => void;
  onRecent: (id: string) => void;
  onHelp: () => void;
}

function DitherIcon(): JSX.Element {
  const cells: JSX.Element[] = [];
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < 6; x++) {
      if ((x + y) % 2 === 0 || x < y - 1) cells.push(<rect key={`${x}-${y}`} x={x * 4} y={y * 4} width={4} height={4} />);
    }
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true">{cells}</svg>;
}

function ShirtIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 3 3.5 5.5 5 10l2-1v12h10V9l2 1 1.5-4.5L16 3c-.8 1.4-2.2 2.2-4 2.2S8.8 4.4 8 3Z" />
    </svg>
  );
}

function FilmIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 3h16v18H4Zm2 2v2h2V5Zm0 4v2h2V9Zm0 4v2h2v-2Zm0 4v2h2v-2Zm10-12v2h2V5Zm0 4v2h2V9Zm0 4v2h2v-2Zm0 4v2h2v-2ZM9.5 6v12h5V6Z" fillRule="evenodd" />
    </svg>
  );
}

/** Shown in place of the canvas until an image is open. */
export function WelcomeScreen({ onOpen, onSample, onRecent, onHelp }: Props): JSX.Element {
  const { t } = useI18n();
  const keepRecent = usePrefs((s) => s.keepRecent);
  const [recent, setRecent] = useState<RecentMeta[]>([]);

  useEffect(() => {
    let alive = true;
    if (!keepRecent) {
      setRecent([]);
      return undefined;
    }
    void listRecent().then((items) => {
      if (alive) setRecent(items);
    });
    return () => {
      alive = false;
    };
  }, [keepRecent]);

  const thumbs = useMemo(() => recent.map((r) => ({ ...r, url: URL.createObjectURL(r.thumb) })), [recent]);
  useEffect(() => () => thumbs.forEach((x) => URL.revokeObjectURL(x.url)), [thumbs]);

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <h1>{t('welcome.title')}</h1>
        <p className="welcome-sub">{t('welcome.subtitle')}</p>

        <div className="welcome-drop">
          <div className="welcome-drop-title">{t('welcome.drop')}</div>
          <div className="welcome-or">{t('welcome.or')}</div>
          <div className="welcome-actions">
            <button className="btn primary big" onClick={() => onOpen()}>{t('welcome.open')}</button>
            <button className="btn big" onClick={onSample}>{t('welcome.sample')}</button>
          </div>
          <div className="hint">{t('welcome.paste', { key: mod('V') })}</div>
          <div className="hint">{t('welcome.formats')}</div>
        </div>

        <h2>{t('welcome.what')}</h2>
        <div className="welcome-cards">
          <button className="welcome-card" onClick={() => onOpen()}>
            <span className="wc-icon"><DitherIcon /></span>
            <strong>{t('welcome.artTitle')}</strong>
            <span>{t('welcome.artText')}</span>
          </button>
          <button className="welcome-card featured" onClick={() => onOpen('dtf')}>
            <span className="wc-icon"><ShirtIcon /></span>
            <strong>{t('welcome.dtfTitle')}</strong>
            <span>{t('welcome.dtfText')}</span>
          </button>
          <button className="welcome-card" onClick={() => onOpen('screen')}>
            <span className="wc-icon"><FilmIcon /></span>
            <strong>{t('welcome.screenTitle')}</strong>
            <span>{t('welcome.screenText')}</span>
          </button>
        </div>

        {thumbs.length > 0 ? (
          <>
            <div className="welcome-recent-head">
              <h2>{t('welcome.recent')}</h2>
              <button
                className="btn small"
                onClick={() => {
                  void clearRecent();
                  setRecent([]);
                }}
              >
                {t('welcome.clearRecent')}
              </button>
            </div>
            <div className="welcome-recent">
              {thumbs.map((r) => (
                <div key={r.id} className="recent-item">
                  <button className="recent-open" onClick={() => onRecent(r.id)} title={r.name}>
                    <img src={r.url} alt="" />
                    <span className="recent-name">{r.name}</span>
                    <span className="recent-size">{r.width}×{r.height}</span>
                  </button>
                  <button
                    className="recent-remove"
                    aria-label={t('welcome.removeRecent')}
                    title={t('welcome.removeRecent')}
                    onClick={() => {
                      void removeRecent(r.id);
                      setRecent((items) => items.filter((x) => x.id !== r.id));
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </>
        ) : null}

        <div className="welcome-foot">
          <span>{t('welcome.privacy')}</span>
          <button className="link" onClick={onHelp}>{t('welcome.guide')}</button>
        </div>
      </div>
    </div>
  );
}
