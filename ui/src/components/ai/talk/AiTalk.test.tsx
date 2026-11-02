// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiMember, AiRun } from '../../../types/ai';
import type { Comment } from '../../../types/ticket';
import type { DocsCommentItem, DocsCommentsResult } from '../../../types/docs';

vi.mock('../../MarkdownRenderer', () => ({ MarkdownRenderer: ({ children }: { children: string }) => children }));

import { AiBoardContext } from '../aiUi';
import { aiReplyRuns, aiToAiReply } from '../../docs/comments/ThreadCard';
import { AiTalkFold } from './AiTalkFold';
import { addressedTo, chainOf, handoffsIn, isAiToAi, joinText, talkRuns, type AiLookup } from './aiTalk';

const NAMES: Record<string, string> = { dv: 'Dev Khoa', rv: 'Reviewer Binh', pm: 'PM Linh', an: 'An Nguyen' };
const ai: AiLookup = {
  isAiId: (id) => ['dv', 'rv', 'pm'].includes(id),
  isAiAuthor: (a) => ['Dev Khoa', 'Reviewer Binh', 'PM Linh'].includes(a),
  nameOf: (id) => NAMES[id] ?? id,
};

const at = (hm: string) => `2026-11-02T${hm}:00`;
const c = (id: string, author: string, hm: string, mentions: string[] = [], o: Partial<Comment> = {}): Comment => ({
  id,
  text: `${author} says ${id}`,
  author,
  at: at(hm),
  mentions,
  ...o,
});

// the frame of P: a person, Dev's summary, the talk, a Board note, the talk again and a note for the person
const thread: Comment[] = [
  c('c1', 'An Nguyen', '12:38'),
  c('c2', 'Dev Khoa', '12:44', [], { ai: { kind: 'summary', runId: 'r', memberId: 'dv' } }),
  c('c3', 'Dev Khoa', '12:51', ['rv']),
  c('c4', 'Reviewer Binh', '12:58', ['dv']),
  c('c5', 'Dev Khoa', '13:04', ['rv']),
  c('c6', 'Reviewer Binh', '13:09'),
  c('c7', 'Reviewer Binh', '13:12', ['an']),
];

const runs = [
  {
    id: 'h1',
    trigger: 'handoff',
    startedBy: 'Dev Khoa',
    memberId: 'rv',
    memberName: 'Reviewer Binh',
    instruction: 'Review (Standard)',
    queuedAt: at('12:51'),
    chain: [],
  },
  {
    id: 'a1',
    trigger: 'mention',
    memberId: 'rv',
    memberName: 'Reviewer Binh',
    queuedAt: at('12:52'),
    chain: ['pm', 'dv'],
  },
  { id: 'old', trigger: 'handoff', memberId: 'dv', queuedAt: at('09:00'), chain: [] },
] as unknown as AiRun[];

afterEach(() => cleanup());

describe('which comments fold', () => {
  it('folds an AI’s comment whose mentions are only AIs, and the plain note that closes the talk', () => {
    expect(isAiToAi(thread[2], ai)).toBe(true);
    expect(isAiToAi(thread[1], ai)).toBe(false); // a summary speaks to the person
    expect(isAiToAi(thread[6], ai)).toBe(false); // addressed to a person
    expect(isAiToAi(c('x', 'An Nguyen', '12:00', ['dv']), ai)).toBe(false); // a person writing
    expect(isAiToAi(c('x', 'Board', '12:00', ['dv'], { boardNote: true }), ai)).toBe(false);
    const [run, ...rest] = talkRuns(thread, ai);
    expect(rest).toHaveLength(0);
    expect(run.ids).toEqual(['c3', 'c4', 'c5', 'c6']);
    expect(run.names).toEqual(['Dev Khoa', 'Reviewer Binh']);
  });

  it('keeps a Board note open: it breaks the run', () => {
    const withNote = [...thread.slice(2, 4), c('b', 'Board', '12:59', [], { boardNote: true }), thread[4]];
    expect(talkRuns(withNote, ai).map((r) => r.ids)).toEqual([['c3', 'c4']]);
  });

  it('says who each message is to, the hand-offs and the chain inside the talk', () => {
    const run = talkRuns(thread, ai)[0];
    expect(addressedTo(thread[2], ai)).toBe('to Reviewer Binh');
    expect(addressedTo(thread[5], ai)).toBe('to the ticket');
    expect(handoffsIn(run, runs).map((r) => r.id)).toEqual(['h1']);
    expect(chainOf(run, runs, ai)).toEqual({ path: ['PM Linh', 'Dev Khoa', 'Reviewer Binh'], depth: 2 });
    expect(joinText([{ id: 'dv', name: 'Dev Khoa' }], ' check keys ')).toBe('@[Dev Khoa](member:dv) check keys');
  });
});

