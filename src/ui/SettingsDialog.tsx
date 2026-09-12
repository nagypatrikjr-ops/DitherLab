import { useEffect, useState } from 'react';
import { version } from '../../package.json';
import { LANGUAGES, useI18n, useLanguage, type Language } from '../i18n';
import { UI_SCALES, usePrefs } from '../state/prefs';
import { clearRecent } from '../io/recent';
import { readLocal, writeLocal } from '../ai/images';
import { Modal } from './components/Modal';
import { clearDtfMemory } from './dtfMemory';
import { toast } from './toasts';
import { isMac } from './platform';

interface Props {
  onClose: () => void;
}

export function SettingsDialog({ onClose }: Props): JSX.Element {
  const { t } = useI18n();
  const language = useLanguage((s) => s.language);
  const setLanguage = useLanguage((s) => s.setLanguage);
  const prefs = usePrefs();
  const desktop = window.ditherlabDesktop;
  const [save, setSave] = useState<DesktopSaveSettings | null>(null);
  const [hasKey, setHasKey] = useState(() => (readLocal('ditherlab.claude.key') ?? '') !== '');

  useEffect(() => {
    let alive = true;
    if (desktop) {
      void desktop.getSaveSettings().then((s) => {
        if (alive) setSave(s);
      });
    }
    return () => {
      alive = false;
    };
  }, [desktop]);

  return (
    <Modal title={t('settings.title')} onClose={onClose}>
      <div className="settings">
        <section>
          <h3>{t('common.language')}</h3>
          <div className="seg">
            {LANGUAGES.map((l) => (
              <button
                key={l.id}
                className={`btn${language === l.id ? ' active' : ''}`}
                onClick={() => setLanguage(l.id as Language)}
              >
                {l.name}
              </button>
            ))}
          </div>
        </section>

        <section>
          <h3>{t('settings.uiSize')}</h3>
          {desktop ? (
            <div className="seg">
              {UI_SCALES.map((s) => (
                <button
                  key={s}
                  className={`btn${Math.abs(prefs.uiScale - s) < 0.01 ? ' active' : ''}`}
                  onClick={() => prefs.setPref('uiScale', s)}
                >
                  {Math.round(s * 100)}%
                </button>
              ))}
            </div>
          ) : (
            <p className="hint">{t('settings.uiSizeWeb', { key: isMac() ? '⌘' : 'Ctrl' })}</p>
          )}
        </section>

        <section>
          <h3>{t('settings.viewer')}</h3>
          <div className="field">
            <div className="label"><span>{t('settings.wheel')}</span></div>
            <div className="seg">
              <button
                className={`btn${prefs.wheelMode === 'zoom' ? ' active' : ''}`}
                aria-pressed={prefs.wheelMode === 'zoom'}
                onClick={() => prefs.setPref('wheelMode', 'zoom')}
              >
                {t('settings.wheelZoom')}
              </button>
              <button
                className={`btn${prefs.wheelMode === 'pan' ? ' active' : ''}`}
                aria-pressed={prefs.wheelMode === 'pan'}
                onClick={() => prefs.setPref('wheelMode', 'pan')}
              >
                {t('settings.wheelPan')}
              </button>
            </div>
          </div>
          <p className="hint">{t('settings.wheelHint')}</p>
        </section>

        <section>
          <h3>{t('settings.saving')}</h3>
          {desktop && save ? (
            <>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={save.askWhereToSave}
                  onChange={(e) => void desktop.setAskWhereToSave(e.target.checked).then(setSave)}
                />
                <span>{t('settings.askWhere')}</span>
              </label>
              <div className="field">
                <div className="label"><span>{t('settings.folder')}</span></div>
                <div className="path-row">
                  <code title={save.folder}>{save.folder}</code>
                </div>
                <div className="row">
                  <button className="btn" onClick={() => void desktop.chooseSaveFolder().then(setSave)}>
                    {t('settings.change')}
                  </button>
                  <button className="btn" onClick={() => desktop.openSaveFolder()}>
                    {t('settings.openFolder')}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <p className="hint">{t('settings.webSaving')}</p>
          )}
        </section>

        <section>
          <h3>{t('settings.dtf')}</h3>
          <label className="checkbox">
            <input type="checkbox" checked={prefs.dtfSimple} onChange={(e) => prefs.setPref('dtfSimple', e.target.checked)} />
            <span>{t('settings.dtfSimple')}</span>
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={prefs.rememberDtf} onChange={(e) => prefs.setPref('rememberDtf', e.target.checked)} />
            <span>{t('settings.rememberDtf')}</span>
          </label>
          <button
            className="btn"
            onClick={() => {
              clearDtfMemory();
              toast('success', t('settings.resetDtfDone'));
            }}
          >
            {t('settings.resetDtf')}
          </button>
        </section>

        <section>
          <h3>{t('settings.recent')}</h3>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={prefs.keepRecent}
              onChange={(e) => {
                prefs.setPref('keepRecent', e.target.checked);
                if (!e.target.checked) void clearRecent();
              }}
            />
            <span>{t('settings.keepRecent')}</span>
          </label>
          <button
            className="btn"
            onClick={() => void clearRecent().then(() => toast('success', t('settings.recentCleared')))}
          >
            {t('settings.clearRecent')}
          </button>
        </section>

        <section>
          <h3>{t('settings.privacy')}</h3>
          <p className="hint">{t('settings.privacyText')}</p>
          {hasKey ? (
            <button
              className="btn"
              onClick={() => {
                writeLocal('ditherlab.claude.key', null);
                setHasKey(false);
                toast('success', t('settings.keyRemoved'));
              }}
            >
              {t('settings.removeKey')}
            </button>
          ) : null}
        </section>

        <p className="hint settings-version">{t('settings.version', { v: desktop?.version || version })}</p>
      </div>
    </Modal>
  );
}
