import test from 'node:test';
import assert from 'node:assert/strict';
import { floodMask, growMask, maskToPatch } from './floodFill.ts';
import { makeRaster, contentBounds, type Raster } from './raster.ts';

function px(r: Raster, x: number, y: number): number[] {
  const p = (y * r.width + x) * 4;
  return Array.from(r.data.subarray(p, p + 4));
}

function set(r: Raster, x: number, y: number, c: [number, number, number, number]): void {
  r.data.set(c, (y * r.width + x) * 4);
}

/** A white page with a black rectangle outline from (2,2) to (7,7). */
function boxed(): Raster {
  const r = makeRaster(10, 10);
  for (let i = 0; i < r.width * r.height; i++) r.data.set([255, 255, 255, 255], i * 4);
  for (let i = 2; i <= 7; i++) {
    for (const [x, y] of [
      [i, 2],
      [i, 7],
      [2, i],
      [7, i],
    ])
      set(r, x, y, [0, 0, 0, 255]);
  }
  return r;
}

test('fills the inside of a closed shape and stops at its outline', () => {
  const m = floodMask(boxed(), 4, 4, 0);
  assert.ok(m);
  assert.equal(m.count, 16); // the 4 x 4 inside
  assert.deepEqual(m.bounds, { x: 3, y: 3, w: 4, h: 4 });
  assert.equal(m.mask[0], 0); // the outside is not reached
});

test('fills the outside when started outside', () => {
  const m = floodMask(boxed(), 0, 0, 0);
  assert.ok(m);
  assert.equal(m.count, 64); // everything outside the 6 x 6 box
  assert.equal(m.mask[4 * 10 + 4], 0);
});

test('a gap in the outline lets the fill leak, a closed outline does not', () => {
  const r = boxed();
  set(r, 7, 4, [255, 255, 255, 255]); // a gap
  const m = floodMask(r, 4, 4, 0);
  assert.ok(m);
  assert.equal(m.count, 81); // the inside, the gap and everything outside
  assert.equal(m.mask[0], 1);
});

test('tolerance decides whether a near colour is part of the area', () => {
  const r = makeRaster(4, 1);
  set(r, 0, 0, [100, 100, 100, 255]);
  set(r, 1, 0, [110, 100, 100, 255]);
  set(r, 2, 0, [140, 100, 100, 255]);
  set(r, 3, 0, [100, 100, 100, 255]);
  assert.equal(floodMask(r, 0, 0, 0)?.count, 1);
  assert.equal(floodMask(r, 0, 0, 10)?.count, 2);
  assert.equal(floodMask(r, 0, 0, 40)?.count, 4);
});

test('transparent pixels count as one colour', () => {
  const r = makeRaster(3, 1);
  set(r, 0, 0, [0, 0, 0, 0]);
  set(r, 1, 0, [200, 10, 10, 0]);
  set(r, 2, 0, [0, 0, 0, 255]);
  assert.equal(floodMask(r, 0, 0, 0)?.count, 2);
});

test('a point outside the picture fills nothing', () => {
  assert.equal(floodMask(boxed(), -1, 3, 0), null);
  assert.equal(floodMask(boxed(), 3, 10, 0), null);
});

test('growing the fill by one pixel covers the edge of the outline', () => {
  const m = floodMask(boxed(), 4, 4, 0);
  assert.ok(m);
  const g = growMask(m, 1);
  assert.equal(g.count, 32); // the inside plus a pixel on each side (the corners are not touched)
  assert.deepEqual(g.bounds, { x: 2, y: 2, w: 6, h: 6 });
  assert.equal(m.count, 16); // the input is untouched
});

test('the patch is coloured exactly where the fill reached', () => {
  const m = floodMask(boxed(), 4, 4, 0);
  assert.ok(m);
  const patch = maskToPatch(m, [255, 0, 0, 255]);
  assert.equal(patch.width, 4);
  assert.deepEqual(px(patch, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(contentBounds(patch), { x: 0, y: 0, w: 4, h: 4 });
});

test('a large open area is filled quickly', () => {
  const big = makeRaster(2000, 2000);
  const t0 = Date.now();
  const m = floodMask(big, 1000, 1000, 0);
  assert.equal(m?.count, 4_000_000);
  assert.ok(Date.now() - t0 < 2000, 'a 4 megapixel fill should take well under 2 seconds');
});
