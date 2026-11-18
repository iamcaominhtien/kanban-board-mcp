import type { JSONContent } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import { applyChoices, changedBlocks, joinText, mergeBlocks } from './merge';

const p = (id: string, text: string, attrs: Record<string, unknown> = {}): JSONContent => ({
  type: 'paragraph',
  attrs: { blockId: id, ...attrs },
  content: [{ type: 'text', text }],
});
const img = (id: string, placement: string): JSONContent => ({
  type: 'image',
  attrs: { blockId: id, src: '/uploads/a.png', placement },
});
const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content });
const texts = (d: JSONContent) => (d.content ?? []).map((n) => n.content?.[0]?.text ?? n.attrs?.placement);

describe('mergeBlocks', () => {
  const base = doc(p('b-000001', 'One.'), p('b-000002', 'Two.'), img('b-000003', 'left'), p('b-000004', 'Four.'));

  it('joins changes to different blocks and says who made each', () => {
    const mine = doc(
      p('b-000001', 'One, mine.'),
      p('b-000002', 'Two.'),
      img('b-000003', 'left'),
      p('b-000004', 'Four.'),
    );
    const theirs = doc(p('b-000001', 'One.'), p('b-000002', 'Two.'), img('b-000003', 'center'), p('b-000004', 'Four!'));
    const m = mergeBlocks(base, mine, theirs);
    expect(m.conflicts).toEqual([]);
    expect(m.joined.map((j) => [j.id, j.by])).toEqual([
      ['b-000001', 'mine'],
      ['b-000003', 'theirs'],
      ['b-000004', 'theirs'],
    ]);
    expect(texts(applyChoices(m, {}))).toEqual(['One, mine.', 'Two.', 'center', 'Four!']);
  });

  it('keeps a block only one side added where it was, and drops one only one side removed', () => {
    const mine = doc(
      p('b-000001', 'One.'),
      p('b-0000aa', 'New of mine.'),
      p('b-000002', 'Two.'),
      img('b-000003', 'left'),
    );
    const theirs = doc(
      p('b-000001', 'One.'),
      img('b-000003', 'left'),
      p('b-000004', 'Four.'),
      p('b-0000bb', 'Theirs.'),
    );
    const m = mergeBlocks(base, mine, theirs);
    expect(m.conflicts).toEqual([]);
    // they removed Two, I removed Four; my new block follows One
    expect(texts(applyChoices(m, {}))).toEqual(['One.', 'New of mine.', 'left', 'Theirs.']);
    expect(m.joined.find((j) => j.id === 'b-0000aa')).toMatchObject({ by: 'mine', kind: 'added' });
    expect(m.joined.find((j) => j.id === 'b-000002')).toMatchObject({ by: 'theirs', kind: 'removed' });
  });

  it('joins two edits to different parts of one paragraph', () => {
    const b = doc(p('b-000001', 'Forty-one, the same as yesterday, and the same as the year the floods came.'));
    const mine = doc(p('b-000001', 'Forty-two, the same as yesterday, and the same as the year the floods came.'));
    const theirs = doc(
      p('b-000001', 'Forty-one, the same as yesterday, and the same as the year the floods first came.'),
    );
    const m = mergeBlocks(b, mine, theirs);
    expect(m.conflicts).toEqual([]);
    expect(m.joined[0]).toMatchObject({ by: 'both', kind: 'changed' });
    expect(texts(applyChoices(m, {}))).toEqual([
      'Forty-two, the same as yesterday, and the same as the year the floods first came.',
    ]);
  });

  it('asks when both changed the same words or the same picture, and applies each choice', () => {
    const mine = doc(
      p('b-000001', 'One, mine.'),
      p('b-000002', 'Two.'),
      img('b-000003', 'floatRight'),
      p('b-000004', 'Four.'),
    );
    const theirs = doc(
      p('b-000001', 'One, theirs.'),
      p('b-000002', 'Two.'),
      img('b-000003', 'center'),
      p('b-000004', 'Four.'),
    );
    const m = mergeBlocks(base, mine, theirs);
    expect(m.conflicts.map((c) => c.id)).toEqual(['b-000001', 'b-000003']);
    expect(texts(applyChoices(m, { 'b-000001': 'theirs', 'b-000003': 'mine' }))).toEqual([
      'One, theirs.',
      'Two.',
      'floatRight',
      'Four.',
    ]);
    const both = applyChoices(m, { 'b-000001': 'both' }, () => 'b-00ffff');
    expect(texts(both).slice(0, 2)).toEqual(['One, mine.', 'One, theirs.']);
    expect(both.content?.[1].attrs?.blockId).toBe('b-00ffff');
  });

  it('takes a change both made the same way once', () => {
    const same = doc(p('b-000001', 'Both.'), p('b-000002', 'Two.'), img('b-000003', 'left'), p('b-000004', 'Four.'));
    const m = mergeBlocks(base, same, same);
    expect(m.conflicts).toEqual([]);
    expect(m.joined).toEqual([]);
    expect(texts(applyChoices(m, {}))[0]).toBe('Both.');
  });
});

describe('joinText', () => {
  it('refuses when the changed parts meet', () => {
    expect(joinText(p('b-000001', 'abc'), p('b-000001', 'aXc'), p('b-000001', 'aYc'))).toBeNull();
  });
  it('refuses other blocks than text', () => {
    expect(joinText(img('b-000001', 'left'), img('b-000001', 'center'), img('b-000001', 'left'))).toBeNull();
  });
});

describe('changedBlocks', () => {
  it('lists added, removed and changed blocks', () => {
    const a = doc(p('b-000001', 'One.'), p('b-000002', 'Two.'));
    const z = doc(p('b-000001', 'One!'), p('b-000003', 'Three.'));
    expect(changedBlocks(a, z).map((c) => c.id)).toEqual(['b-000001', 'b-000003', 'b-000002']);
  });
});
