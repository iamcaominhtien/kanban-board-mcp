import { expect, test } from 'vitest';
import type { CanvasBoard, CanvasDoc } from '../../api/canvases';
import {
  arrowLine,
  boundsOf,
  clampZoom,
  fitView,
  isSnapshot,
  layoutChanges,
  orderedBoards,
  readingOrder,
  resizeRect,
  snapMove,
  stepBoard,
  toPlane,
  zoomAt,
} from './planeMath';
import { CANVAS_LINE, canvasRefOf, canvasesAsImages, hasCanvas } from './canvasRefs';

const board = (id: string, x: number, y: number, extra: Partial<CanvasBoard> = {}): CanvasBoard => ({
  id,
  page: 'p_1',
  name: id,
  kind: 'html',
  x,
  y,
  w: 1280,
  h: 800,
  order: 0,
  ref: null,
  content: null,
  rev: 1,
  ...extra,
});
const doc = (boards: CanvasBoard[]): CanvasDoc => ({
  format: 'kanban-canvas',
  version: 1,
  pages: [{ id: 'p_1', name: 'Page 1', rev: 1 }],
  boards,
  notes: [],
  arrows: [],
  labels: [],
});

test('zoom stays between 10% and 400%, and boards are pictures below 40%', () => {
  expect(clampZoom(0.01)).toBe(0.1);
  expect(clampZoom(9)).toBe(4);
  expect(clampZoom(NaN)).toBe(1);
  expect(isSnapshot(0.39)).toBe(true);
  expect(isSnapshot(0.4)).toBe(false);
});

test('Fit centres everything and never enlarges a small canvas past 100%', () => {
  const box = boundsOf([
    { x: 0, y: 0, w: 1280, h: 800 },
    { x: 1400, y: 0, w: 1280, h: 800 },
  ])!;
  expect(box).toEqual({ x: 0, y: 0, w: 2680, h: 800 });
  const v = fitView(box, { w: 1368, h: 606 });
  expect(v.zoom).toBeCloseTo((1368 - 120) / 2680, 5);
  // the box centre is the window centre
  const c = toPlane(v, { x: 684, y: 303 });
  expect(c.x).toBeCloseTo(1340, 3);
  expect(c.y).toBeCloseTo(400, 3);
  expect(fitView({ x: 0, y: 0, w: 100, h: 100 }, { w: 1000, h: 800 }).zoom).toBe(1);
  expect(fitView(null, { w: 1, h: 1 })).toEqual({ zoom: 1, x: 0, y: 0 });
});

test('zooming keeps the point under the pointer where it is', () => {
  const v0 = { zoom: 0.5, x: 100, y: 50 };
  const at = { x: 400, y: 300 };
  const before = toPlane(v0, at);
  const v1 = zoomAt(v0, 1.5, at);
  const after = toPlane(v1, at);
  expect(after.x).toBeCloseTo(before.x, 6);
  expect(after.y).toBeCloseTo(before.y, 6);
  expect(zoomAt({ zoom: 4, x: 0, y: 0 }, 2, at).zoom).toBe(4);
});

test('a moving board snaps to the edges and centres of the others and shows the guide', () => {
  const other = { x: 0, y: 0, w: 1280, h: 800 };
  const r = snapMove({ x: 1288, y: 6, w: 600, h: 400 }, [other], 8, 1);
  expect(r.dx).toBe(-8);
  expect(r.dy).toBe(-6);
  expect(r.guides.some((g) => g.axis === 'x' && g.at === 1280)).toBe(true);
  expect(r.guides.some((g) => g.axis === 'y' && g.at === 0)).toBe(true);
  // too far to snap
  expect(snapMove({ x: 1400, y: 100, w: 600, h: 400 }, [other], 8, 1)).toMatchObject({ dx: 0, dy: 0 });
  // the threshold is in screen pixels: at 25% zoom the same 8 px reach 32 plane units
  expect(snapMove({ x: 1300, y: 500, w: 600, h: 400 }, [other], 8, 0.25).dx).toBe(-20);
});

test('resizing holds the 320 to 1920 width and keeps the opposite edge still', () => {
  const r = { x: 100, y: 100, w: 1280, h: 800 };
  expect(resizeRect(r, 'e', 5000, 0).w).toBe(1920);
  expect(resizeRect(r, 'e', -5000, 0).w).toBe(320);
  const w = resizeRect(r, 'w', 200, 0);
  expect(w).toMatchObject({ x: 300, w: 1080 });
  expect(w.x + w.w).toBe(r.x + r.w);
  const n = resizeRect(r, 'n', -100, 0);
  expect(n.y + n.h).toBe(900);
  const ratio = resizeRect(r, 'se', 320, 0, undefined, undefined, true);
  expect(ratio.w / ratio.h).toBeCloseTo(1.6, 5);
});

