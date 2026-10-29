import test from 'node:test';
import assert from 'node:assert/strict';
import { arrowHead, clampZoom, fitZoom, snapAngle, squareCorner } from './geometry.ts';
import { eventPressure, pressureStamp, smoothStep, stampSpacing, stampsAlong } from './brush.ts';
import { MAX_RECENT, SWATCHES, hexToRgb, normaliseHex, pushRecent, rgbToHex } from './colour.ts';
import { clipRect, contentBounds, makeRaster, rectFromCorners, unionRect } from './raster.ts';

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('shift snaps a line to 15 degrees and keeps its length', () => {
  const p = snapAngle(0, 0, 100, 3);
  near(p.y, 0, 1e-6);
  near(p.x, Math.hypot(100, 3), 1e-6);
  const q = snapAngle(0, 0, 50, 40); // about 38.7 degrees, nearest step is 45
  near(q.x, q.y, 1e-6);
  const r = snapAngle(10, 10, 10, 10);
  assert.deepEqual(r, { x: 10, y: 10 });
});

test('shift makes a square from any drag direction', () => {
  assert.deepEqual(squareCorner(0, 0, 30, 10), { x: 30, y: 30 });
  assert.deepEqual(squareCorner(50, 50, 40, 10), { x: 10, y: 10 });
});

test('an arrow head has its tip at the end of the line', () => {
  const h = arrowHead(0, 0, 100, 0, 20);
  assert.deepEqual(h[0], { x: 100, y: 0 });
  assert.equal(h.length, 3);
  assert.ok(h[1].x < 100 && h[2].x < 100 && h[1].y * h[2].y < 0);
  assert.deepEqual(arrowHead(5, 5, 5, 5, 20), []);
});

test('a stroke is made of evenly spaced stamps, whatever the pointer speed', () => {
  const spacing = 2;
  // one long move and many short moves give the same stamps
  const one = stampsAlong({ x: 0, y: 0, p: 0.5 }, { x: 10, y: 0, p: 0.5 }, spacing, 0);
  let carry = 0;
  let n = 0;
  for (let i = 0; i < 10; i++) {
    const s = stampsAlong({ x: i, y: 0, p: 0.5 }, { x: i + 1, y: 0, p: 0.5 }, spacing, carry);
    carry = s.carry;
    n += s.stamps.length;
  }
  assert.equal(one.stamps.length, 5);
  assert.equal(n, one.stamps.length);
  near(one.stamps[0].x, 2);
  assert.deepEqual(stampsAlong({ x: 1, y: 1, p: 1 }, { x: 1, y: 1, p: 1 }, 2, 0).stamps, []);
  assert.ok(stampSpacing(1) >= 0.75 && stampSpacing(100) === 12);
});

test('pressure changes the size or the opacity, only when it is on', () => {
  assert.deepEqual(pressureStamp(20, 0.2, false, 'size'), { size: 20, flow: 1 });
  const light = pressureStamp(20, 0.1, true, 'size');
  const hard = pressureStamp(20, 1, true, 'size');
  assert.ok(light.size < hard.size && hard.size === 20);
  const faint = pressureStamp(20, 0.1, true, 'opacity');
  assert.ok(faint.flow < 0.3 && faint.size === 20);
  assert.equal(eventPressure('mouse', 0.5), 0.5);
  assert.equal(eventPressure('pen', 0.8), 0.8);
  assert.equal(eventPressure('pen', 0), 0.5);
});

test('smoothing lags behind the pointer more at higher settings', () => {
  const a = { x: 0, y: 0, p: 0.5 };
  const b = { x: 100, y: 0, p: 0.5 };
  assert.equal(smoothStep(a, b, 0).x, 100);
  assert.ok(smoothStep(a, b, 30).x > smoothStep(a, b, 80).x);
  assert.ok(smoothStep(a, b, 100).x > 0);
});

test('colours are read from hex in both forms and put in a short recent list', () => {
  assert.equal(normaliseHex('#E8441A'), '#e8441a');
  assert.equal(normaliseHex('f80'), '#ff8800');
  assert.equal(normaliseHex('#12'), null);
  assert.equal(normaliseHex('red'), null);
  assert.deepEqual(hexToRgb('#e8441a'), [232, 68, 26]);
  assert.equal(rgbToHex(232, 68, 26), '#e8441a');
  assert.equal(rgbToHex(300, -5, 0.4), '#ff0000');
  assert.ok(SWATCHES.every((c) => normaliseHex(c) === c));
  let recent: string[] = [];
  for (let i = 0; i < 12; i++) recent = pushRecent(recent, rgbToHex(i, 0, 0));
  assert.equal(recent.length, MAX_RECENT);
  assert.equal(recent[0], rgbToHex(11, 0, 0));
  assert.deepEqual(pushRecent(['#111111', '#222222'], '#222222'), ['#222222', '#111111']);
});

test('rectangles are clipped, joined and found from content', () => {
  assert.deepEqual(clipRect({ x: -5, y: -5, w: 10, h: 10 }, 100, 100), { x: 0, y: 0, w: 5, h: 5 });
  assert.equal(clipRect({ x: 200, y: 0, w: 5, h: 5 }, 100, 100), null);
  assert.deepEqual(unionRect({ x: 0, y: 0, w: 2, h: 2 }, { x: 5, y: 5, w: 1, h: 1 }), { x: 0, y: 0, w: 6, h: 6 });
  assert.deepEqual(rectFromCorners(10, 10, 4, 20), { x: 4, y: 10, w: 6, h: 10 });
  const r = makeRaster(10, 10);
  assert.equal(contentBounds(r), null);
  r.data.set([0, 0, 0, 255], (3 * 10 + 4) * 4);
  r.data.set([0, 0, 0, 1], (6 * 10 + 8) * 4);
  assert.deepEqual(contentBounds(r), { x: 4, y: 3, w: 5, h: 4 });
});

test('zoom fits the drawing in the view and stays within its limits', () => {
  near(fitZoom(2000, 1000, 1064, 564), 0.5);
  assert.equal(fitZoom(100, 100, 2000, 2000), 1); // never enlarged past 100%
  assert.equal(clampZoom(100), 8);
  assert.equal(clampZoom(0), 0.05);
});
