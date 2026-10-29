// Pure pixel helpers of the Sketch tool. This folder has no DOM or React code and imports with `.ts`
// extensions, so `npm test` can run it with plain Node (see engine/*.test.ts).

/** An RGBA picture, laid out like the browser's `ImageData` (non-premultiplied, row by row). */
export interface Raster {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** A rectangle in pixels. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A transparent picture.
 * @param width - Width in px.
 * @param height - Height in px.
 */
export function makeRaster(width: number, height: number): Raster {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/**
 * The part of a rectangle inside a width x height area, or null when nothing is left.
 * @param r - Rectangle to clip; fractions are rounded outwards.
 * @param width - Area width.
 * @param height - Area height.
 */
export function clipRect(r: Rect, width: number, height: number): Rect | null {
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(width, Math.ceil(r.x + r.w));
  const y1 = Math.min(height, Math.ceil(r.y + r.h));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/**
 * The smallest rectangle holding both; either may be null.
 * @param a - First rectangle.
 * @param b - Second rectangle.
 */
export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Grow a rectangle by `by` px on every side.
 * @param r - Rectangle.
 * @param by - Margin in px.
 */
export function growRect(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 };
}

/**
 * The rectangle between two corners, whichever way they were dragged.
 * @param x0 - First corner x.
 * @param y0 - First corner y.
 * @param x1 - Opposite corner x.
 * @param y1 - Opposite corner y.
 */
export function rectFromCorners(x0: number, y0: number, x1: number, y1: number): Rect {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

/**
 * Whether a point lies inside a rectangle.
 * @param r - Rectangle.
 * @param x - Point x.
 * @param y - Point y.
 */
export function rectContains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
}

/**
 * Copy a region out of a raster.
 * @param src - Raster to read.
 * @param r - Region, already inside the raster.
 */
export function copyRegion(src: Raster, r: Rect): Raster {
  const out = makeRaster(r.w, r.h);
  for (let row = 0; row < r.h; row++) {
    const from = ((r.y + row) * src.width + r.x) * 4;
    out.data.set(src.data.subarray(from, from + r.w * 4), row * r.w * 4);
  }
  return out;
}

/**
 * Overwrite a region of a raster with a patch (no blending).
 * @param dst - Raster to change.
 * @param x - Left edge of the region.
 * @param y - Top edge of the region.
 * @param patch - Pixels to write.
 */
export function writeRegion(dst: Raster, x: number, y: number, patch: Raster): void {
  for (let row = 0; row < patch.height; row++) {
    const to = ((y + row) * dst.width + x) * 4;
    dst.data.set(patch.data.subarray(row * patch.width * 4, (row + 1) * patch.width * 4), to);
  }
}

/**
 * The rectangle that holds every pixel that is not fully transparent, or null for a blank raster.
 * @param src - Raster to scan.
 */
export function contentBounds(src: Raster): Rect | null {
  const { width, height, data } = src;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const rowStart = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (data[rowStart + x * 4 + 3] !== 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