test('boards are stepped through left to right then top to bottom, unless set by hand', () => {
  const a = board('a', 0, 0);
  const b = board('b', 1400, 20);
  const c = board('c', 0, 900);
  const d = board('d', 1400, 920);
  expect(readingOrder([d, c, b, a]).map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
  expect(orderedBoards(doc([d, c, b, a]), 'p_1').map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
  const hand = [a, b, c, d].map((x, i) => ({ ...x, order: [3, 2, 1, 0][i] }));
  expect(orderedBoards(doc(hand), 'p_1').map((x) => x.id)).toEqual(['d', 'c', 'b', 'a']);
  expect(stepBoard([a, b, c], 'c', 1)?.id).toBe('a');
  expect(stepBoard([a, b, c], 'a', -1)?.id).toBe('c');
  expect(stepBoard([a, b, c], null, 1)?.id).toBe('a');
  expect(stepBoard([], null, 1)).toBeNull();
});

test('only what changed is saved, each item with the revision the editor saw', () => {
  const base = doc([board('b_1', 0, 0, { rev: 4 }), board('b_2', 1400, 0, { rev: 2 })]);
  base.notes = [{ id: 'n_1', page: 'p_1', x: 0, y: 0, w: 160, h: 100, text: 'hi', color: 'yellow', by: 'HM', rev: 3 }];
  const now = JSON.parse(JSON.stringify(base)) as CanvasDoc;
  expect(layoutChanges(base, now).empty).toBe(true);
  now.boards[0].x = 50;
  now.notes = [];
  now.labels.push({
    id: 't_new',
    page: 'p_1',
    x: 1,
    y: 2,
    text: 'Step',
    size: 20,
    rev: undefined as unknown as number,
  });
  const ch = layoutChanges(base, now);
  expect(ch.upsert.boards.map((b) => [b.id, b.rev])).toEqual([['b_1', 4]]);
  expect(ch.upsert.labels.map((l) => l.id)).toEqual(['t_new']);
  expect(ch.remove).toEqual(['n_1']);
  // a board that appeared (added with its content elsewhere) is not part of a layout save
  now.boards.push(board('b_3', 5, 5));
  expect(layoutChanges(base, now).upsert.boards.map((b) => b.id)).toEqual(['b_1']);
});

test('canvas lines: the whole canvas, one board, a page tab, and the chip form', () => {
  expect(canvasRefOf('canvas:cv_8f3a1c2d')).toEqual({ id: 'cv_8f3a1c2d', boardId: undefined, pageId: undefined });
  expect(canvasRefOf('canvas:cv_8f3a1c2d#b_0a1b2c3d')?.boardId).toBe('b_0a1b2c3d');
  expect(canvasRefOf('canvas:cv_8f3a1c2d#p_0a1b2c3d')?.pageId).toBe('p_0a1b2c3d');
  expect(canvasRefOf('sketch:sk_8f3a1c2d')).toBeNull();
  expect(canvasRefOf('canvas:cv_xyz')).toBeNull();
  const m = CANVAS_LINE.exec('![Login redesign](canvas:cv_8f3a1c2d#b_0a1b2c3d)');
  expect(m?.[1]).toBe('Login redesign');
  expect(m?.[3]).toBe('b_0a1b2c3d');
  expect(CANVAS_LINE.test('see [x](canvas:cv_8f3a1c2d)')).toBe(false);
  const img = { type: 'element', tagName: 'img', properties: { src: 'canvas:cv_8f3a1c2d' } };
  const link = { type: 'element', tagName: 'a', properties: { href: 'canvas:cv_8f3a1c2d' } };
  expect(hasCanvas({ children: [img] })).toBe(true);
  expect(hasCanvas({ children: [link] })).toBe(false);
});

test('an export writes the overview picture of a canvas and a chip as plain text', () => {
  const md =
    'Agreed:\n\n![Login redesign](canvas:cv_8f3a1c2d)\n\nSee [Login redesign](canvas:cv_8f3a1c2d#b_0a1b2c3d) and ![Sketch](sketch:sk_8f3a1c2d)';
  expect(canvasesAsImages(md)).toBe(
    'Agreed:\n\n![Login redesign](/uploads/canvases/cv_8f3a1c2d/overview.png)\n\nSee Login redesign and ![Sketch](sketch:sk_8f3a1c2d)',
  );
});

test('an arrow runs from the edge of one item to the edge of the other', () => {
  const a = { x: 0, y: 0, w: 100, h: 100 };
  const b = { x: 300, y: 0, w: 100, h: 100 };
  expect(arrowLine(a, b)).toEqual({ x1: 100, y1: 50, x2: 300, y2: 50 });
  const c = { x: 0, y: 300, w: 100, h: 100 };
  expect(arrowLine(a, c)).toEqual({ x1: 50, y1: 100, x2: 50, y2: 300 });
});
