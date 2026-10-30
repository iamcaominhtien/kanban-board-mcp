import { describe, expect, it } from 'vitest';
import type { DocsCommentItem, DocsCommentMember, DocsCommentThread } from '../types/docs';
import {
  aiBusy,
  aiCostLabel,
  aiReplyKind,
  canSuggestEdit,
  canSummarise,
  mentionedAi,
  mentionRows,
  serverIntent,
  thinking,
} from './docsThreadAiRules';

const human: DocsCommentMember = { id: 'h1', name: 'Linh Pham', color: '#123456', role: 'member', kind: 'human' };
const ready: DocsCommentMember = {
  id: 'a1',
  name: 'Reviewer',
  color: '#654321',
  role: 'member',
  kind: 'ai',
  ai: { status: 'ready', usable: true, note: '', provider: 'anthropic' },
};
const paused: DocsCommentMember = {
  id: 'a2',
  name: 'Docs Writer',
  color: '#000000',
  role: 'member',
  kind: 'ai',
  ai: { status: 'paused', usable: false, note: 'Paused', provider: 'gemini' },
};

const comment = (over: Partial<DocsCommentItem> = {}): DocsCommentItem => ({
  id: 'c1',
  threadId: 't1',
  author: 'Reviewer',
  body: 'x',
  mentions: [],
  createdAt: '2026-10-30T00:00:00Z',
  editedAt: null,
  canEdit: false,
  canDelete: false,
  ...over,
});

const thread = (over: Partial<DocsCommentThread> = {}): DocsCommentThread => ({
  id: 't1',
  pageId: 'p1',
  kind: 'inline',
  status: 'open',
  number: 1,
  anchor: null,
  createdBy: 'Linh Pham',
  createdAt: '2026-10-30T00:00:00Z',
  resolvedBy: null,
  resolvedAt: null,
  unread: false,
  comments: [comment()],
  canReply: true,
  canResolve: true,
  aiJobs: [],
  aiSummary: null,
  ...over,
});

describe('mentionRows', () => {
  it('lists AI members in an AI group, usable first, only while Docs AI is on', () => {
    const rows = mentionRows([paused, human, ready], true);
    expect(rows.map((r) => [r.name, r.group, r.usable])).toEqual([
      ['Linh Pham', 'People', true],
      ['Reviewer', 'AI', true],
      ['Docs Writer', 'AI', false],
    ]);
    expect(rows[2].status).toBe('Paused');
  });
  it('offers no AI member when Docs AI is off', () => {
    const rows = mentionRows([human, ready], false);
    expect(rows.map((r) => r.name)).toEqual(['Linh Pham']);
    expect(rows[0].group).toBeUndefined();
  });
});

describe('mentionedAi', () => {
  it('finds picker links and typed names, not people or partial names', () => {
    const members = [human, ready, paused];
    expect(mentionedAi('Hi @[Reviewer](member:a1)', members)).toEqual([ready]);
    expect(mentionedAi('@docs writer can you?', members)).toEqual([paused]);
    expect(mentionedAi('@Linh Pham and @Reviewers', members)).toEqual([]);
  });
});

describe('thread state', () => {
  it('maps Do the work to suggest', () => {
    expect(serverIntent('work')).toBe('suggest');
    expect(serverIntent('notify')).toBe('notify');
  });
  it('knows AI reply kinds and when Suggest an edit shows', () => {
    const answer = comment({ ai: { memberId: 'a1', canSuggest: true } });
    expect(aiReplyKind(answer)).toBe('answer');
    expect(aiReplyKind(comment({ ai: { memberId: 'a1', kind: 'note' } }))).toBe('note');
    expect(aiReplyKind(comment())).toBeNull();
    expect(canSuggestEdit(answer, thread(), true)).toBe(true);
    expect(canSuggestEdit(answer, thread(), false)).toBe(false);
    expect(canSuggestEdit(answer, thread({ status: 'resolved' }), true)).toBe(false);
    expect(canSuggestEdit(comment({ ai: { memberId: 'a1', canSuggest: false } }), thread(), true)).toBe(false);
  });
  it('shows thinking and offers a summary on long threads', () => {
    const busy = thread({
      aiJobs: [{ id: 'j', kind: 'thread_reply', state: 'running', memberId: 'a1', memberName: 'Reviewer', step: null }],
    });
    expect(thinking(busy)).toEqual([{ name: 'Reviewer', kind: 'thread_reply', step: null }]);
    expect(aiBusy([thread(), busy])).toBe(true);
    expect(aiBusy([thread()])).toBe(false);
    const long = thread({ comments: [comment(), comment(), comment(), comment()] });
    expect(canSummarise(long, true)).toBe(true);
    expect(canSummarise(thread(), true)).toBe(false);
    expect(
      canSummarise(
        { ...long, aiSummary: { text: 's', count: 4, cost: 0, jobId: 'j', memberName: 'R', at: null } },
        true,
      ),
    ).toBe(false);
  });
  it('labels the cost', () => {
    expect(aiCostLabel(0.004)).toBe('AI · $0.004');
    expect(aiCostLabel(0)).toBe('AI');
  });
});
