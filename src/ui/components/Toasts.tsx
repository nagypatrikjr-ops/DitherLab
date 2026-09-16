import { useToasts } from '../toasts';
import { useI18n } from '../../i18n';
import { Icon } from './Icon';

export function Toasts(): JSX.Element {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  const { t } = useI18n();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((item) => (
        <div key={item.id} className={`toast ${item.kind}`}>
          <span className="toast-text">{item.text}</span>
          {item.action ? (
            <button
              className="btn"
              onClick={() => {
                item.action?.run();
                dismiss(item.id);
              }}
            >
              {item.action.label}
            </button>
          ) : null}
          <button className="toast-close" aria-label={t('common.close')} onClick={() => dismiss(item.id)}>
            <Icon name="close" size={11} />
          </button>
        </div>
      ))}
    </div>
  );
}
