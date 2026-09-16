import { useState } from 'react';
import type { RenderClient } from '../workers/client';
import { useI18n } from '../i18n';
import { ScreenPrintStudio } from './ScreenPrintStudio';
import { TransferStudio } from './TransferStudio';

export type StudioMode = 'dtf' | 'screen';

interface Props {
  client: RenderClient;
  sourceId: string;
  sourceImage: ImageData;
  renderImage: ImageData | null;
  fileName: string;
  initialMode: StudioMode;
  onModeChange: (mode: StudioMode) => void;
  onClose: () => void;
}

/** Garment printing: the DTF transfer workflow first, screen-print films second. */
export function ShirtStudio({ initialMode, onModeChange, ...props }: Props): JSX.Element {
  const { t } = useI18n();
  const [mode, setMode] = useState<StudioMode>(initialMode);
  const choose = (next: StudioMode): void => {
    setMode(next);
    onModeChange(next);
  };
  const switcher = (
    <div className="mode-switch seg" role="group">
      <button className={`btn${mode === 'dtf' ? ' active' : ''}`} aria-pressed={mode === 'dtf'} onClick={() => choose('dtf')}>
        {t('studio.dtf')}
      </button>
      <button className={`btn${mode === 'screen' ? ' active' : ''}`} aria-pressed={mode === 'screen'} onClick={() => choose('screen')}>
        {t('studio.screen')}
      </button>
    </div>
  );
  return mode === 'dtf' ? (
    <TransferStudio {...props} headerExtra={switcher} />
  ) : (
    <ScreenPrintStudio {...props} headerExtra={switcher} />
  );
}
