import type { CanvasBoard, CanvasDoc } from '../../api/canvases';

export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 4;
/** Below this zoom a board shows a picture of its last saved state; from here it is drawn live. */
export const LIVE_ZOOM = 0.4;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** Where the plane is looked at: `pan` is the plane point at the top-left of the window. */
export interface View {
  zoom: number;
  x: number;
  y: number;
}

/** Keep a zoom factor inside 10% to 400%. */
export function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number.isFinite(z) ? z : 1));
}

/** Whether a board is shown as a snapshot (not drawn live) at this zoom. */
export function isSnapshot(zoom: number): boolean {
  return zoom < LIVE_ZOOM;
}

/** The smallest rectangle around some rectangles (null for none). */
export function boundsOf(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w));
  const y1 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * The view that fits a rectangle in a window, centred, with some air around it.
 * @param box - What to fit (plane units).
 * @param win - Size of the window in pixels.
 * @param pad - Pixels of air around.
 * @param max - Never zoom in past this (Fit does not enlarge a tiny canvas to 400%).
 */
export function fitView(box: Rect | null, win: { w: number; h: number }, pad = 60, max = 1): View {
  if (!box || box.w <= 0 || box.h <= 0) return { zoom: 1, x: 0, y: 0 };
  const zoom = clampZoom(Math.min(max, (win.w - pad * 2) / box.w, (win.h - pad * 2) / box.h));
  return {
    zoom,
    x: box.x + box.w / 2 - win.w / 2 / zoom,
    y: box.y + box.h / 2 - win.h / 2 / zoom,
  };
}

/**
 * Zoom by a factor, keeping the plane point under `at` (window pixels) where it is.
 * @param view - Current view.
 * @param factor - 1.1 zooms in a step.
 * @param at - A point of the window in pixels.
 */
export function zoomAt(view: View, factor: number, at: { x: number; y: number }): View {
  const zoom = clampZoom(view.zoom * factor);
  const px = view.x + at.x / view.zoom;
  const py = view.y + at.y / view.zoom;
  return { zoom, x: px - at.x / zoom, y: py - at.y / zoom };
}

/** A window pixel as a plane point. */
export function toPlane(view: View, p: { x: number; y: number }): { x: number; y: number } {
  return { x: view.x + p.x / view.zoom, y: view.y + p.y / view.zoom };
}

