import { expect, test } from 'vitest';
import { SourceError, byteLength, parseSource, serializeSource, type SketchSource } from './sourceFormat';

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
  expect(back.width).toBe(840);
  expect(back.layers.length).toBe(2);
  expect(back.layers[1].texts[0].text).toBe('badge only after the run ends?');
  expect(back.layers[1].opacity).toBe(0.5);
  expect(back.layers[0].locked).toBe(true);
  expect(back.activeLayer).toBe('l2');
  expect(back.recent).toStrictEqual(['#e8441a']);
});

test('what is not a sketch file is refused with a readable message', () => {
  expect(() => parseSource('{nope')).toThrow(SourceError);
  expect(() => parseSource('{"format":"other","layers":[]}')).toThrow(/not a sketch file/);
  const newer = { ...sample(), version: 2 };
  expect(() => parseSource(JSON.stringify(newer))).toThrow(/newer version/);
});

test('size and layer limits are checked on opening', () => {
  expect(() => parseSource(JSON.stringify({ ...sample(), width: 5000 }))).toThrow(/canvas size/);
  expect(() => parseSource(JSON.stringify({ ...sample(), width: 10.5 }))).toThrow(/canvas size/);
  const many = { ...sample(), layers: Array.from({ length: 11 }, (_, i) => ({ id: `l${i}`, png: null })) };
  expect(() => parseSource(JSON.stringify(many))).toThrow(/1 to 10 layers/);
  expect(() => parseSource(JSON.stringify({ ...sample(), layers: [] }))).toThrow(/1 to 10 layers/);
});

test('a layer picture must be a PNG', () => {
  const bad = sample();
  bad.layers[1].png = 'data:text/html;base64,PHNjcmlwdD4=';
  expect(() => parseSource(JSON.stringify(bad))).toThrow(/not a PNG/);
  const url = sample();
  url.layers[1].png = 'https://example.com/x.png';
  expect(() => parseSource(JSON.stringify(url))).toThrow(/not a PNG/);
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
  expect(back.background).toBe('white');
  expect(back.activeLayer).toBe(undefined);
  const l = back.layers[0];
  expect(l.opacity).toBe(1);
  expect(l.kind).toBe('layer');
  expect(l.texts.length).toBe(1);
  expect(l.texts[0].color).toBe('#000000');
  expect(l.texts[0].size).toBe(512);
});

test('duplicate layer ids are made unique', () => {
  const dup = sample();
  dup.layers[1].id = 'l1';
  const back = parseSource(JSON.stringify(dup));
  expect(back.layers[0].id).not.toBe(back.layers[1].id);
});

test('the byte length counts UTF-8 like the server does', () => {
  for (const s of ['abc', 'é', '日本', 'a😀b', '']) {
    expect(byteLength(s)).toBe(new TextEncoder().encode(s).length);
  }
});
