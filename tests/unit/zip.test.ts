import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 as nodeCrc32 } from 'node:zlib';
import { crc32, createZip } from '../../src/io/zip';

/** Read a stored ZIP back through its central directory. */
function readZip(zip: Uint8Array): { name: string; data: Uint8Array }[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let p = view.getUint32(end + 16, true);
  const out: { name: string; data: Uint8Array }[] = [];
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(p, true)).toBe(0x02014b50);
    const crc = view.getUint32(p + 16, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const local = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen));
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    const localNameLen = view.getUint16(local + 26, true);
    const data = zip.subarray(local + 30 + localNameLen, local + 30 + localNameLen + size);
    expect(crc32(data)).toBe(crc);
    out.push({ name, data });
    p += 46 + nameLen;
  }
  return out;
}

describe('zip writer', () => {
  it('matches zlib crc32', () => {
    const data = new TextEncoder().encode('DitherLab — nyomdakész');
    expect(crc32(data)).toBe(nodeCrc32(data));
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('round-trips names (UTF-8) and bytes', () => {
    const png = Uint8Array.from({ length: 5000 }, (_, i) => (i * 37) & 255);
    const zip = createZip([
      { name: 'póló_280x280mm_300dpi_DTF.png', data: png },
      { name: 'munkalap.txt', data: 'Méret: 28,0 × 28,0 cm\n' },
    ]);
    const files = readZip(zip);
    expect(files.map((f) => f.name)).toEqual(['póló_280x280mm_300dpi_DTF.png', 'munkalap.txt']);
    expect([...files[0].data]).toEqual([...png]);
    expect(new TextDecoder().decode(files[1].data)).toBe('Méret: 28,0 × 28,0 cm\n');
  });

  it('is accepted by the system unzip tool', () => {
    let hasUnzip = true;
    try {
      execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    } catch {
      hasUnzip = false;
    }
    if (!hasUnzip) return;
    const dir = mkdtempSync(join(tmpdir(), 'ditherlab-zip-'));
    const path = join(dir, 'test.zip');
    writeFileSync(path, createZip([{ name: 'a.txt', data: 'hello' }, { name: 'b/c.bin', data: new Uint8Array([0, 1, 2, 255]) }]));
    const out = execFileSync('unzip', ['-t', path]).toString();
    expect(out).toMatch(/No errors detected/);
  });
});
