import { expect, test } from 'vitest';
import {
  LayerLimitError,
  canAddLayer,
  insertLayer,
  layerAfterDelete,
  moveLayer,
  nextLayerId,
  nextLayerName,
} from './layers';
import { MAX_LAYERS, MAX_SIDE, checkLimits, clampSide, fitWithin, nearLimit } from './limits';

const make = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `l${i + 1}`, name: `Layer ${i + 1}` }));

test('a drawing can have 10 layers and no more', () => {
  expect(MAX_LAYERS).toBe(10);
  expect(canAddLayer(9)).toBeTruthy();
  expect(!canAddLayer(10)).toBeTruthy();
  let layers = make(1);
  for (let i = 0; i < 9; i++) layers = insertLayer(layers, { id: nextLayerId(layers), name: nextLayerName(layers) });
  expect(layers.length).toBe(10);
  expect(() => insertLayer(layers, { id: 'x', name: 'x' })).toThrow(LayerLimitError);
});

test('new layers get unused ids and names', () => {
  const layers = [
    { id: 'l1', name: 'Layer 2' },
    { id: 'l2', name: 'Notes' },
  ];
  expect(nextLayerId(layers)).toBe('l3');
  expect(nextLayerName(layers)).toBe('Layer 3');
});

test('a layer is inserted above the chosen one, or on top', () => {
  const l = make(3);
  expect(insertLayer(l, { id: 'n', name: 'n' }, 'l1').map((x) => x.id)).toStrictEqual(['l1', 'n', 'l2', 'l3']);
  expect(insertLayer(l, { id: 'n', name: 'n' }).map((x) => x.id)).toStrictEqual(['l1', 'l2', 'l3', 'n']);
  expect(l.length).toBe(3);
});

test('layers move one place and stop at the ends', () => {
  const l = make(3);
  expect(moveLayer(l, 'l1', 1).map((x) => x.id)).toStrictEqual(['l2', 'l1', 'l3']);
  expect(moveLayer(l, 'l1', -1)).toBe(l);
  expect(moveLayer(l, 'l3', 1)).toBe(l);
});

test('after deleting a layer the one below is selected', () => {
  const l = make(3);
  expect(layerAfterDelete(l, 'l3')).toBe('l2');
  expect(layerAfterDelete(l, 'l2')).toBe('l1');
  expect(layerAfterDelete(l, 'l1')).toBe('l2');
  expect(layerAfterDelete(make(1), 'l1')).toBe(null);
});

test('limits are reported before saving, with what to do', () => {
  expect(checkLimits({ width: 840, height: 500, layers: 3, pngBytes: 1000, sourceBytes: 2000 })).toStrictEqual([]);
  const big = checkLimits({ width: 5000, height: 100, layers: 11, pngBytes: 11 * 1024 * 1024 });
  expect(big.map((p) => p.code)).toStrictEqual(['canvas', 'layers', 'png']);
  expect(big[0].message).toMatch(/4096/);
  expect(big[2].message).toMatch(/Crop it or shrink the canvas/);
  expect(checkLimits({ width: MAX_SIDE, height: MAX_SIDE, layers: 10 }).length).toBe(0);
});

test('a warning shows before the limit is reached', () => {
  expect(nearLimit(1024 * 1024, 1024)).toBe(false);
  expect(nearLimit(9 * 1024 * 1024, 10)).toBe(true);
});

test('a picture larger than the limit is scaled down, keeping its shape', () => {
  expect(fitWithin(800, 600)).toStrictEqual({ w: 800, h: 600, scaled: false });
  expect(fitWithin(8192, 4096)).toStrictEqual({ w: 4096, h: 2048, scaled: true });
  expect(clampSide(99999, 500)).toBe(MAX_SIDE);
  expect(clampSide(-3, 500)).toBe(1);
  expect(clampSide(NaN, 500)).toBe(500);
});
