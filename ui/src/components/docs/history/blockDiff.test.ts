import { describe, expect, it } from 'vitest';
import type { RichDoc } from '../../../types/docs';
import {
  changeDetail,
  changeLabel,
  changeWords,
  countChanges,
  countsPhrase,
  diffBlocks,
  diffItems,
  formatWords,
  jumpLabel,
  noDifference,
  tableChangeText,
} from './blockDiff';

const p = (id: string, text: string, attrs: Record<string, unknown> = {}, marks?: RichDoc['marks']): RichDoc => ({
  type: 'paragraph',
  attrs: { blockId: id, ...attrs },
  content: [{ type: 'text', text, ...(marks ? { marks } : {}) }],
});
const h = (id: string, text: string, attrs: Record<string, unknown> = {}): RichDoc => ({
  type: 'heading',
  attrs: { blockId: id, level: 2, ...attrs },
  content: [{ type: 'text', text }],
});
const img = (id: string, attrs: Record<string, unknown> = {}): RichDoc => ({
  type: 'image',
  attrs: { blockId: id, src: '/a.png', alt: 'Planning night', ...attrs },
});
const cell = (text: string): RichDoc => ({
  type: 'tableCell',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
const table = (id: string, rows: string[][]): RichDoc => ({
  type: 'table',
  attrs: { blockId: id },
  content: rows.map((r) => ({ type: 'tableRow', content: r.map(cell) })),
});
const doc = (...content: RichDoc[]): RichDoc => ({ type: 'doc', content });

const kinds = (a: RichDoc, b: RichDoc) => diffBlocks(a, b).map((c) => `${c.id}:${c.kind}${c.draw ? `/${c.draw}` : ''}`);

describe('diffBlocks: each kind of change', () => {
  it('finds nothing between two equal versions', () => {
    const d = doc(h('b-1', 'Intro'), p('b-2', 'Hello'));
    const c = diffBlocks(d, structuredClone(d));
    expect(c.map((x) => x.kind)).toEqual(['same', 'same']);
    expect(noDifference(countChanges(c))).toBe(true);
  });

  it('finds an added block where it now is', () => {
    expect(kinds(doc(p('b-1', 'A'), p('b-3', 'C')), doc(p('b-1', 'A'), p('b-2', 'B'), p('b-3', 'C')))).toEqual([
      'b-1:same',
      'b-2:added',
      'b-3:same',
    ]);
  });

  it('keeps a removed block where it was, after the block it followed', () => {
    expect(kinds(doc(p('b-1', 'A'), p('b-2', 'B'), p('b-3', 'C')), doc(p('b-1', 'A'), p('b-3', 'C')))).toEqual([
      'b-1:same',
      'b-2:removed',
      'b-3:same',
    ]);
    // the first block removed goes at the start
    expect(kinds(doc(p('b-1', 'A'), p('b-2', 'B')), doc(p('b-2', 'B')))).toEqual(['b-1:removed', 'b-2:same']);
  });

  it('shows a text edit as the words that changed', () => {
    const [c] = diffBlocks(doc(p('b-1', 'The board has three columns')), doc(p('b-1', 'The board has four columns')));
    expect(c.kind).toBe('changed');
    expect(c.draw).toBe('text');
    expect(changeLabel(c)).toBe('Text edited');
    const w = changeWords(c);
    expect(w.filter((s) => s.kind === 'del').map((s) => s.text.trim())).toEqual(['three']);
    expect(w.filter((s) => s.kind === 'add').map((s) => s.text.trim())).toEqual(['four']);
  });

  it('names an attributes-only change as Format, in words', () => {
    const [c] = diffBlocks(doc(h('b-1', 'What changed')), doc(h('b-1', 'What changed', { textAlign: 'center' })));
    expect(c.draw).toBe('format');
    expect(changeLabel(c)).toBe('Format');
    expect(c.changes.map(formatWords)).toEqual(['Alignment: left → centre']);
  });

  it('names a colour change on the text', () => {
    const [c] = diffBlocks(
      doc(p('b-1', 'Tickets stay small')),
      doc(p('b-1', 'Tickets stay small', {}, [{ type: 'textStyle', attrs: { color: 'green' } }])),
    );
    expect(c.draw).toBe('format');
    expect(c.changes.map(formatWords)).toEqual(['Colour: none → green']);
  });

  it('names a bold change that no attribute explains', () => {
    const [c] = diffBlocks(doc(p('b-1', 'Stay small')), doc(p('b-1', 'Stay small', {}, [{ type: 'bold' }])));
    expect(c.draw).toBe('format');
    expect(c.changes.map((x) => x.what)).toEqual(['Text style']);
  });

  it('names a style change (paragraph to heading)', () => {
    const before = p('b-1', 'Rate limits');
    const after = h('b-1', 'Rate limits');
    const [c] = diffBlocks(doc(before), doc(after));
    expect(c.changes.map(formatWords)).toEqual(['Style: Paragraph → Heading 2']);
  });

  it('shows a table as a whole, with what changed in it', () => {
    const a = table('b-1', [
      ['Quarter', 'Status'],
      ['Q3', 'In progress'],
    ]);
    const b = table('b-1', [
      ['Quarter', 'Status'],
      ['Q3', 'Done'],
      ['Q4', 'Planned'],
    ]);
    const [c] = diffBlocks(doc(a), doc(b));
    expect(c.draw).toBe('whole');
    expect(changeLabel(c)).toBe('Changed as a whole');
    expect(changeDetail(c)).toBe('Table · 3 × 2');
    expect(tableChangeText(c.before, c.after)).toBe('1 cell changed, 1 row added');
  });

  it('shows an embed as a whole', () => {
    const e = (title: string): RichDoc => ({
      type: 'htmlEmbed',
      attrs: { blockId: 'b-1', title, html: `<b>${title}</b>` },
    });
    const [c] = diffBlocks(doc(e('12 days')), doc(e('5 days')));
    expect(c.draw).toBe('whole');
    expect(changeDetail(c)).toBe('HTML embed');
  });

  it('names an image’s placement and caption with their words', () => {
    const [c] = diffBlocks(
      doc(img('b-1', { caption: 'Planning night' })),
      doc(img('b-1', { caption: 'Planning night in Hanoi', placement: 'floatRight' })),
    );
    expect(c.draw).toBe('whole');
    expect(changeLabel(c)).toBe('Format');
    expect(c.changes.map(formatWords)).toEqual([
      'Image: centre → float right',
      'Caption: Planning night → Planning night in Hanoi',
    ]);
  });

  it('finds a move, and says where from and where to', () => {
    const a = doc(h('b-1', 'Heading'), p('b-2', 'Body'), p('b-3', 'Pull'), p('b-4', 'Moved one'));
    const b = doc(h('b-1', 'Heading'), p('b-4', 'Moved one'), p('b-2', 'Body'), p('b-3', 'Pull'));
    const c = diffBlocks(a, b);
    expect(c.map((x) => `${x.id}:${x.kind}`)).toEqual(['b-1:same', 'b-4:moved', 'b-2:same', 'b-3:same']);
    const moved = c[1];
    expect(changeLabel(moved)).toBe('Moved');
    expect(moved.moveText).toBe('Up, from after Paragraph 2 to after “Heading”');
    expect(countChanges(c)).toMatchObject({ moved: 1, changed: 0, unchanged: 3 });
  });

  it('marks a block that moved and changed as changed and moved', () => {
    const a = doc(p('b-1', 'One'), p('b-2', 'Two'));
    const b = doc(p('b-2', 'Two'), p('b-1', 'One edited'));
    const c = diffBlocks(a, b);
    const one = c.find((x) => x.id === 'b-1')!;
    const two = c.find((x) => x.id === 'b-2')!;
    // one of the two is the "stable" one; the other moved
    expect([one.moved, two.moved].filter(Boolean)).toHaveLength(1);
    expect(one.kind).toBe('changed');
  });

  it('compares against an empty page (the first version)', () => {
    expect(kinds(doc(), doc(p('b-1', 'A')))).toEqual(['b-1:added']);
    expect(diffBlocks(null, doc(p('b-1', 'A')))[0].kind).toBe('added');
  });
});

describe('countsPhrase: a version row in words', () => {
  it('says how many blocks changed, not lines', () => {
    expect(countsPhrase({ changed: 3, added: 1, removed: 0, moved: 0, unchanged: 9 })).toBe('3 blocks edited, 1 added');
    expect(countsPhrase({ changed: 0, added: 1, removed: 1, moved: 0, unchanged: 0 })).toBe('1 block added, 1 removed');
    expect(countsPhrase({ changed: 0, added: 0, removed: 2, moved: 0, unchanged: 0 })).toBe('2 blocks removed');
    expect(countsPhrase({ changed: 1, added: 0, removed: 0, moved: 0, unchanged: 0 })).toBe('1 block edited');
    expect(countsPhrase({ changed: 0, added: 0, removed: 0, moved: 1, unchanged: 0 })).toBe('1 block moved');
    expect(countsPhrase({ changed: 0, added: 0, removed: 0, moved: 0, unchanged: 4 })).toBe('No block changed');
  });
});

describe('labels in words', () => {
  it('names each kind for the jump list', () => {
    const a = doc(h('b-1', 'What changed'), p('b-2', 'Old note'));
    const b = doc(h('b-1', 'What changed', { textAlign: 'center' }), {
      type: 'callout',
      attrs: { blockId: 'b-3' },
      content: [p('b-4', 'Rate limits')],
    });
    const c = diffBlocks(a, b);
    expect(c.map((x) => changeLabel(x))).toEqual(['Format', 'Removed block', 'New block']);
    expect(jumpLabel(c[0], b)).toEqual({ name: '“What changed”', what: 'Heading 2 · format' });
    expect(jumpLabel(c[1], a).what).toBe('Removed');
    expect(changeDetail(c[2])).toBe('Callout');
  });
});

describe('diffItems: unchanged runs fold, a very large change is cut', () => {
  const a = doc(...Array.from({ length: 6 }, (_, i) => p(`b-${i}`, `Block ${i}`)));
  const b = doc(...Array.from({ length: 6 }, (_, i) => p(`b-${i}`, i === 3 ? 'Edited' : `Block ${i}`)));
  it('folds the unchanged blocks around a change', () => {
    const items = diffItems(diffBlocks(a, b));
    expect(items.map((x) => (x.type === 'fold' ? `fold ${x.blocks.length}` : x.change.id))).toEqual([
      'fold 3',
      'b-3',
      'fold 2',
    ]);
  });
  it('draws an opened fold block by block', () => {
    const items = diffItems(diffBlocks(a, b), Infinity, new Set(['fold-b-0']));
    expect(items.filter((x) => x.type === 'change')).toHaveLength(4);
  });
  it('folds the changes past the limit', () => {
    const c = doc(...Array.from({ length: 6 }, (_, i) => p(`b-${i}`, `Changed ${i}`)));
    const items = diffItems(diffBlocks(a, c), 2);
    expect(items.filter((x) => x.type === 'change')).toHaveLength(2);
    const fold = items.find((x) => x.type === 'fold');
    expect(fold?.type === 'fold' && fold.blocks.length).toBe(4);
  });
});
