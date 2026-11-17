// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocsCommentsResult, DocsCommentThread, RichDoc } from '../../../types/docs';

vi.mock('../../../api/docsComments', () => ({
  useThreadAiActions: () => ({ summarise: { isPending: false } }),
  sentWords: () => '',
}));
vi.mock('./CommentText', () => ({ CommentText: ({ text }: { text: string }) => <p>{text}</p> }));
vi.mock('./CommentBox', () => ({ CommentBox: () => null }));

import { MarginMarks, markInputs } from './MarginMarks';
import { ThreadCard } from './ThreadCard';
import { layoutMarks, threadPlace } from './blockAnchor';
import type { Pick } from './SelectionComment';

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
  content: [{ type: 'tableRow', content: [cell('Quarter'), cell('Status')] }],
};
const embed: RichDoc = { type: 'htmlEmbed', attrs: { blockId: 'b-emb', title: 'Release countdown' } };
const para: RichDoc = {
  type: 'paragraph',
  attrs: { blockId: 'b-1' },
  content: [{ type: 'text', text: 'the same for all of us' }],
};
const doc: RichDoc = { type: 'doc', content: [para, image, table, embed] };

function thread(id: string, number: number, anchor: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    id,
    pageId: 'pg',
    kind: 'inline',
    status: 'open',
    number,
    anchor: { quote: '', prefix: '', suffix: '', section: null, state: 'attached', pos: null, ...anchor },
    createdBy: 'Tuan Vo',
    createdAt: '2026-11-17T10:00:00Z',
    resolvedBy: null,
    resolvedAt: null,
    unread: false,
    comments: [],
    canReply: true,
    canResolve: true,
    ...extra,
  } as unknown as DocsCommentThread;
}

