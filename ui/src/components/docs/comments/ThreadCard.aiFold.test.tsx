// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocsCommentItem, DocsCommentsResult, DocsCommentThread } from '../../../types/docs';

vi.mock('../../../api/docsComments', () => ({
  useThreadAiActions: () => ({ suggestEdit: { isPending: false }, summarise: { isPending: false } }),
}));
vi.mock('./CommentText', () => ({ CommentText: ({ text }: { text: string }) => <p>{text}</p> }));
vi.mock('./CommentBox', () => ({ CommentBox: () => null }));

import { ThreadCard } from './ThreadCard';

const members = [
  { id: 'dv', name: 'Dev Khoa', color: '#2E6F40', role: 'editor', kind: 'ai' },
  { id: 'rv', name: 'Reviewer Binh', color: '#5B5FA8', role: 'editor', kind: 'ai' },
] as unknown as DocsCommentsResult['members'];
const NAMES: Record<string, string> = { dv: 'Dev Khoa', rv: 'Reviewer Binh' };
const item = (id: string, author: string, mentions: string[]): DocsCommentItem =>
  ({
    id,
    threadId: 't1',
    author,
    body: `${id} body`,
    mentions: mentions.map((m) => ({ id: m, name: NAMES[m] })),
    createdAt: '2026-11-02T10:00:00Z',
    editedAt: null,
    canEdit: false,
    canDelete: false,
  }) as DocsCommentItem;

const thread = {
  id: 't1',
  pageId: 'pg',
  kind: 'inline',
  status: 'open',
  number: 1,
  anchor: { quote: 'Rate limits are not enforced yet.', state: 'attached' },
  createdBy: 'Reviewer Binh',
  createdAt: '',
  resolvedBy: null,
  resolvedAt: null,
  unread: false,
  comments: [
    item('root', 'Reviewer Binh', ['dv']),
    item('r1', 'Dev Khoa', ['rv']),
    item('r2', 'Reviewer Binh', ['dv']),
    item('r3', 'Dev Khoa', []),
  ],
  canReply: false,
  canResolve: false,
} as unknown as DocsCommentThread;

afterEach(() => cleanup());

describe('a Docs thread between two AIs', () => {
  it('folds the replies between AIs into one line, says who each is to, and shows them on a click', () => {
    render(
      <ThreadCard
        thread={thread}
        projectId="p1"
        data={{ members, me: 'user', threads: [], role: 'editor' } as unknown as DocsCommentsResult}
        actions={{} as never}
        active={false}
        version={1}
        reattaching={false}
        onActivate={() => undefined}
        onReattach={() => undefined}
        suggestMembers={[]}
      />,
    );
    const fold = screen.getByTestId('ai-replies-fold');
    expect(fold.textContent).toContain('2 replies between AIs');
    expect(screen.getAllByTestId('comment-item').map((e) => e.textContent)).toEqual([
      expect.stringContaining('root body'),
      expect.stringContaining('r3 body'),
    ]);
    expect(screen.getByTestId('comment-to').textContent).toBe('to Dev Khoa');
    fireEvent.click(fold);
    expect(screen.getAllByTestId('comment-item')).toHaveLength(4);
    expect(screen.getAllByTestId('comment-to').map((e) => e.textContent)).toEqual([
      'to Dev Khoa',
      'to Reviewer Binh',
      'to Dev Khoa',
    ]);
  });
});
