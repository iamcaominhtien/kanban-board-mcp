import { makeRaster, type Raster, type Rect } from './raster.ts';

/** The pixels a fill reaches: one byte per pixel of the picture (1 = reached) and the box around them. */
export interface FillMask {
  mask: Uint8Array;
  width: number;
  height: number;
  bounds: Rect;
  count: number;
}

/** True when pixel `p` (an index into `data`, in bytes) is within `tol` of the seed colour. */
function matches(data: Uint8ClampedArray, p: number, r: number, g: number, b: number, a: number, tol: number): boolean {
  const pa = data[p + 3];
  // all transparent pixels are one colour, whatever hides in their red, green and blue
  if (a === 0) return pa <= tol;
  if (Math.abs(pa - a) > tol) return false;
  return Math.abs(data[p] - r) <= tol && Math.abs(data[p + 1] - g) <= tol && Math.abs(data[p + 2] - b) <= tol;
}

/**
 * Find the connected area of similar colour around a point, with a scanline fill: each run of pixels
 * is found with a tight loop and its neighbours above and below are queued, so the work is linear in the
 * size of the area and nothing is allocated per pixel.
 * @param src - The picture to look at (what the person sees).
 * @param sx - Start x.
 * @param sy - Start y.
 * @param tolerance - How far a channel may differ from the start pixel, 0 to 255.
 * @returns The reached pixels, or null when the point is outside the picture.
 */
export function floodMask(src: Raster, sx: number, sy: number, tolerance: number): FillMask | null {
  const { width: w, height: h, data } = src;
  sx = Math.floor(sx);
  sy = Math.floor(sy);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return null;
  const seed = (sy * w + sx) * 4;
  const r = data[seed];
  const g = data[seed + 1];
  const b = data[seed + 2];
  const a = data[seed + 3];
  const tol = Math.max(0, Math.min(255, Math.round(tolerance)));
  const mask = new Uint8Array(w * h);
  const stack: number[] = [sx, sy];
  let minX = sx;
  let maxX = sx;
  let minY = sy;
  let maxY = sy;
  let count = 0;

  while (stack.length) {
    const y = stack.pop() as number;
    const x = stack.pop() as number;
    const row = y * w;
    if (mask[row + x] || !matches(data, (row + x) * 4, r, g, b, a, tol)) continue;
    let left = x;
    while (left > 0 && !mask[row + left - 1] && matches(data, (row + left - 1) * 4, r, g, b, a, tol)) left--;
    let right = x;
    while (right < w - 1 && !mask[row + right + 1] && matches(data, (row + right + 1) * 4, r, g, b, a, tol)) right++;
    for (let i = left; i <= right; i++) mask[row + i] = 1;
    count += right - left + 1;
    if (left < minX) minX = left;
    if (right > maxX) maxX = right;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= h) continue;
      const nrow = ny * w;
      let inRun = false;
      for (let i = left; i <= right; i++) {
        const ok = !mask[nrow + i] && matches(data, (nrow + i) * 4, r, g, b, a, tol);
        if (ok && !inRun) stack.push(i, ny);
        inRun = ok;
      }
    }
  }
  return { mask, width: w, height: h, bounds: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }, count };
}

/**
 * Widen a fill by `px` pixels (to the four neighbours), so the soft edge of a line is covered too and no
 * pale halo is left between the fill and the line.
 * @param m - The reached pixels.
 * @param px - How many pixels to grow by.
 * @returns A new mask; the input is not changed.
 */
export function growMask(m: FillMask, px: number): FillMask {
  let cur = m;
  for (let step = 0; step < px; step++) {
    const { width: w, height: h } = cur;
    const out = new Uint8Array(w * h);
    const x0 = Math.max(0, cur.bounds.x - 1);
    const y0 = Math.max(0, cur.bounds.y - 1);
    const x1 = Math.min(w - 1, cur.bounds.x + cur.bounds.w);
    const y1 = Math.min(h - 1, cur.bounds.y + cur.bounds.h);
    let count = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * w + x;
        if (
          cur.mask[i] ||
          (x > 0 && cur.mask[i - 1]) ||
          (x < w - 1 && cur.mask[i + 1]) ||
          (y > 0 && cur.mask[i - w]) ||
          (y < h - 1 && cur.mask[i + w])
        ) {
          out[i] = 1;
          count++;
        }
      }
    }
    cur = { mask: out, width: w, height: h, bounds: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }, count };
  }
  return cur;
}

/**
 * Colour the reached pixels: a patch the size of the fill's box, transparent outside the fill.
 * @param m - The reached pixels.
 * @param rgba - Colour with alpha, each 0 to 255.
 * @returns A picture to draw at `m.bounds`.
 */
export function maskToPatch(m: FillMask, rgba: readonly [number, number, number, number]): Raster {
  const { x, y, w, h } = m.bounds;
  const out = makeRaster(w, h);
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      if (m.mask[(y + row) * m.width + x + col]) {
        const p = (row * w + col) * 4;
        out.data[p] = rgba[0];
        out.data[p + 1] = rgba[1];
        out.data[p + 2] = rgba[2];
        out.data[p + 3] = rgba[3];
      }
    }
  }
  return out;
}