describe('the fold on a ticket', () => {
  const members = new Map(
    ['dv', 'rv'].map((id) => [
      id,
      { id, name: NAMES[id], kind: 'ai', provider: 'claude', color: '#2E6F40', glyph: 'spark' } as unknown as AiMember,
    ]),
  );

  function Host({ onJoin }: { onJoin: (t: string) => Promise<unknown> }) {
    const [open, setOpen] = useState(false);
    return (
      <AiBoardContext.Provider
        value={{
          projectId: 'p1',
          members,
          runsByTicket: new Map(),
          settings: { maxChainDepth: 3 } as never,
        }}
      >
        <AiTalkFold
          run={talkRuns(thread, ai)[0]}
          ticketId="KAN-305"
          ai={ai}
          runs={runs}
          open={open}
          onOpenChange={setOpen}
          onJoin={onJoin}
        />
      </AiBoardContext.Provider>
    );
  }

  it('folds the talk into one line, shows it in order, and joins in with a comment to both', async () => {
    const onJoin = vi.fn().mockResolvedValue({});
    render(<Host onJoin={onJoin} />);
    const line = screen.getByTestId('ai-talk-fold');
    expect(line.textContent).toContain('Dev Khoa and Reviewer Binh talked 4 times');
    expect(line.textContent).toContain('1 hand-off · 12:51 to 13:09 · no question for you');

    fireEvent.click(screen.getByTestId('ai-talk-show'));
    const open = screen.getByTestId('ai-talk-open');
    expect(open.textContent).toContain('The conversation on KAN-305');
    expect(open.textContent).toContain(
      '4 messages · 1 hand-off · chain PM Linh → Dev Khoa → Reviewer Binh · depth 2 of 3',
    );
    expect(screen.getAllByTestId('ai-talk-to').map((e) => e.textContent)).toEqual([
      'to Reviewer Binh',
      'to Dev Khoa',
      'to Reviewer Binh',
      'to the ticket',
    ]);
    expect(screen.getByTestId('ai-talk-handoff').textContent).toContain('Dev Khoa handed KAN-305 to Reviewer Binh');

    const join = screen.getByTestId('ai-talk-join');
    const send = within(join).getByRole('button', { name: 'Send to both' });
    expect(send).toHaveProperty('disabled', true);
    fireEvent.change(within(join).getByRole('textbox'), { target: { value: 'Also check keyboard use.' } });
    fireEvent.click(send);
    await waitFor(() =>
      expect(onJoin).toHaveBeenCalledWith(
        '@[Dev Khoa](member:dv) @[Reviewer Binh](member:rv) Also check keyboard use.',
      ),
    );

    fireEvent.click(screen.getByTestId('ai-talk-fold-again'));
    expect(screen.getByTestId('ai-talk-fold')).toBeTruthy();
  });
});

describe('the fold on a Docs thread', () => {
  const members = [
    { id: 'dv', name: 'Dev Khoa', color: '#2E6F40', role: 'editor', kind: 'ai' },
    { id: 'rv', name: 'Reviewer Binh', color: '#5B5FA8', role: 'editor', kind: 'ai' },
    { id: 'an', name: 'An Nguyen', color: '#2F6FB0', role: 'editor', kind: 'human' },
  ] as unknown as DocsCommentsResult['members'];
  const item = (id: string, author: string, mentions: string[], o: Partial<DocsCommentItem> = {}): DocsCommentItem =>
    ({
      id,
      threadId: 't',
      author,
      body: id,
      mentions: mentions.map((m) => ({ id: m, name: NAMES[m] })),
      createdAt: '',
      editedAt: null,
      canEdit: false,
      canDelete: false,
      ...o,
    }) as DocsCommentItem;

  it('folds two or more replies between AIs, never the first comment and never one to a person', () => {
    const list = [
      item('root', 'Reviewer Binh', ['dv']),
      item('r1', 'Dev Khoa', ['rv']),
      item('r2', 'Reviewer Binh', ['dv']),
      item('r3', 'Dev Khoa', []),
      item('r4', 'Dev Khoa', ['an']),
    ];
    expect(aiToAiReply(list[0], members, 'user')).toBe(true);
    expect(aiToAiReply(list[4], members, 'user')).toBe(false);
    expect(aiToAiReply(item('n', 'Dev Khoa', ['rv'], { ai: { memberId: 'dv', kind: 'note' } }), members, 'user')).toBe(
      false,
    );
    expect(aiReplyRuns(list, members, 'user')).toEqual([['r1', 'r2']]);
    expect(aiReplyRuns(list.slice(0, 2), members, 'user')).toEqual([]);
  });
});
