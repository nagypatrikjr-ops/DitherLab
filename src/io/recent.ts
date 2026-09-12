/**
 * Recently opened images, kept in this browser's IndexedDB (never uploaded).
 * Every function degrades to "nothing stored" when IndexedDB is unavailable
 * (private windows, blocked site data).
 */

export interface RecentMeta {
  readonly id: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly addedAt: number;
  readonly thumb: Blob;
}

interface RecentRecord extends RecentMeta {
  readonly blob: Blob;
}

const DB = 'ditherlab';
const STORE = 'recent';
const MAX_ITEMS = 8;
const MAX_BYTES = 80 * 1024 * 1024;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB'));
  });
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => Promise<T>): Promise<T> {
  const db = await open();
  try {
    return await fn(db.transaction(STORE, mode).objectStore(STORE));
  } finally {
    db.close();
  }
}

function isRecord(v: unknown): v is RecentRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.id === 'string' && typeof r.name === 'string' && r.blob instanceof Blob && r.thumb instanceof Blob;
}

async function thumbnail(image: ImageData): Promise<Blob> {
  const k = Math.min(1, 240 / Math.max(image.width, image.height));
  const src = document.createElement('canvas');
  src.width = image.width;
  src.height = image.height;
  src.getContext('2d')?.putImageData(image, 0, 0);
  const dst = document.createElement('canvas');
  dst.width = Math.max(1, Math.round(image.width * k));
  dst.height = Math.max(1, Math.round(image.height * k));
  const ctx = dst.getContext('2d');
  if (ctx) {
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, dst.width, dst.height);
  }
  return new Promise((resolve, reject) =>
    dst.toBlob((b) => (b ? resolve(b) : reject(new Error('thumbnail'))), 'image/jpeg', 0.82),
  );
}

export async function listRecent(): Promise<RecentMeta[]> {
  try {
    const all = await withStore('readonly', (s) => done(s.getAll()));
    return all
      .filter(isRecord)
      .sort((a, b) => b.addedAt - a.addedAt)
      .map(({ id, name, width, height, addedAt, thumb }) => ({ id, name, width, height, addedAt, thumb }));
  } catch {
    return [];
  }
}

export async function getRecent(id: string): Promise<{ name: string; blob: Blob } | null> {
  try {
    const rec: unknown = await withStore('readonly', (s) => done(s.get(id)));
    return isRecord(rec) ? { name: rec.name, blob: rec.blob } : null;
  } catch {
    return null;
  }
}

/** Remember an opened image. Very large files are skipped rather than stored. */
export async function addRecent(blob: Blob, name: string, image: ImageData): Promise<void> {
  if (blob.size > MAX_BYTES) return;
  try {
    const thumb = await thumbnail(image);
    const id = `${name}:${blob.size}:${image.width}x${image.height}`;
    await withStore('readwrite', async (s) => {
      await done(s.put({ id, name, width: image.width, height: image.height, addedAt: Date.now(), blob, thumb }));
      const all = (await done(s.getAll())).filter(isRecord).sort((a, b) => b.addedAt - a.addedAt);
      for (const old of all.slice(MAX_ITEMS)) await done(s.delete(old.id));
    });
  } catch {
    /* not stored — the image is still open */
  }
}

export async function removeRecent(id: string): Promise<void> {
  try {
    await withStore('readwrite', (s) => done(s.delete(id)));
  } catch {
    /* nothing to remove */
  }
}

export async function clearRecent(): Promise<void> {
  try {
    await withStore('readwrite', (s) => done(s.clear()));
  } catch {
    /* nothing to clear */
  }
}
