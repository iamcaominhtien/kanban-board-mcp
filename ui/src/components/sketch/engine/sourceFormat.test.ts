import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceError, byteLength, parseSource, serializeSource, type SketchSource } from './sourceFormat.ts';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

function sample(): SketchSource {
  return {
    format: 'kanban-sketch',
    version: 1,
    width: 840,
    height: 500,
    background: 'white',
    activeLayer: 'l2',
    recent: ['#e8441a'],
    layers: [
      { id: 'l1', name: 'Background', kind: 'paper', visible: true, opacity: 1, locked: true, png: null, texts: [] },
      {
        id: 'l2',
        name: 'Notes',
        kind: 'layer',
        visible: true,
        opacity: 0.5,
        locked: false,
        png: PNG,
        texts: [{ id: 't1', x: 10, y: 20, text: 'badge only after the run ends?', size: 28, color: '#2b2b2b' }],
      },
    ],
  };
}

test('a source survives being written and read again', () => {
  const back = parseSource(serializeSource(sample()));
  assert.equal(back.width, 840);
  assert.equal(back.layers.length, 2);
  assert.equal(back.layers[1].texts[0].text, 'badge only after the run ends?');
  assert.equal(back.layers[1].opacity, 0.5);
  assert.equal(back.layers[0].locked, true);
  assert.equal(back.activeLayer, 'l2');
  assert.deepEqual(back.recent, ['#e8441a']);
});

test('what is not a sketch file is refused with a readable message', () => {
  assert.throws(() => parseSource('{nope'), SourceError);
  assert.throws(() => parseSource('{"format":"other","layers":[]}'), /not a sketch file/);
  const newer = { ...sample(), version: 2 };
  assert.throws(() => parseSource(JSON.stringify(newer)), /newer version/);
});

test('size and layer limits are checked on opening', () => {
  assert.throws(() => parseSource(JSON.stringify({ ...sample(), width: 5000 })), /canvas size/);
  assert.throws(() => parseSource(JSON.stringify({ ...sample(), width: 10.5 })), /canvas size/);
  const many = { ...sample(), layers: Array.from({ length: 11 }, (_, i) => ({ id: `l${i}`, png: null })) };
  assert.throws(() => parseSource(JSON.stringify(many)), /1 to 10 layers/);
  assert.throws(() => parseSource(JSON.stringify({ ...sample(), layers: [] })), /1 to 10 layers/);
});

test('a layer picture must be a PNG', () => {
  const bad = sample();
  bad.layers[1].png = 'data:text/html;base64,PHNjcmlwdD4=';
  assert.throws(() => parseSource(JSON.stringify(bad)), /not a PNG/);
  const url = sample();
  url.layers[1].png = 'https://example.com/x.png';
  assert.throws(() => parseSource(JSON.stringify(url)), /not a PNG/);
});

test('missing or odd fields get safe defaults', () => {
  const back = parseSource(
    JSON.stringify({
      format: 'kanban-sketch',
      version: 1,
      width: 10,
      height: 10,
      layers: [{ opacity: 7, texts: [{ text: 'hi', color: 'javascript:1', size: 9999 }, { nope: true }] }],
      activeLayer: 'does-not-exist',
    }),
  );
  assert.equal(back.background, 'white');
  assert.equal(back.activeLayer, undefined);
  const l = back.layers[0];
  assert.equal(l.opacity, 1);
  assert.equal(l.kind, 'layer');
  assert.equal(l.texts.length, 1);
  assert.equal(l.texts[0].color, '#000000');
  assert.equal(l.texts[0].size, 512);
});

test('duplicate layer ids are made unique', () => {
  const dup = sample();
  dup.layers[1].id = 'l1';
  const back = parseSource(JSON.stringify(dup));
  assert.notEqual(back.layers[0].id, back.layers[1].id);
});

test('the byte length counts UTF-8 like the server does', () => {
  for (const s of ['abc', 'é', '日本', 'a😀b', '']) {
    assert.equal(byteLength(s), new TextEncoder().encode(s).length, s);
  }
});
