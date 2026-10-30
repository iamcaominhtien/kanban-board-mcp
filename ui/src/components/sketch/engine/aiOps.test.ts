import { expect, test } from 'vitest';
import { MAX_AI_OPS, aiTexts, cleanAiOps, describeAiOps, drawAiShapes, type AiOp, type OpsContext } from './aiOps';

/** A context that writes down what it was asked to do. */
function recorder() {
  const calls: string[] = [];
  const ctx: Record<string, unknown> = {};
  for (const m of ['save', 'restore', 'beginPath', 'closePath', 'stroke', 'fill']) ctx[m] = () => calls.push(m);
  for (const m of ['moveTo', 'lineTo', 'rect', 'ellipse'])
    ctx[m] = (...a: number[]) => calls.push(`${m}(${a.map((n) => Math.round(n * 10) / 10).join(',')})`);
  for (const p of ['strokeStyle', 'fillStyle', 'lineWidth']) {
    Object.defineProperty(ctx, p, { set: (v) => calls.push(`${p}=${String(v)}`), get: () => undefined });
  }
  return { ctx: ctx as unknown as OpsContext, calls };
}

test('ops are clamped to the canvas and rounded', () => {
  const { ops, dropped } = cleanAiOps(
    [
      { op: 'line', x1: -5, y1: 10.6, x2: 999, y2: 20, size: 500, color: '#E8441A' },
      { op: 'rect', x: 90, y: 50, w: 50, h: 50 },
      { op: 'text', x: 1, y: 2, text: 'Hi', size: 1000 },
    ],
    100,
    80,
  );
  expect(dropped).toBe(0);
  expect(ops[0]).toStrictEqual({
    op: 'line',
    x1: 0,
    y1: 11,
    x2: 100,
    y2: 20,
    color: '#e8441a',
    size: 60,
    arrow: false,
  });
  expect([ops[1].op, (ops[1] as { w: number }).w, (ops[1] as { h: number }).h]).toStrictEqual(['rect', 10, 30]);
});

test('unusable ops are dropped and counted', () => {
  const { ops, dropped } = cleanAiOps(
    [
      null,
      'line',
      { op: 'eval' },
      { op: 'line', x1: 1, y1: 1, x2: 1, y2: 1 },
      { op: 'line', x1: '1', y1: 1, x2: 5, y2: 5 },
      { op: 'text', x: 1, y: 1, text: '<script>alert(1)</script>' },
      { op: 'text', x: 1, y: 1, text: '   ' },
      { op: 'path', points: [[1, 1]] },
      { op: 'ellipse', x: 1, y: 1, w: 30, h: 20 },
    ],
    100,
    100,
  );
  expect(ops.length).toBe(1);
  expect(dropped).toBe(8);
  expect(cleanAiOps({ op: 'line' }, 10, 10).ops.length).toBe(0);
});

test('there are at most 60 ops and 120 points', () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ op: 'line', x1: 0, y1: 0, x2: 10, y2: i + 1 }));
  expect(cleanAiOps(many, 100, 100).ops.length).toBe(MAX_AI_OPS);
  const [p] = cleanAiOps(
    [{ op: 'path', points: Array.from({ length: 500 }, (_, i) => [i % 100, (i * 7) % 100]) }],
    100,
    100,
  ).ops;
  expect(p.op === 'path' && p.points.length <= 120).toBeTruthy();
});

test('text loses tags and control characters and keeps three lines', () => {
  const [t] = cleanAiOps([{ op: 'text', x: 0, y: 0, text: 'a<b>bold</b>\u0000 x\n\n\ntwo\nthree\nfour' }], 50, 50).ops;
  expect(t.op === 'text' && t.text).toBe('abold x\ntwo\nthree');
});

test('shapes are drawn with the op colour and size; an arrow adds a filled head', () => {
  const ops: AiOp[] = [
    { op: 'line', x1: 0, y1: 0, x2: 100, y2: 0, color: '#112233', size: 5, arrow: true },
    { op: 'rect', x: 10, y: 20, w: 30, h: 40, color: '#445566', size: 2, fill: true },
    { op: 'ellipse', x: 0, y: 0, w: 20, h: 10, color: '#778899', size: 1, fill: false },
    {
      op: 'path',
      points: [
        [0, 0],
        [5, 5],
        [9, 1],
      ],
      color: '#000000',
      size: 3,
      closed: true,
    },
    { op: 'text', x: 1, y: 1, text: 'skipped', color: '#000000', size: 20, bold: false },
  ];
  const { ctx, calls } = recorder();
  drawAiShapes(ctx, ops);
  const text = calls.join(' ');
  expect(text).toMatch(/strokeStyle=#112233 fillStyle=#112233 lineWidth=5/);
  expect(text).toMatch(/moveTo\(0,0\) lineTo\(100,0\) stroke/);
  expect(text).toMatch(/closePath fill restore/); // the arrow head
  expect(text).toMatch(/rect\(10,20,30,40\) fill/);
  expect(text).toMatch(/ellipse\(10,5,10,5,0,0,6\.3\) stroke/);
  expect(text).toMatch(/moveTo\(0,0\) lineTo\(5,5\) lineTo\(9,1\) closePath stroke/);
  expect((text.match(/save/g) ?? []).length).toBe(4); // the text op is not a shape
  expect((text.match(/save/g) ?? []).length).toBe((text.match(/restore/g) ?? []).length);
});

test('text ops become editable text objects with unique ids', () => {
  const ops = cleanAiOps(
    [
      { op: 'rect', x: 0, y: 0, w: 5, h: 5 },
      { op: 'text', x: 3, y: 4, text: 'One', color: '#112233', size: 24, bold: true },
      { op: 'text', x: 9, y: 9, text: 'Two' },
    ],
    50,
    50,
  ).ops;
  const texts = aiTexts(ops, 'q');
  expect(texts.map((t) => [t.id, t.text, t.size, t.bold])).toStrictEqual([
    ['q1', 'One', 24, true],
    ['q2', 'Two', 28, undefined],
  ]);
});

test('a plain phrase says what was drawn', () => {
  const ops = cleanAiOps(
    [
      { op: 'rect', x: 0, y: 0, w: 5, h: 5 },
      { op: 'ellipse', x: 0, y: 0, w: 5, h: 5 },
      { op: 'line', x1: 0, y1: 0, x2: 5, y2: 5, arrow: true },
      { op: 'text', x: 1, y: 1, text: 'a' },
    ],
    50,
    50,
  ).ops;
  expect(describeAiOps(ops)).toBe('2 shapes, 1 arrow and 1 label');
  expect(describeAiOps([])).toBe('nothing');
});
