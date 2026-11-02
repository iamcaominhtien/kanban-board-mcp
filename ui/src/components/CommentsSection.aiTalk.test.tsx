// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiMember } from '../types/ai';
import type { Comment, Member } from '../types/ticket';

vi.mock('../api/ai', () => ({ useTicketRuns: () => ({ data: [] }) }));
vi.mock('./comments/Composer', () => ({ Composer: () => null }));
vi.mock('./ai/useMentionList', () => ({ useAiSuggest: () => [] }));
vi.mock('./ai/AiTicketSafety', () => ({ CommentAiFlag: () => null }));
vi.mock('./MarkdownRenderer', () => ({ MarkdownRenderer: ({ children }: { children: string }) => <p>{children}</p> }));
vi.mock('./Toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

import { AiBoardContext } from './ai/aiUi';
import { CommentsSection } from './CommentsSection';

const member = (id: string, name: string, kind: Member['kind']) =>
  ({ id, name, kind, projectId: 'p1', color: '#2E6F40', createdAt: '' }) as Member;
const members = [
  member('an', 'An Nguyen', 'human'),
  member('dv', 'Dev Khoa', 'ai'),
  member('rv', 'Reviewer Binh', 'ai'),
];
const aiMembers = new Map(
  ['dv', 'rv'].map((id) => [
    id,
    {
      id,
      name: members.find((m) => m.id === id)!.name,
      kind: 'ai',
      provider: 'claude',
      color: '#2E6F40',
    } as unknown as AiMember,
  ]),
);
const c = (id: string, author: string, hm: string, mentions: string[] = []): Comment => ({
  id,
  text: `${id} text`,
  author,
  at: `2026-11-02T${hm}:00`,
  mentions,
});
const comments = [
  c('c1', 'An Nguyen', '12:38'),
  c('c3', 'Dev Khoa', '12:51', ['rv']),
  c('c4', 'Reviewer Binh', '12:58', ['dv']),
  c('c5', 'Dev Khoa', '13:04', ['rv']),
  c('c7', 'Reviewer Binh', '13:12', ['an']),
];

afterEach(() => cleanup());

describe('ticket Comments: AI to AI is folded', () => {
  it('folds the talk between AIs into one line and keeps what is addressed to a person open', async () => {
    const onAdd = vi.fn().mockResolvedValue('new');
    render(
      <AiBoardContext.Provider value={{ projectId: 'p1', members: aiMembers, runsByTicket: new Map(), settings: null }}>
        <CommentsSection
          ticketId="KAN-305"
          projectId="p1"
          comments={comments}
          members={members}
          onAdd={onAdd}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onRestore={vi.fn()}
        />
      </AiBoardContext.Provider>,
    );
    expect(screen.getByTestId('comments-ai-folded').textContent).toBe('AI to AI is folded');
    expect(screen.getAllByTestId('ai-talk-fold')).toHaveLength(1);
    expect(screen.getByTestId('ai-talk-fold').textContent).toContain('Dev Khoa and Reviewer Binh talked 3 times');
    // the person's comment and the note to the person stay open
    const open = screen.getAllByTestId('comment').map((e) => e.getAttribute('data-comment-id'));
    expect(open.sort()).toEqual(['c1', 'c7']);

    fireEvent.click(screen.getByTestId('ai-talk-show'));
    expect(screen.getAllByTestId('ai-talk-message')).toHaveLength(3);
    const join = screen.getByTestId('ai-talk-join');
    fireEvent.change(within(join).getByRole('textbox'), { target: { value: 'Also check keyboard use.' } });
    fireEvent.click(within(join).getByRole('button', { name: 'Send to both' }));
    await waitFor(() =>
      expect(onAdd).toHaveBeenCalledWith(
        '@[Dev Khoa](member:dv) @[Reviewer Binh](member:rv) Also check keyboard use.',
        { intent: 'notify' },
      ),
    );
  });
});
