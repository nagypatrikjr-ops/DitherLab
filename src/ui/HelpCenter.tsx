import { useMemo, useState } from 'react';
import { version } from '../../package.json';
import { useI18n, type MessageKey } from '../i18n';
import { Modal } from './components/Modal';
import { helpContent } from './help/content';
import { isDesktop, mod, redoKey } from './platform';

export type HelpTab = 'start' | 'dtf' | 'glossary' | 'keys' | 'about';

interface Props {
  tab: HelpTab;
  onTab: (tab: HelpTab) => void;
  onClose: () => void;
  onOpenImage: () => void;
  onOpenDtf: () => void;
  hasImage: boolean;
}

const TABS: readonly [HelpTab, MessageKey][] = [
  ['start', 'help.tabStart'],
  ['dtf', 'help.tabDtf'],
  ['glossary', 'help.tabGlossary'],
  ['keys', 'help.tabKeys'],
  ['about', 'help.tabAbout'],
];

export function HelpCenter({ tab, onTab, onClose, onOpenImage, onOpenDtf, hasImage }: Props): JSX.Element {
  const { t, lang } = useI18n();
  const [query, setQuery] = useState('');
  const content = useMemo(() => helpContent(lang, mod, version), [lang]);

  const keys: [string, MessageKey][] = [
    [mod('O'), 'keys.open'],
    [mod('V'), 'keys.paste'],
    [mod('S'), 'keys.export'],
    [mod('P'), 'keys.dtf'],
    [mod('Z'), 'keys.undo'],
    [redoKey(), 'keys.redo'],
    [t('keys.space'), 'keys.before'],
    ['C', 'keys.compare'],
    ['F', 'keys.fit'],
    ['0', 'keys.actual'],
    ['+ / −', 'keys.zoom'],
    [t('keys.wheelKey'), 'keys.wheel'],
    [t('keys.dragKey'), 'keys.pan'],
    [t('keys.arrowsKey'), 'keys.arrows'],
    [t('keys.dblclickKey'), 'keys.dblclick'],
    ['1–9', 'keys.layers'],
    [t('keys.moveLayerKey'), 'keys.moveLayer'],
    ['R', 'keys.render'],
    [t('keys.shiftDrag'), 'keys.fine'],
    ['?', 'keys.help'],
    [mod(','), 'keys.settings'],
    ['Esc', 'keys.close'],
    ...(isDesktop() ? ([[`${mod('=')} / ${mod('−')} / ${mod('0')}`, 'keys.uiSize']] as [string, MessageKey][]) : []),
  ];

  const q = query.trim().toLowerCase();
  const terms = content.glossary.filter((g) => q === '' || `${g.title} ${g.text}`.toLowerCase().includes(q));

  return (
    <Modal title={t('help.title')} onClose={onClose} wide>
      <div className="help-layout">
        <nav className="help-tabs" aria-label={t('help.title')}>
          {TABS.map(([id, key]) => (
            <button key={id} className={`help-tab${tab === id ? ' active' : ''}`} onClick={() => onTab(id)}>
              {t(key)}
            </button>
          ))}
        </nav>
        <div className="help-page">
          {tab === 'start' ? (
            <>
              <p className="help-intro">{content.start.intro}</p>
              <ol className="help-steps">
                {content.start.steps.map((s) => (
                  <li key={s.title}>
                    <strong>{s.title}</strong>
                    <span>{s.text}</span>
                  </li>
                ))}
              </ol>
              <h3>{content.start.tipsTitle}</h3>
              <ul className="help-list">
                {content.start.tips.map((tip) => <li key={tip}>{tip}</li>)}
              </ul>
              {!hasImage ? (
                <button className="btn primary" onClick={onOpenImage}>{t('help.openImage')}</button>
              ) : null}
            </>
          ) : null}

          {tab === 'dtf' ? (
            <>
              <p className="help-intro">{content.dtf.intro}</p>
              <ol className="help-steps">
                {content.dtf.steps.map((s) => (
                  <li key={s.title}>
                    <strong>{s.title}</strong>
                    <span>{s.text}</span>
                  </li>
                ))}
              </ol>
              <h3>{content.dtf.milkyTitle}</h3>
              <p>{content.dtf.milky}</p>
              <h3>{content.dtf.shopTitle}</h3>
              <ul className="help-list">
                {content.dtf.shop.map((x) => <li key={x}>{x}</li>)}
              </ul>
              <h3>{content.dtf.pressTitle}</h3>
              <ul className="help-list">
                {content.dtf.press.map((x) => <li key={x}>{x}</li>)}
              </ul>
              <button className="btn primary" onClick={hasImage ? onOpenDtf : onOpenImage}>
                {hasImage ? t('help.openDtf') : t('help.openImage')}
              </button>
            </>
          ) : null}

          {tab === 'glossary' ? (
            <>
              <input
                type="search"
                className="help-search"
                placeholder={t('help.search')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <dl className="glossary">
                {terms.map((g) => (
                  <div key={g.title} className="glossary-item">
                    <dt>{g.title}</dt>
                    <dd>{g.text}</dd>
                  </div>
                ))}
              </dl>
              {terms.length === 0 ? <p className="hint">{t('help.noMatch', { q: query })}</p> : null}
            </>
          ) : null}

          {tab === 'keys' ? (
            <table className="keys-table">
              <tbody>
                {keys.map(([k, d]) => (
                  <tr key={d}>
                    <td><kbd>{k}</kbd></td>
                    <td>{t(d)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}

          {tab === 'about' ? (
            <>
              {content.about.map((p) => <p key={p}>{p}</p>)}
            </>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
