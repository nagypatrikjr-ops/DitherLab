/** Browser-side image loading and file saving helpers. */

export async function imageDataFromBlob(blob: Blob): Promise<ImageData> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx === null) throw new Error('A 2D canvas kontextus nem érhető el.');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/');
}

/** Pull the first image out of a paste or drop event, if there is one. */
export async function imageFromDataTransfer(
  items: DataTransferItemList | null,
): Promise<{ blob: Blob; name: string } | null> {
  if (items === null) return null;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file && file.type.startsWith('image/')) {
      return { blob: file, name: file.name || 'vágólap' };
    }
  }
  return null;
}

/**
 * Save bytes to a file. Accepts a Blob, a string or a typed array; the cast is
 * needed only because TypeScript models BlobPart as requiring a non-shared
 * ArrayBuffer, which every array we produce here already is.
 */
export function download(
  data: Blob | string | Uint8Array | ArrayBuffer,
  filename: string,
  mime: string,
): void {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Encode an ImageData through canvas (PNG/WEBP/JPEG). */
export async function encodeViaCanvas(
  image: ImageData,
  mime: 'image/png' | 'image/webp' | 'image/jpeg',
  quality = 0.92,
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('A 2D canvas kontextus nem érhető el.');
  ctx.putImageData(image, 0, 0);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('A kódolás nem sikerült.'))),
      mime,
      quality,
    );
  });
}

/**
 * Baseline TIFF, uncompressed, with the real print resolution.
 *
 * Written by hand because canvas cannot produce TIFF. With `alpha` the file
 * carries a fourth sample marked as unassociated alpha (ExtraSamples = 2),
 * which is how RIPs that accept TIFF read transparency. Tags are emitted in
 * ascending order as the specification requires.
 */
export function encodeTiff(
  image: ImageData,
  options: { dpi?: number; alpha?: boolean } = {},
): Uint8Array {
  const { width, height } = image;
  const dpi = Math.max(1, Math.round(options.dpi ?? 72));
  const alpha = options.alpha === true;
  const spp = alpha ? 4 : 3;
  const pixelBytes = width * height * spp;

  const entries: [number, number, number, number][] = [];
  // Layout: header (8) | BitsPerSample values | resolution rationals | pixels | IFD
  const bitsOffset = 8;
  const resOffset = bitsOffset + spp * 2 + (spp * 2) % 4;
  const pixelOffset = resOffset + 16;
  const ifdOffset = pixelOffset + pixelBytes + (pixelBytes & 1);

  entries.push([0x0100, 4, 1, width]); // ImageWidth (LONG)
  entries.push([0x0101, 4, 1, height]); // ImageLength (LONG)
  entries.push([0x0102, 3, spp, bitsOffset]); // BitsPerSample
  entries.push([0x0103, 3, 1, 1]); // Compression: none
  entries.push([0x0106, 3, 1, 2]); // PhotometricInterpretation: RGB
  entries.push([0x0111, 4, 1, pixelOffset]); // StripOffsets
  entries.push([0x0115, 3, 1, spp]); // SamplesPerPixel
  entries.push([0x0116, 4, 1, height]); // RowsPerStrip: one strip
  entries.push([0x0117, 4, 1, pixelBytes]); // StripByteCounts
  entries.push([0x011a, 5, 1, resOffset]); // XResolution
  entries.push([0x011b, 5, 1, resOffset + 8]); // YResolution
  entries.push([0x0128, 3, 1, 2]); // ResolutionUnit: inch
  if (alpha) entries.push([0x0152, 3, 1, 2]); // ExtraSamples: unassociated alpha

  const ifdSize = 2 + entries.length * 12 + 4;
  const out = new Uint8Array(ifdOffset + ifdSize);
  const view = new DataView(out.buffer);

  out[0] = 0x49;
  out[1] = 0x49; // little endian
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdOffset, true);

  for (let i = 0; i < spp; i++) view.setUint16(bitsOffset + i * 2, 8, true);

  view.setUint32(resOffset, dpi, true);
  view.setUint32(resOffset + 4, 1, true);
  view.setUint32(resOffset + 8, dpi, true);
  view.setUint32(resOffset + 12, 1, true);

  const d = image.data;
  for (let p = 0; p < width * height; p++) {
    const o = pixelOffset + p * spp;
    out[o] = d[p * 4];
    out[o + 1] = d[p * 4 + 1];
    out[o + 2] = d[p * 4 + 2];
    if (alpha) out[o + 3] = d[p * 4 + 3];
  }

  let o = ifdOffset;
  view.setUint16(o, entries.length, true);
  o += 2;
  for (const [tag, type, count, value] of entries) {
    view.setUint16(o, tag, true);
    view.setUint16(o + 2, type, true);
    view.setUint32(o + 4, count, true);
    if (type === 3 && count === 1) view.setUint16(o + 8, value, true);
    else view.setUint32(o + 8, value, true);
    o += 12;
  }
  view.setUint32(o, 0, true); // no further IFD
  return out;
}
