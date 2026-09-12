import type { PixelBuffer } from '../types';

/**
 * Layer-boundary cache with a byte budget.
 *
 * Full-resolution Float32 RGBA is 16 bytes per pixel — a 4000x3000 image is
 * 192 MB per stored stage — so an unbounded cache is a guaranteed tab crash.
 * Entries are evicted least-recently-used once the budget is exceeded.
 */
export class RenderCache {
  private readonly map = new Map<string, PixelBuffer>();
  private bytes = 0;

  constructor(private readonly budgetBytes: number = 512 * 1024 * 1024) {}

  private sizeOf(buf: PixelBuffer): number {
    return buf.data.byteLength;
  }

  get(key: string): PixelBuffer | undefined {
    const hit = this.map.get(key);
    if (hit) {
      // Refresh recency.
      this.map.delete(key);
      this.map.set(key, hit);
    }
    return hit;
  }

  set(key: string, buf: PixelBuffer): void {
    const size = this.sizeOf(buf);
    if (size > this.budgetBytes) return; // never cache something bigger than the whole budget
    const existing = this.map.get(key);
    if (existing) this.bytes -= this.sizeOf(existing);
    this.map.set(key, buf);
    this.bytes += size;
    this.evict();
  }

  private evict(): void {
    while (this.bytes > this.budgetBytes && this.map.size > 1) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      const buf = this.map.get(oldest.value);
      if (buf) this.bytes -= this.sizeOf(buf);
      this.map.delete(oldest.value);
    }
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }

  get usedBytes(): number {
    return this.bytes;
  }

  get entryCount(): number {
    return this.map.size;
  }
}
