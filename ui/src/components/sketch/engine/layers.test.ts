import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LayerLimitError,
  canAddLayer,
  insertLayer,
  layerAfterDelete,
  moveLayer,
  nextLayerId,
  nextLayerName,
} from './layers.ts';
import { MAX_LAYERS, MAX_SIDE, checkLimits, clampSide, fitWithin, nearLimit } from './limits.ts';

const make = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `l${i + 1}`, name: `Layer ${i + 1}` }));

test('a drawing can have 10 layers and no more', () => {
  assert.equal(MAX_LAYERS, 10);
  assert.ok(canAddLayer(9));
  assert.ok(!canAddLayer(10));
  let layers = make(1);
  for (let i = 0; i < 9; i++) layers = insertLayer(layers, { id: nextLayerId(layers), name: nextLayerName(layers) });
  assert.equal(layers.length, 10);
  assert.throws(() => insertLayer(layers, { id: 'x', name: 'x' }), LayerLimitError);
});

test('new layers get unused ids and names', () => {
  const layers = [
    { id: 'l1', name: 'Layer 2' },
    { id: 'l2', name: 'Notes' },
  ];
  assert.equal(nextLayerId(layers), 'l3');
  assert.equal(nextLayerName(layers), 'Layer 3');
});

test('a layer is inserted above the chosen one, or on top', () => {
  const l = make(3);
  assert.deepEqual(
    insertLayer(l, { id: 'n', name: 'n' }, 'l1').map((x) => x.id),
    ['l1', 'n', 'l2', 'l3'],
  );
  assert.deepEqual(
    insertLayer(l, { id: 'n', name: 'n' }).map((x) => x.id),
    ['l1', 'l2', 'l3', 'n'],
  );
  assert.equal(l.length, 3);
});

test('layers move one place and stop at the ends', () => {
  const l = make(3);
  assert.deepEqual(
    moveLayer(l, 'l1', 1).map((x) => x.id),
    ['l2', 'l1', 'l3'],
  );
  assert.equal(moveLayer(l, 'l1', -1), l);
  assert.equal(moveLayer(l, 'l3', 1), l);
});

test('after deleting a layer the one below is selected', () => {
  const l = make(3);
  assert.equal(layerAfterDelete(l, 'l3'), 'l2');
  assert.equal(layerAfterDelete(l, 'l2'), 'l1');
  assert.equal(layerAfterDelete(l, 'l1'), 'l2');
  assert.equal(layerAfterDelete(make(1), 'l1'), null);
});

test('limits are reported before saving, with what to do', () => {
  assert.deepEqual(checkLimits({ width: 840, height: 500, layers: 3, pngBytes: 1000, sourceBytes: 2000 }), []);
  const big = checkLimits({ width: 5000, height: 100, layers: 11, pngBytes: 11 * 1024 * 1024 });
  assert.deepEqual(
    big.map((p) => p.code),
    ['canvas', 'layers', 'png'],
  );
  assert.match(big[0].message, /4096/);
  assert.match(big[2].message, /Crop it or shrink the canvas/);
  assert.equal(checkLimits({ width: MAX_SIDE, height: MAX_SIDE, layers: 10 }).length, 0);
});

test('a warning shows before the limit is reached', () => {
  assert.equal(nearLimit(1024 * 1024, 1024), false);
  assert.equal(nearLimit(9 * 1024 * 1024, 10), true);
});

test('a picture larger than the limit is scaled down, keeping its shape', () => {
  assert.deepEqual(fitWithin(800, 600), { w: 800, h: 600, scaled: false });
  assert.deepEqual(fitWithin(8192, 4096), { w: 4096, h: 2048, scaled: true });
  assert.equal(clampSide(99999, 500), MAX_SIDE);
  assert.equal(clampSide(-3, 500), 1);
  assert.equal(clampSide(NaN, 500), 500);
});
