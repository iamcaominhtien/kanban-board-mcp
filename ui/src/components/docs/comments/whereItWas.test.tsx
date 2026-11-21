// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocsCommentItem, DocsCommentsResult, DocsCommentThread, RichDoc } from '../../../types/docs';

vi.mock('../../../api/docsComments', () => ({
  useThreadAiActions: () => ({ summarise: { isPending: false } }),
  sentWords: () => '',
}));
vi.mock('./CommentText', () => ({ CommentText: ({ text }: { text: string }) => <p>{text}</p> }));
vi.mock('./CommentBox', () => ({ CommentBox: () => null }));
vi.mock('./SendToAi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./SendToAi')>()),
  ThreadSendButton: () => null,
}));

import { ThreadCard } from './ThreadCard';
import { threadPlace } from './blockAnchor';
import { waitsForAnswer } from './SendToAi';
import { WHERE_FLASH_MS, slugWords, whereTarget } from './whereItWas';

const heading: RichDoc = {
  type: 'heading',
  attrs: { blockId: 'b-h', level: 2 },
  content: [{ type: 'text', text: 'Scan rules' }],
};
const para: RichDoc = { type: 'paragraph', attrs: { blockId: 'b-2' }, content: [{ type: 'text', text: 'Later.' }] };
const doc: RichDoc = { type: 'doc', content: [heading, para] };

function comment(id: string, body: string, extra: Partial<DocsCommentItem> = {}): DocsCommentItem {
  return {
    id,
    threadId: 't',
    author: 'user',
    body,
    mentions: [],
    createdAt: '2026-11-17T10:00:00Z',
    editedAt: null,
    canEdit: false,
    canDelete: false,
    ...extra,
  };
}

function thread(anchor: Record<string, unknown>, comments: DocsCommentItem[]): DocsCommentThread {
  return {
    id: 't',
    pageId: 'pg',
    kind: 'inline',
    status: 'open',
    number: null,
    anchor: {
      quote: 'Inferred, not checked.',
      prefix: '',
      suffix: '',
      section: null,
      state: 'attached',
      pos: null,
      ...anchor,
    },
    createdBy: 'user',
    createdAt: '2026-11-17T10:00:00Z',
    resolvedBy: null,
    resolvedAt: null,
    unread: false,
    comments,
    canReply: true,
    canResolve: true,
  } as unknown as DocsCommentThread;
}

const data = { members: [], me: 'user', threads: [], role: 'member' } as unknown as DocsCommentsResult;
const card = (t: DocsCommentThread) =>
  render(
    <ThreadCard
      thread={t}
      projectId="p1"
      data={data}
      actions={{} as never}
      active={false}
      version={49}
      reattaching={false}
      onActivate={() => undefined}
      onReattach={() => undefined}
      suggestMembers={[]}
      place={threadPlace(t, doc)}
    />,
  );

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

const removedLine = comment('c2', 'Text removed in v49', {
  ai: { kind: 'anchor', change: 'removed', version: 49, quote: 'Inferred, not checked.' } as DocsCommentItem['ai'],
});

describe('an orphaned thread shows where its text was', () => {
  it('names the section and scrolls to the block now at that spot, marking it for a moment', () => {
    vi.useFakeTimers();
    const spot = document.createElement('p');
    spot.dataset.blockId = 'b-2';
    spot.scrollIntoView = vi.fn();
    document.body.appendChild(spot);
    card(thread({ state: 'orphaned', blockId: 'b-2', section: 'scan-rules' }, [comment('c1', 'Why?'), removedLine]));
    expect(screen.getByTestId('thread-card').dataset.state).toBe('orphaned');
    expect(screen.getByTestId('thread-section').textContent).toBe('It was in Scan rules.');
    fireEvent.click(screen.getByTestId('thread-show-where'));
    expect(spot.scrollIntoView).toHaveBeenCalled();
    expect(spot.classList.contains('dc-where-flash')).toBe(true);
    vi.advanceTimersByTime(WHERE_FLASH_MS);
    expect(spot.classList.contains('dc-where-flash')).toBe(false);
  });

  it('falls back to the heading of its section', () => {
    const h = document.createElement('h2');
    h.id = 'docs-scan-rules';
    document.body.appendChild(h);
    const t = thread({ state: 'orphaned', section: 'scan-rules' }, [comment('c1', 'Why?')]);
    expect(whereTarget(t, null)).toBe(h);
  });

  it('offers no button when nothing says where it was', () => {
    card(thread({ state: 'orphaned' }, [comment('c1', 'Why?')]));
    expect(screen.queryByTestId('thread-show-where')).toBeNull();
    expect(screen.queryByTestId('thread-section')).toBeNull();
  });

  it('reads a slug as words when the heading is not at hand', () => {
    expect(slugWords('rate-limits-2')).toBe('rate limits');
  });
});

describe('the line a publish writes in a thread', () => {
  it('is one quiet line with the text it was on, not a comment', () => {
    const line = comment('c2', 'Text rewritten in v49', {
      ai: {
        kind: 'anchor',
        change: 'rewritten',
        version: 49,
        quote: 'Inferred, not checked.',
      } as DocsCommentItem['ai'],
    });
    card(thread({ quote: 'Later.', blockId: 'b-2' }, [comment('c1', 'Why?'), line]));
    const row = screen.getByTestId('anchor-line');
    expect(row.dataset.change).toBe('rewritten');
    expect(row.textContent).toContain('Text rewritten in v49');
    expect(row.textContent).toContain('was “Inferred, not checked.”');
    expect(screen.getAllByTestId('comment-item')).toHaveLength(1);
  });

  it('does not make a thread long enough to fold', () => {
    const lines = [1, 2, 3].map((n) =>
      comment(`l${n}`, `Text edited in v${n}`, { ai: { kind: 'anchor', change: 'edited' } as DocsCommentItem['ai'] }),
    );
    const replies = [comment('c1', 'Why?'), comment('c2', 'Because.'), comment('c3', 'Ok.')];
    card(thread({ quote: 'Later.', blockId: 'b-2' }, [...replies, ...lines]));
    expect(screen.queryByTestId('thread-unfold')).toBeNull();
    expect(screen.getAllByTestId('comment-item')).toHaveLength(3);
    expect(screen.getAllByTestId('anchor-line')).toHaveLength(3);
  });

  it('stays after the last comment when a long thread is folded', () => {
    const replies = [1, 2, 3, 4, 5].map((n) => comment(`c${n}`, `Reply ${n}`));
    card(thread({ quote: 'Later.', blockId: 'b-2' }, [...replies, removedLine]));
    expect(screen.getByTestId('thread-unfold').textContent).toContain('Show 4 earlier replies');
    expect(screen.getAllByTestId('comment-item').map((c) => c.textContent)).toEqual([
      expect.stringContaining('Reply 5'),
    ]);
    expect(screen.getByTestId('anchor-line')).toBeTruthy();
  });

  it('is not the last word of a thread sent to an AI', () => {
    const sent = comment('c2', 'Sent to Dev on RES-1', { ai: { kind: 'sent', memberId: 'm', ticketId: 'RES-1' } });
    expect(waitsForAnswer(thread({}, [comment('c1', 'Why?'), sent, removedLine]))).toBe(false);
  });
});
