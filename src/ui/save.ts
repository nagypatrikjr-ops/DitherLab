import { download } from '../io/image';
import { currentI18n } from '../i18n';
import { toast } from './toasts';

/**
 * Save a file the way the platform expects. The desktop app writes it to the
 * chosen folder and reports back with the real path (shown by App as a toast
 * with "Show in folder"); the browser starts a download.
 */
export function saveFile(data: Blob | string | Uint8Array | ArrayBuffer, filename: string, mime: string): void {
  download(data, filename, mime);
  if (window.ditherlabDesktop === undefined) {
    toast('success', currentI18n().t('toast.downloading', { name: filename }));
  }
}
