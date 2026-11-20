import { describe, expect, it } from 'vitest';
import type { DocsCommentThread, RichDoc } from '../../../types/docs';
import {
  anchorForBlock,
  blockLabel,
  blockQuote,
  layoutMarks,
  orderThreads,
  orphanedByRestore,
  threadPlace,
} from './blockAnchor';

const p = (id: string, text: string): RichDoc => ({
  type: 'paragraph',
  attrs: { blockId: id },
  content: [{ type: 'text', text }],
});
const h = (id: string, text: string): RichDoc => ({
  type: 'heading',
  attrs: { blockId: id, level: 2 },
  content: [{ type: 'text', text }],
});
const image: RichDoc = {
  type: 'image',
  attrs: { blockId: 'b-img', src: '/x.png', alt: 'Planning night', placement: 'floatRight' },
};
const cell = (text: string): RichDoc => ({
  type: 'tableCell',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
const table: RichDoc = {
  type: 'table',
  attrs: { blockId: 'b-tab' },
  content: [
    { type: 'tableRow', content: [cell('Quarter'), cell('Status')] },
    { type: 'tableRow', content: [cell('Q3'), cell('Done')] },
  ],
};
const embed: RichDoc = { type: 'htmlEmbed', attrs: { blockId: 'b-emb', title: 'Release countdown', html: '<b>5</b>' } };
const doc = (...content: RichDoc[]): RichDoc => ({ type: 'doc', content });

const page = doc(h('b-h', 'Why we moved'), p('b-1', 'the same for everybody, and more'), image, table, embed);

function thread(
  id: string,
  anchor: Partial<NonNullable<DocsCommentThread['anchor']>>,
  extra: Partial<DocsCommentThread> = {},
) {
  return {
    id,
    pageId: 'pg',
    kind: 'inline',
    status: 'open',
    number: 1,
    anchor: { quote: '', prefix: '', suffix: '', section: null, state: 'attached', pos: null, ...anchor },
    createdBy: 'me',
    createdAt: '2026-11-17T10:00:00Z',
    resolvedBy: null,
    resolvedAt: null,
    unread: false,
    comments: [],
    canReply: true,
    canResolve: true,
    ...extra,
  } as DocsCommentThread;
}

describe('a comment on a whole block carries its block id and a quote', () => {
  it('quotes an image by its alt text and names its placement', () => {
    const a = anchorForBlock(image, page);
    expect(a).toEqual({ quote: 'Planning night', prefix: '', suffix: '', section: 'why-we-moved', blockId: 'b-img' });
    expect(blockLabel(image)).toBe('Image · Float right');
  });

  it('quotes a table by its first cell', () => {
    expect(anchorForBlock(table, page)).toMatchObject({ quote: 'Quarter', blockId: 'b-tab' });
    expect(blockLabel(table)).toBe('Table');
  });

  it('quotes an embed by its title', () => {
    expect(anchorForBlock(embed, page)).toMatchObject({ quote: 'Release countdown', blockId: 'b-emb' });
    expect(blockLabel(embed)).toBe('HTML embed · Release countdown');
  });

  it('never sends an empty quote', () => {
    expect(blockQuote({ type: 'image', attrs: { blockId: 'b-x', src: '/y.png' } })).toBe('Image');
  });

  it('has no label for a text block (its thread shows the quote)', () => {
    expect(blockLabel(p('b-9', 'Hi'))).toBeNull();
  });
});

describe('threadPlace: the states of a thread', () => {
  it('is open on its block with its quote', () => {
    expect(threadPlace(thread('t', { quote: 'the same for everybody', blockId: 'b-1' }), page)).toMatchObject({
      state: 'open',
      blockIndex: 1,
    });
  });

  it('is resolved once resolved', () => {
    expect(threadPlace(thread('t', { quote: 'x', blockId: 'b-1' }, { status: 'resolved' }), page).state).toBe(
      'resolved',
    );
  });

  it('is "quote edited" when its block is there but the words changed', () => {
    expect(threadPlace(thread('t', { quote: 'the same for all of us', blockId: 'b-1' }), page).state).toBe(
      'quoteEdited',
    );
  });

  it('is "block deleted" when its block is gone', () => {
    expect(threadPlace(thread('t', { quote: 'Chart', blockId: 'b-gone' }), page).state).toBe('blockDeleted');
  });

  it('follows its quote to another block when the server re-matched it', () => {
    expect(threadPlace(thread('t', { quote: 'for everybody', blockId: 'b-gone' }), page)).toMatchObject({
      state: 'open',
      blockIndex: 1,
    });
  });

  it('is orphaned when an old thread (no block id) lost its text', () => {
    expect(threadPlace(thread('t', { quote: 'Bearer', state: 'orphaned' }), page).state).toBe('orphaned');
  });

  it('stays on a whole block and names it', () => {
    expect(threadPlace(thread('t', { quote: 'Planning night', blockId: 'b-img' }), page)).toMatchObject({
      state: 'open',
      label: 'Image · Float right',
    });
  });

  it('keeps the server state on a Markdown page', () => {
    expect(threadPlace(thread('t', { quote: 'x', state: 'orphaned' }), null).state).toBe('orphaned');
  });
});

describe('orderThreads: the panel lists threads in page order', () => {
  it('orders by block, then by where the quote starts, then the gone ones', () => {
    const list = [
      thread('emb', { quote: 'Release countdown', blockId: 'b-emb' }, { number: 1 }),
      thread('gone', { quote: 'old', blockId: 'b-gone' }, { number: 2 }),
      thread('more', { quote: 'and more', blockId: 'b-1' }, { number: 3 }),
      thread('same', { quote: 'the same', blockId: 'b-1' }, { number: 4 }),
      thread('img', { quote: 'Planning night', blockId: 'b-img' }, { number: 5 }),
      thread('legacy', { quote: 'Why we moved' }, { number: 6 }),
    ];
    expect(orderThreads(list, page).map((t) => t.id)).toEqual(['legacy', 'same', 'more', 'img', 'emb', 'gone']);
  });
});

describe('orphanedByRestore: comments on blocks the old version lacks', () => {
  it('counts the open threads whose block the restored version does not have', () => {
    const old = doc(h('b-h', 'Why we moved'), p('b-1', 'the same for everybody, and more'));
    const threads = [
      thread('a', { quote: 'Planning night', blockId: 'b-img' }),
      thread('b', { quote: 'Release countdown', blockId: 'b-emb' }),
      thread('c', { quote: 'the same', blockId: 'b-1' }),
      thread('d', { quote: 'Quarter', blockId: 'b-tab' }, { status: 'resolved' }),
    ];
    expect(orphanedByRestore(threads, page, old)).toBe(2);
    expect(orphanedByRestore(threads, page, page)).toBe(0);
  });
});

describe('layoutMarks: the margin marks', () => {
  it('puts one mark per block, level with it, in page order, and never two on top of each other', () => {
    const marks = layoutMarks([
      { threadId: 't3', number: 3, blockKey: 'b-tab', top: 400 },
      { threadId: 't1', number: 1, blockKey: 'b-1', top: 40 },
      { threadId: 't4', number: 4, blockKey: 'b-1', top: 40 },
      { threadId: 't2', number: 2, blockKey: 'b-img', top: 50 },
    ]);
    expect(marks.map((m) => [m.blockKey, m.top, m.number, m.threadIds])).toEqual([
      ['b-1', 40, 1, ['t1', 't4']],
      ['b-img', 66, 2, ['t2']],
      ['b-tab', 400, 3, ['t3']],
    ]);
  });
});
