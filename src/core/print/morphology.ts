/**
 * Binary/greyscale morphology for trapping.
 *
 * `choke` shrinks a layer so it cannot peek out from under the colours on top
 * of it; `spread` grows one so a registration drift cannot open a gap. The
 * structuring element is a square, built from two separable min/max passes —
 * at the 1-4 pixel radii trapping actually uses, a square and a disc are
 * visually identical, and the separable form stays linear in the radius.
 */

function minMaxPass(
  src: Uint8Array,
  dst: Uint8Array,
  w: number,
  h: number,
  radius: number,
  horizontal: boolean,
  useMin: boolean,
): void {
  const outer = horizontal ? h : w;
  const inner = horizontal ? w : h;
  for (let o = 0; o < outer; o++) {
    for (let i = 0; i < inner; i++) {
      let acc = useMin ? 255 : 0;
      const lo = Math.max(0, i - radius);
      const hi = Math.min(inner - 1, i + radius);
      for (let k = lo; k <= hi; k++) {
        const v = horizontal ? src[o * w + k] : src[k * w + o];
        if (useMin ? v < acc : v > acc) acc = v;
      }
      if (horizontal) dst[o * w + i] = acc;
      else dst[i * w + o] = acc;
    }
  }
}

function morph(src: Uint8Array, w: number, h: number, radius: number, useMin: boolean): Uint8Array {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return src;
  const tmp = new Uint8Array(src.length);
  const out = new Uint8Array(src.length);
  minMaxPass(src, tmp, w, h, r, true, useMin);
  minMaxPass(tmp, out, w, h, r, false, useMin);
  return out;
}

/** Shrink: used to choke an underbase. */
export function erode(src: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  return morph(src, w, h, radius, true);
}

/** Grow: used to spread a colour under a neighbour for trapping. */
export function dilate(src: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  return morph(src, w, h, radius, false);
}
