import { expect, test } from 'vitest';
import { arrowHead, clampZoom, fitZoom, snapAngle, squareCorner } from './geometry';
import { eventPressure, pressureStamp, smoothStep, stampSpacing, stampsAlong } from './brush';
import { MAX_RECENT, SWATCHES, hexToRgb, normaliseHex, pushRecent, rgbToHex } from './colour';
import { clipRect, contentBounds, makeRaster, rectFromCorners, unionRect } from './raster';

const near = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b) < eps, `${a} vs ${b}`).toBeTruthy();

test('shift snaps a line to 15 degrees and keeps its length', () => {
  const p = snapAngle(0, 0, 100, 3);
  near(p.y, 0, 1e-6);
  near(p.x, Math.hypot(100, 3), 1e-6);
  const q = snapAngle(0, 0, 50, 40); // about 38.7 degrees, nearest step is 45
  near(q.x, q.y, 1e-6);
  const r = snapAngle(10, 10, 10, 10);
  expect(r).toStrictEqual({ x: 10, y: 10 });
});

test('shift makes a square from any drag direction', () => {
  expect(squareCorner(0, 0, 30, 10)).toStrictEqual({ x: 30, y: 30 });
  expect(squareCorner(50, 50, 40, 10)).toStrictEqual({ x: 10, y: 10 });
});

test('an arrow head has its tip at the end of the line', () => {
  const h = arrowHead(0, 0, 100, 0, 20);
  expect(h[0]).toStrictEqual({ x: 100, y: 0 });
  expect(h.length).toBe(3);
  expect(h[1].x < 100 && h[2].x < 100 && h[1].y * h[2].y < 0).toBeTruthy();
  expect(arrowHead(5, 5, 5, 5, 20)).toStrictEqual([]);
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
  expect(one.stamps.length).toBe(5);
  expect(n).toBe(one.stamps.length);
  near(one.stamps[0].x, 2);
  expect(stampsAlong({ x: 1, y: 1, p: 1 }, { x: 1, y: 1, p: 1 }, 2, 0).stamps).toStrictEqual([]);
  expect(stampSpacing(1) >= 0.75 && stampSpacing(100) === 12).toBeTruthy();
});

test('pressure changes the size or the opacity, only when it is on', () => {
  expect(pressureStamp(20, 0.2, false, 'size')).toStrictEqual({ size: 20, flow: 1 });
  const light = pressureStamp(20, 0.1, true, 'size');
  const hard = pressureStamp(20, 1, true, 'size');
  expect(light.size < hard.size && hard.size === 20).toBeTruthy();
  const faint = pressureStamp(20, 0.1, true, 'opacity');
  expect(faint.flow < 0.3 && faint.size === 20).toBeTruthy();
  expect(eventPressure('mouse', 0.5)).toBe(0.5);
  expect(eventPressure('pen', 0.8)).toBe(0.8);
  expect(eventPressure('pen', 0)).toBe(0.5);
});

test('smoothing lags behind the pointer more at higher settings', () => {
  const a = { x: 0, y: 0, p: 0.5 };
  const b = { x: 100, y: 0, p: 0.5 };
  expect(smoothStep(a, b, 0).x).toBe(100);
  expect(smoothStep(a, b, 30).x > smoothStep(a, b, 80).x).toBeTruthy();
  expect(smoothStep(a, b, 100).x > 0).toBeTruthy();
});

test('colours are read from hex in both forms and put in a short recent list', () => {
  expect(normaliseHex('#E8441A')).toBe('#e8441a');
  expect(normaliseHex('f80')).toBe('#ff8800');
  expect(normaliseHex('#12')).toBe(null);
  expect(normaliseHex('red')).toBe(null);
  expect(hexToRgb('#e8441a')).toStrictEqual([232, 68, 26]);
  expect(rgbToHex(232, 68, 26)).toBe('#e8441a');
  expect(rgbToHex(300, -5, 0.4)).toBe('#ff0000');
  expect(SWATCHES.every((c) => normaliseHex(c) === c)).toBeTruthy();
  let recent: string[] = [];
  for (let i = 0; i < 12; i++) recent = pushRecent(recent, rgbToHex(i, 0, 0));
  expect(recent.length).toBe(MAX_RECENT);
  expect(recent[0]).toBe(rgbToHex(11, 0, 0));
  expect(pushRecent(['#111111', '#222222'], '#222222')).toStrictEqual(['#222222', '#111111']);
});

test('rectangles are clipped, joined and found from content', () => {
  expect(clipRect({ x: -5, y: -5, w: 10, h: 10 }, 100, 100)).toStrictEqual({ x: 0, y: 0, w: 5, h: 5 });
  expect(clipRect({ x: 200, y: 0, w: 5, h: 5 }, 100, 100)).toBe(null);
  expect(unionRect({ x: 0, y: 0, w: 2, h: 2 }, { x: 5, y: 5, w: 1, h: 1 })).toStrictEqual({ x: 0, y: 0, w: 6, h: 6 });
  expect(rectFromCorners(10, 10, 4, 20)).toStrictEqual({ x: 4, y: 10, w: 6, h: 10 });
  const r = makeRaster(10, 10);
  expect(contentBounds(r)).toBe(null);
  r.data.set([0, 0, 0, 255], (3 * 10 + 4) * 4);
  r.data.set([0, 0, 0, 1], (6 * 10 + 8) * 4);
  expect(contentBounds(r)).toStrictEqual({ x: 4, y: 3, w: 5, h: 4 });
});

test('zoom fits the drawing in the view and stays within its limits', () => {
  near(fitZoom(2000, 1000, 1064, 564), 0.5);
  expect(fitZoom(100, 100, 2000, 2000)).toBe(1); // never enlarged past 100%
  expect(clampZoom(100)).toBe(8);
  expect(clampZoom(0)).toBe(0.05);
});