/** Whether two rectangles overlap. */
export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** A rectangle from two corners in any order. */
export function rectFrom(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

export interface Guide {
  axis: 'x' | 'y';
  at: number;
}

/**
 * Snap a moving rectangle to the edges and centres of the others. Guides appear next to other boards.
 * @param moving - The rectangle after the drag, before snapping.
 * @param others - Rectangles it may snap to.
 * @param threshold - How close (screen pixels) before it snaps.
 * @param zoom - Current zoom, to turn pixels into plane units.
 * @returns How far to nudge it and the guide lines to draw.
 */
export function snapMove(moving: Rect, others: Rect[], threshold: number, zoom: number) {
  const t = threshold / zoom;
  let dx = 0;
  let dy = 0;
  let bestX = t + 1;
  let bestY = t + 1;
  const guides: Guide[] = [];
  const mx = [moving.x, moving.x + moving.w / 2, moving.x + moving.w];
  const my = [moving.y, moving.y + moving.h / 2, moving.y + moving.h];
  for (const o of others) {
    const ox = [o.x, o.x + o.w / 2, o.x + o.w];
    const oy = [o.y, o.y + o.h / 2, o.y + o.h];
    for (const a of mx)
      for (const b of ox) {
        const d = b - a;
        if (Math.abs(d) <= t && Math.abs(d) < bestX) {
          bestX = Math.abs(d);
          dx = d;
        }
      }
    for (const a of my)
      for (const b of oy) {
        const d = b - a;
        if (Math.abs(d) <= t && Math.abs(d) < bestY) {
          bestY = Math.abs(d);
          dy = d;
        }
      }
  }
  const sx = moving.x + dx;
  const sy = moving.y + dy;
  const snapped = { ...moving, x: sx, y: sy };
  if (dx !== 0 || bestX <= t) {
    for (const o of others)
      for (const a of [snapped.x, snapped.x + snapped.w / 2, snapped.x + snapped.w])
        for (const b of [o.x, o.x + o.w / 2, o.x + o.w]) if (Math.abs(a - b) < 0.5) guides.push({ axis: 'x', at: b });
  }
  if (dy !== 0 || bestY <= t) {
    for (const o of others)
      for (const a of [snapped.y, snapped.y + snapped.h / 2, snapped.y + snapped.h])
        for (const b of [o.y, o.y + o.h / 2, o.y + o.h]) if (Math.abs(a - b) < 0.5) guides.push({ axis: 'y', at: b });
  }
  return { dx, dy, guides };
}

export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/**
 * Resize a rectangle by dragging one handle, never past a minimum size. A board's width stays in 320 to 1920.
 * @param r - The rectangle at the start of the drag.
 * @param handle - Which handle moves.
 * @param dx - Plane distance moved on x.
 * @param dy - Plane distance moved on y.
 * @param min - Smallest size.
 * @param max - Largest size.
 * @param keepRatio - Hold the aspect ratio (Shift).
 */
export function resizeRect(
  r: Rect,
  handle: Handle,
  dx: number,
  dy: number,
  min = { w: 320, h: 120 },
  max = { w: 1920, h: 6000 },
  keepRatio = false,
): Rect {
  let { x, y, w, h } = r;
  if (handle.includes('e')) w = r.w + dx;
  if (handle.includes('s')) h = r.h + dy;
  if (handle.includes('w')) {
    w = r.w - dx;
  }
  if (handle.includes('n')) {
    h = r.h - dy;
  }
  if (keepRatio && handle.length === 2) {
    const ratio = r.w / r.h;
    if (Math.abs(w - r.w) / r.w > Math.abs(h - r.h) / r.h) h = w / ratio;
    else w = h * ratio;
  }
  w = Math.min(max.w, Math.max(min.w, w));
  h = Math.min(max.h, Math.max(min.h, h));
  if (handle.includes('w')) x = r.x + r.w - w;
  if (handle.includes('n')) y = r.y + r.h - h;
  return { x, y, w, h };
}

/**
 * The order boards are stepped through by default: left to right, then top to bottom (boards whose tops are within
 * half a board height of each other count as one row).
 */
export function readingOrder<T extends Rect>(boards: T[]): T[] {
  const sorted = [...boards].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: T[][] = [];
  for (const b of sorted) {
    const row = rows.find((r) => Math.abs(r[0].y - b.y) < Math.min(r[0].h, b.h) * 0.5);
    if (row) row.push(b);
    else rows.push([b]);
  }
  return rows.flatMap((r) => r.sort((a, b) => a.x - b.x));
}

/** The boards of a page in the order Present and the viewer step through: set by hand (`order`), else reading order. */
export function orderedBoards(doc: CanvasDoc, page: string): CanvasBoard[] {
  const here = doc.boards.filter((b) => b.page === page);
  const manual = here.some((b) => b.order !== here.indexOf(b) && b.order >= 0) || false;
  const base = readingOrder(here);
  return manual ? [...here].sort((a, b) => a.order - b.order || base.indexOf(a) - base.indexOf(b)) : base;
}

/** The board after or before another in a list, wrapping round. */
export function stepBoard<T extends { id: string }>(list: T[], id: string | null, dir: 1 | -1): T | null {
  if (!list.length) return null;
  const i = list.findIndex((b) => b.id === id);
  if (i < 0) return dir === 1 ? list[0] : list[list.length - 1];
  return list[(i + dir + list.length) % list.length];
}

type Item = { id: string; rev: number } & Record<string, unknown>;
const LISTS = ['pages', 'boards', 'notes', 'arrows', 'labels'] as const;
const LAYOUT_ONLY = new Set(['content', 'createdBy', 'rev']);

function same(a: Item, b: Item): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (LAYOUT_ONLY.has(k)) continue;
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
  }
  return true;
}

/**
 * What changed between the plane as loaded and as it is now, as a save body (merged per item on the server): items
 * that are new or changed, and ids that are gone. An item carries the revision the editor saw it at.
 * @param base - The plane as last loaded or saved.
 * @param now - The plane as it is on screen.
 */
export function layoutChanges(base: CanvasDoc, now: CanvasDoc) {
  const upsert: Record<string, Item[]> = {};
  const remove: string[] = [];
  for (const list of LISTS) {
    const before = new Map((base[list] as unknown as Item[]).map((i) => [i.id, i]));
    const after = new Map((now[list] as unknown as Item[]).map((i) => [i.id, i]));
    for (const [id, item] of after) {
      const old = before.get(id);
      if (list === 'boards' && !old) continue; // a board is added with its content, not through a layout save
      if (!old || !same(old, item)) (upsert[list] ??= []).push(item);
    }
    for (const id of before.keys()) if (!after.has(id)) remove.push(id);
  }
  return { upsert, remove, empty: !remove.length && !Object.keys(upsert).length };
}

/** Whether anything in the plane differs (to show "Saving…" and to ask before closing). */
export function isDirty(base: CanvasDoc, now: CanvasDoc): boolean {
  return !layoutChanges(base, now).empty;
}

/** The point where a line from the centre of `r` towards `toward` leaves the rectangle. */
export function edgePoint(r: Rect, toward: { x: number; y: number }): { x: number; y: number } {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const k = Math.min(dx !== 0 ? r.w / 2 / Math.abs(dx) : Infinity, dy !== 0 ? r.h / 2 / Math.abs(dy) : Infinity);
  return { x: cx + dx * k, y: cy + dy * k };
}

/** The line of an arrow between two items, from edge to edge, so it follows them when they move. */
export function arrowLine(a: Rect, b: Rect): { x1: number; y1: number; x2: number; y2: number } {
  const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const p = edgePoint(a, cb);
  const q = edgePoint(b, ca);
  return { x1: p.x, y1: p.y, x2: q.x, y2: q.y };
}
