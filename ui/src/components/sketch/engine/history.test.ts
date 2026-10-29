import test from 'node:test';
import assert from 'node:assert/strict';
import { History, MIN_STEPS, type Step } from './history.ts';
import { TILE, TileSnapshot, rasterSurface } from './tiles.ts';
import { makeRaster } from './raster.ts';

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
  assert.equal(box.v, 11);
  h.undo();
  assert.equal(box.v, 1);
  h.undo();
  assert.equal(box.v, 0);
  assert.equal(h.undo(), null);
  assert.equal(h.canUndo, false);
  h.redo();
  h.redo();
  assert.equal(box.v, 11);
  assert.equal(h.redo(), null);
});

test('a new change forgets what could have been redone', () => {
  const h = new History();
  const box = { v: 0 };
  h.push(addStep(box, 1));
  h.push(addStep(box, 2));
  h.undo();
  h.push(addStep(box, 100));
  assert.equal(h.canRedo, false);
  assert.equal(box.v, 101);
});

test('at least 100 steps can be undone, one after another', () => {
  const h = new History();
  const box = { v: 0 };
  for (let i = 0; i < 150; i++) h.push(addStep(box, 1));
  assert.ok(h.depth >= MIN_STEPS);
  let undone = 0;
  while (h.undo()) undone++;
  assert.ok(undone >= 100);
  assert.equal(box.v, 150 - undone);
});

test('memory pressure drops the oldest steps but never below 100', () => {
  const h = new History(250, 1000);
  const box = { v: 0 };
  for (let i = 0; i < 300; i++) h.push(addStep(box, 1, 1000)); // each step alone fills the budget
  assert.equal(h.depth, MIN_STEPS);
});

test('the step count is capped', () => {
  const h = new History(120);
  const box = { v: 0 };
  for (let i = 0; i < 300; i++) h.push(addStep(box, 1));
  assert.equal(h.depth, 120);
});

test('a listener hears every change', () => {
  const h = new History();
  let calls = 0;
  h.onChange(() => calls++);
  const box = { v: 0 };
  h.push(addStep(box, 1));
  h.undo();
  h.redo();
  assert.equal(calls, 3);
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
  assert.notDeepEqual(after, before);
  snap.swap(surface);
  assert.deepEqual(r.data, before);
  snap.swap(surface);
  assert.deepEqual(r.data, after);
});

test('a tile is kept once however many times it is touched, and only touched tiles are kept', () => {
  const r = makeRaster(TILE * 4, TILE * 4);
  const surface = rasterSurface(r);
  const snap = new TileSnapshot(r.width, r.height);
  snap.capture(surface, { x: 1, y: 1, w: 3, h: 3 });
  snap.capture(surface, { x: 5, y: 5, w: 3, h: 3 });
  assert.equal(snap.bytes, TILE * TILE * 4);
  snap.capture(surface, { x: -50, y: -50, w: 10, h: 10 }); // outside: nothing
  assert.equal(snap.bytes, TILE * TILE * 4);
});

test('a snapshot of an edge tile keeps only the pixels that exist', () => {
  const r = makeRaster(TILE + 3, 4);
  const snap = new TileSnapshot(r.width, r.height);
  snap.capture(rasterSurface(r), { x: TILE, y: 0, w: 3, h: 4 });
  assert.equal(snap.bytes, 3 * 4 * 4);
});
