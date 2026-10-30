import { expect, test } from 'vitest';
import { History, MIN_STEPS, type Step } from './history';
import { TILE, TileSnapshot, rasterSurface } from './tiles';
import { makeRaster } from './raster';

/** A step that adds `n` to a counter. */
function addStep(box: { v: number }, n: number, bytes = 0): Step {
  box.v += n;
  return {
    label: `add ${n}`,
    bytes,
    undo: () => {
      box.v -= n;
    },
    redo: () => {
      box.v += n;
    },
  };
}

test('undo and redo walk back and forth through the steps', () => {
  const h = new History();
  const box = { v: 0 };
  h.push(addStep(box, 1));
  h.push(addStep(box, 10));
  expect(box.v).toBe(11);
  h.undo();
  expect(box.v).toBe(1);
  h.undo();
  expect(box.v).toBe(0);
  expect(h.undo()).toBe(null);
  expect(h.canUndo).toBe(false);
  h.redo();
  h.redo();
  expect(box.v).toBe(11);
  expect(h.redo()).toBe(null);
});

test('a new change forgets what could have been redone', () => {
  const h = new History();
  const box = { v: 0 };
  h.push(addStep(box, 1));
  h.push(addStep(box, 2));
  h.undo();
  h.push(addStep(box, 100));
  expect(h.canRedo).toBe(false);
  expect(box.v).toBe(101);
});

test('at least 100 steps can be undone, one after another', () => {
  const h = new History();
  const box = { v: 0 };
  for (let i = 0; i < 150; i++) h.push(addStep(box, 1));
  expect(h.depth >= MIN_STEPS).toBeTruthy();
  let undone = 0;
  while (h.undo()) undone++;
  expect(undone >= 100).toBeTruthy();
  expect(box.v).toBe(150 - undone);
});

test('memory pressure drops the oldest steps but never below 100', () => {
  const h = new History(250, 1000);
  const box = { v: 0 };
  for (let i = 0; i < 300; i++) h.push(addStep(box, 1, 1000)); // each step alone fills the budget
  expect(h.depth).toBe(MIN_STEPS);
});

test('the step count is capped', () => {
  const h = new History(120);
  const box = { v: 0 };
  for (let i = 0; i < 300; i++) h.push(addStep(box, 1));
  expect(h.depth).toBe(120);
});

test('a listener hears every change', () => {
  const h = new History();
  let calls = 0;
  h.onChange(() => calls++);
  const box = { v: 0 };
  h.push(addStep(box, 1));
  h.undo();
  h.redo();
  expect(calls).toBe(3);
});

test('a tile snapshot undoes and redoes a change that touched two tiles', () => {
  const w = TILE * 2 + 10;
  const r = makeRaster(w, TILE + 5);
  const surface = rasterSurface(r);
  const before = r.data.slice();
  const snap = new TileSnapshot(w, r.height);
  // paint across the border between the first two tiles
  snap.capture(surface, { x: TILE - 4, y: 10, w: 8, h: 3 });
  for (let y = 10; y < 13; y++) for (let x = TILE - 4; x < TILE + 4; x++) r.data.set([9, 8, 7, 255], (y * w + x) * 4);
  const after = r.data.slice();
  expect(after).not.toStrictEqual(before);
  snap.swap(surface);
  expect(r.data).toStrictEqual(before);
  snap.swap(surface);
  expect(r.data).toStrictEqual(after);
});

test('a tile is kept once however many times it is touched, and only touched tiles are kept', () => {
  const r = makeRaster(TILE * 4, TILE * 4);
  const surface = rasterSurface(r);
  const snap = new TileSnapshot(r.width, r.height);
  snap.capture(surface, { x: 1, y: 1, w: 3, h: 3 });
  snap.capture(surface, { x: 5, y: 5, w: 3, h: 3 });
  expect(snap.bytes).toBe(TILE * TILE * 4);
  snap.capture(surface, { x: -50, y: -50, w: 10, h: 10 }); // outside: nothing
  expect(snap.bytes).toBe(TILE * TILE * 4);
});

test('a snapshot of an edge tile keeps only the pixels that exist', () => {
  const r = makeRaster(TILE + 3, 4);
  const snap = new TileSnapshot(r.width, r.height);
  snap.capture(rasterSurface(r), { x: TILE, y: 0, w: 3, h: 4 });
  expect(snap.bytes).toBe(3 * 4 * 4);
});
