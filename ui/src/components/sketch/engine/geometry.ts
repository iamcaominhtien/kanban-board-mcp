/** A point. */
export interface Pt {
  x: number;
  y: number;
}

/**
 * Move the end of a line so its angle is a multiple of `stepDeg` (Shift while drawing a line); the length is kept.
 * @param x0 - Start x.
 * @param y0 - Start y.
 * @param x1 - End x.
 * @param y1 - End y.
 * @param stepDeg - Angle step in degrees.
 */
export function snapAngle(x0: number, y0: number, x1: number, y1: number, stepDeg = 15): Pt {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len === 0) return { x: x1, y: y1 };
  const step = (stepDeg * Math.PI) / 180;
  const a = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: x0 + Math.cos(a) * len, y: y0 + Math.sin(a) * len };
}

/**
 * Move the opposite corner so the box is a square (Shift while drawing a rectangle or ellipse).
 * @param x0 - Start x.
 * @param y0 - Start y.
 * @param x1 - Corner x.
 * @param y1 - Corner y.
 */
export function squareCorner(x0: number, y0: number, x1: number, y1: number): Pt {
  const side = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  return { x: x0 + (x1 >= x0 ? side : -side), y: y0 + (y1 >= y0 ? side : -side) };
}

/**
 * The three points of an arrow head at the end of a line.
 * @param x0 - Line start x.
 * @param y0 - Line start y.
 * @param x1 - Line end x (where the tip is).
 * @param y1 - Line end y.
 * @param size - Length of the head's sides.
 * @returns The tip and the two back corners; empty for a zero-length line.
 */
export function arrowHead(x0: number, y0: number, x1: number, y1: number, size: number): Pt[] {
  if (x0 === x1 && y0 === y1) return [];
  const a = Math.atan2(y1 - y0, x1 - x0);
  const spread = Math.PI / 7;
  return [
    { x: x1, y: y1 },
    { x: x1 - size * Math.cos(a - spread), y: y1 - size * Math.sin(a - spread) },
    { x: x1 - size * Math.cos(a + spread), y: y1 - size * Math.sin(a + spread) },
  ];
}

/**
 * Zoom that makes a drawing fit a viewport, with a margin, never above 100%.
 * @param docW - Drawing width.
 * @param docH - Drawing height.
 * @param viewW - Viewport width.
 * @param viewH - Viewport height.
 * @param margin - Space to leave around the drawing.
 */
export function fitZoom(docW: number, docH: number, viewW: number, viewH: number, margin = 32): number {
  const k = Math.min((viewW - margin * 2) / docW, (viewH - margin * 2) / docH);
  return Math.max(0.05, Math.min(1, Number.isFinite(k) ? k : 1));
}

/** Zoom levels the buttons step through, and the limits of the wheel. */
export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 8;

/**
 * Keep a zoom inside its limits.
 * @param z - Zoom, 1 = 100%.
 */
export function clampZoom(z: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
}