/** The page body as the reader draws it: blocks with their ids, at given heights. */
function pageBody(tops: Record<string, number>) {
  const root = document.createElement('div');
  root.innerHTML = `<div class="dk-md dk-rich">
    <p data-block-id="b-1">the same for all of us</p>
    <figure data-block-id="b-img"><img alt="Planning night" /></figure>
    <div data-block-id="b-tab"><table><tbody><tr><td><p>Quarter</p></td><td><p>Status</p></td></tr></tbody></table></div>
    <div data-block-id="b-emb">Release countdown</div>
  </div>`;
  document.body.appendChild(root);
  root.getBoundingClientRect = () => ({ top: 100, left: 0, right: 600, bottom: 900 }) as DOMRect;
  for (const [id, top] of Object.entries(tops)) {
    const el = root.querySelector(`[data-block-id="${id}"]`) as HTMLElement;
    el.getBoundingClientRect = () => ({ top: 100 + top, left: 0, right: 600, bottom: 100 + top + 40 }) as DOMRect;
  }
  return root;
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('margin marks', () => {
  const threads = [
    thread('t-emb', 4, { quote: 'Release countdown', blockId: 'b-emb' }),
    thread('t-img', 2, { quote: 'Planning night', blockId: 'b-img' }),
    thread('t-tab', 3, { quote: 'Quarter', blockId: 'b-tab' }),
    thread('t-tab2', 5, { quote: 'Status', blockId: 'b-tab' }),
    thread('t-res', 6, { quote: 'Quarter', blockId: 'b-tab' }, { status: 'resolved' }),
  ];

  it('places one mark per block, level with it, in page order; resolved threads leave none', () => {
    const root = pageBody({ 'b-1': 0, 'b-img': 60, 'b-tab': 300, 'b-emb': 500 });
    const marks = layoutMarks(markInputs(root, threads, false));
    expect(marks.map((m) => [m.blockKey, m.top, m.number, m.threadIds.length])).toEqual([
      ['b-img', 60, 2, 1],
      ['b-tab', 300, 3, 2],
      ['b-emb', 500, 4, 1],
    ]);
  });

  it('opens the thread on a click and shows the count of a shared mark', () => {
    const root = pageBody({ 'b-1': 0, 'b-img': 60, 'b-tab': 300, 'b-emb': 500 });
    const onSelect = vi.fn();
    render(
      <MarginMarks
        root={root}
        doc={doc}
        threads={threads}
        panelOpen={false}
        activeId={null}
        layout="desktop"
        revision="1"
        canComment
        onSelect={onSelect}
        onComment={() => undefined}
      />,
    );
    const marks = screen.getAllByTestId('margin-mark');
    expect(marks.map((m) => m.textContent)).toEqual(['2', '3+1', '4']);
    fireEvent.click(marks[1]);
    expect(onSelect).toHaveBeenCalledWith('t-tab');
  });

  it('offers a comment on a whole image, table or embed, with its block id and quote', () => {
    const root = pageBody({ 'b-1': 0, 'b-img': 60, 'b-tab': 300, 'b-emb': 500 });
    const picks: Pick[] = [];
    render(
      <MarginMarks
        root={root}
        doc={doc}
        threads={[]}
        panelOpen={false}
        activeId={null}
        layout="desktop"
        revision="1"
        canComment
        onSelect={() => undefined}
        onComment={(p) => picks.push(p)}
      />,
    );
    for (const id of ['b-img', 'b-tab', 'b-emb']) {
      fireEvent.mouseOver(root.querySelector(`[data-block-id="${id}"]`)!);
      fireEvent.click(screen.getByTestId('block-comment'));
    }
    expect(picks.map((p) => [p.anchor.blockId, p.anchor.quote, p.label])).toEqual([
      ['b-img', 'Planning night', 'Image · Float right'],
      ['b-tab', 'Quarter', 'Table'],
      ['b-emb', 'Release countdown', 'HTML embed · Release countdown'],
    ]);
    // a text block is commented on by selecting its text
    fireEvent.mouseOver(root.querySelector('[data-block-id="b-1"]')!);
    expect(screen.queryByTestId('block-comment')).toBeNull();
  });
});

describe('thread states on the card', () => {
  const data = { members: [], me: 'user', threads: [], role: 'member' } as unknown as DocsCommentsResult;
  const card = (t: DocsCommentThread) =>
    render(
      <ThreadCard
        thread={t}
        projectId="p1"
        data={data}
        actions={{} as never}
        active={false}
        version={14}
        reattaching={false}
        onActivate={() => undefined}
        onReattach={() => undefined}
        suggestMembers={[]}
        place={threadPlace(t, doc)}
      />,
    );

  it('says the quote was edited when its block is there but the words changed', () => {
    card(thread('t', 1, { quote: 'the same for everybody', blockId: 'b-1' }));
    expect(screen.getByTestId('thread-card').dataset.state).toBe('quoteEdited');
    expect(screen.getByTestId('thread-quote-edited').textContent).toContain('The text changed since');
    expect(screen.getByText('Quote edited')).toBeTruthy();
  });

  it('says the block was removed when its block id is gone', () => {
    card(thread('t', 1, { quote: 'Chart', blockId: 'b-gone' }));
    expect(screen.getByTestId('thread-card').dataset.state).toBe('blockDeleted');
    expect(screen.getByText('Block deleted')).toBeTruthy();
    expect(screen.getByTestId('thread-block-deleted').textContent).toContain('The block was removed in v14');
  });

  it('names the block of a whole-block comment instead of quoting it', () => {
    card(thread('t', 2, { quote: 'Planning night', blockId: 'b-img' }));
    expect(screen.getByTestId('thread-card').dataset.state).toBe('open');
    expect(screen.getByTestId('thread-block').textContent).toBe('Image · Float right');
  });

  it('shows an orphaned thread from before the rich format as before', () => {
    card(thread('t', 1, { quote: 'Bearer', state: 'orphaned' }));
    expect(screen.getByTestId('thread-card').dataset.state).toBe('orphaned');
    expect(screen.getByText('Text removed')).toBeTruthy();
  });

  it('shows a resolved thread as resolved', () => {
    card(thread('t', 1, { quote: 'x', blockId: 'b-1' }, { status: 'resolved', resolvedBy: 'Hoa Mai' }));
    expect(screen.getByTestId('thread-card').dataset.state).toBe('resolved');
  });
});
