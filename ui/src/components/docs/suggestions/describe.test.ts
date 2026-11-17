import { describe, expect, it } from 'vitest';
import type { RichDoc } from '../../../types/docs';
import type { DocsSuggestion } from './api';
import { attrChanges, blockName, chipLine, describeSuggestion, placeName, textDiff } from './describe';

const p = (id: string, text: string, attrs: Record<string, unknown> = {}, marks?: RichDoc['marks']): RichDoc => ({
  type: 'paragraph',
  attrs: { blockId: id, ...attrs },
  content: [{ type: 'text', text, ...(marks ? { marks } : {}) }],
});
const h = (id: string, text: string, level = 2): RichDoc => ({
  type: 'heading',
  attrs: { blockId: id, level },
  content: [{ type: 'text', text }],
});

function sg(partial: Partial<DocsSuggestion>): DocsSuggestion {
  return {
    id: 's1',
    kind: 'replace',
    blockId: 'b-1',
    afterBlockId: null,
    after: null,
    before: null,
    author: 'Docs team',
    memberId: 'm1',
    runId: 'r1',
    note: null,
    baseVersion: 3,
    createdAt: '2026-11-17T10:00:00Z',
    stale: false,
    ...partial,
  };
}

const label = (s: DocsSuggestion) => {
  const v = describeSuggestion(s);
  return [v.label, v.detail, ...v.changes.map((c) => `${c.what}: ${c.from}→${c.to}`)].filter(Boolean);
};

describe('describeSuggestion: each kind of change in words', () => {
  it('names a text edit and shows the words that changed', () => {
    const s = sg({ before: p('b-1', 'The board has three columns'), after: p('b-1', 'The board has four columns') });
    expect(label(s)).toEqual(['Text edited']);
    const v = describeSuggestion(s);
    expect(v.mode).toBe('diff');
    const diff = textDiff(v);
    expect(diff.filter((d) => d.kind === 'del').map((d) => d.text.trim())).toEqual(['three']);
    expect(diff.filter((d) => d.kind === 'add').map((d) => d.text.trim())).toEqual(['four']);
  });

  it('names an alignment change as Format', () => {
    const s = sg({
      kind: 'attrs',
      before: h('b-1', 'What changed'),
      after: { blockId: 'b-1', level: 2, textAlign: 'center' },
    });
    expect(label(s)).toEqual(['Format', 'Alignment: left→centre']);
    expect(describeSuggestion(s).mode).toBe('after');
  });

  it('names a style change from paragraph to quote', () => {
    const s = sg({
      before: p('b-1', 'Pages do the work'),
      after: { type: 'blockquote', attrs: { blockId: 'b-1' }, content: [p('b-2', 'Pages do the work')] },
    });
    expect(label(s)).toEqual(['Format', 'Style: Paragraph→Quote']);
  });

  it('names a colour and a highlight', () => {
    const s = sg({
      before: p('b-1', 'Tickets stay small'),
      after: p('b-1', 'Tickets stay small', {}, [
        { type: 'highlight', attrs: { color: 'yellow' } },
        { type: 'textStyle', attrs: { color: 'red' } },
      ]),
    });
    expect(label(s)).toEqual(['Format', 'Colour: none→red', 'Highlight: none→yellow']);
  });

  it('names a list type change', () => {
    const item = { type: 'listItem', content: [p('b-9', 'Write the page')] };
    const s = sg({
      before: { type: 'bulletList', attrs: { blockId: 'b-1' }, content: [item] },
      after: { type: 'orderedList', attrs: { blockId: 'b-1' }, content: [item] },
    });
    expect(label(s)).toEqual(['Format', 'List: bullets→numbered']);
  });

  it('names an image placement, width and alt text', () => {
    const img = { type: 'image', attrs: { blockId: 'b-1', src: '/uploads/a.png', widthPct: 50 } };
    expect(
      label(
        sg({
          kind: 'attrs',
          before: img,
          after: { ...img.attrs, placement: 'floatRight', widthPct: 100, alt: 'Six people' },
        }),
      ),
    ).toEqual(['Format', 'Width: 50 %→100 %', 'Image: centre→float right', 'Alt text: none→Six people']);
  });

  it('names a new block with its type and a removed block', () => {
    const callout = { type: 'callout', attrs: { blockId: 'b-7', kind: 'info' }, content: [p('b-8', 'Rate limits')] };
    expect(label(sg({ kind: 'insert', blockId: 'b-7', afterBlockId: 'b-1', after: callout }))).toEqual([
      'New block',
      'Callout',
    ]);
    const del = sg({ kind: 'delete', before: p('b-1', 'Old deck') });
    expect(label(del)).toEqual(['Removed block']);
    expect(describeSuggestion(del).mode).toBe('removed');
  });

  it('replaces a table whole, with its size', () => {
    const cell = (t: string, extra: Record<string, unknown> = {}) => ({
      type: 'tableCell',
      attrs: extra,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }],
    });
    const table = (status: string): RichDoc => ({
      type: 'table',
      attrs: { blockId: 'b-1' },
      content: [
        { type: 'tableRow', content: [cell('Q3', { rowspan: 2 }), cell('Docs'), cell(status)] },
        { type: 'tableRow', content: [cell('Search'), cell('Hoa')] },
      ],
    });
    const s = sg({ before: table('In progress'), after: table('Done') });
    expect(label(s)).toEqual(['Table replaced', '2 × 3, 1 merged cell']);
    expect(describeSuggestion(s).mode).toBe('whole');
  });

  it('names a whole embed replaced', () => {
    const e = (html: string) => ({ type: 'htmlEmbed', attrs: { blockId: 'b-1', html, title: 'Release' } });
    expect(label(sg({ before: e('<b>12</b>'), after: e('<b>5</b>') }))[0]).toBe('Embed replaced');
  });
});

describe('names in words', () => {
  const doc: RichDoc = {
    type: 'doc',
    content: [p('b-1', 'One'), p('b-2', 'Two'), h('b-3', 'What changed'), p('b-4', 'Four')],
  };
  it('numbers paragraphs and names headings by their text', () => {
    expect(blockName(doc.content![1], doc)).toBe('Paragraph 2');
    expect(blockName(doc.content![2], doc)).toBe('Heading 2 “What changed”');
  });
  it('says where a new block goes', () => {
    expect(placeName(sg({ kind: 'insert', afterBlockId: 'b-4' }), doc)).toBe('After paragraph 3');
    expect(placeName(sg({ kind: 'insert', afterBlockId: null }), doc)).toBe('At the start');
  });
  it('makes the chip line', () => {
    expect(
      chipLine([sg({ id: 'a' }), sg({ id: 'b', kind: 'attrs' }), sg({ id: 'c' }), sg({ id: 'd', kind: 'insert' })]),
    ).toBe('Docs team suggested 3 edits and 1 new block');
  });
  it('leaves ids and defaults out of the formatting changes', () => {
    expect(attrChanges({ blockId: 'a', indent: 0 }, { blockId: 'b' })).toEqual([]);
  });
});
