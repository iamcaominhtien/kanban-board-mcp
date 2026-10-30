import { describe, expect, it } from 'vitest';
import type { DocsAiProposal, ProposalChange } from '../api/docsAiProposals';
import {
  acceptable,
  baseLine,
  bannerMeta,
  changeState,
  memberLabel,
  proposedLines,
  proposedText,
  setPendingReview,
  takePendingReview,
} from './docsProposalRules';

const change = (over: Partial<ProposalChange> = {}): ProposalChange => ({
  n: 1,
  kind: 'text',
  title: 'Rewrite',
  reason: 'KAN-31',
  section: null,
  old: 'a',
  new: 'b',
  status: 'pending',
  stale: false,
  ...over,
});

describe('proposal texts', () => {
  it('names the member and the count', () => {
    expect(memberLabel({ memberName: 'Docs Writer', memberProvider: 'Gemini' })).toBe('Docs Writer (Gemini)');
    expect(memberLabel({ memberName: null, memberProvider: null })).toBe('An AI member');
    expect(proposedText(1)).toBe('proposed 1 change to this page');
    expect(proposedText(3)).toBe('proposed 3 changes to this page');
  });
  it('says who asked and when it expires', () => {
    expect(bannerMeta({ onBehalfOf: 'Hoa Mai', expiresInDays: 6 })).toBe('asked by Hoa Mai · expires in 6 days');
    expect(bannerMeta({ onBehalfOf: null, expiresInDays: 0 })).toBe('expires today');
  });
  it('says when the page changed since', () => {
    const p = {
      baseVersion: 14,
      pageVersion: 15,
      changedSince: true,
      stillApply: 2,
      changes: [change(), change({ n: 2 }), change({ n: 3, stale: true })],
    } as Pick<DocsAiProposal, 'baseVersion' | 'pageVersion' | 'changedSince' | 'stillApply' | 'changes'>;
    expect(baseLine(p)).toBe('Made against v14, page is now v15. 2 of 3 changes still apply.');
    expect(baseLine({ ...p, changedSince: false })).toBe('Made against v14. Each change can be accepted on its own.');
    expect(acceptable(p)).toBe(2);
  });
  it('shows a stale pending change as Needs a new look', () => {
    expect(changeState(change({ stale: true }))).toBe('stale');
    expect(changeState(change({ status: 'accepted', stale: true }))).toBe('accepted');
    expect(changeState(change())).toBe('pending');
  });
});

describe('proposedLines', () => {
  const ch = (over: Partial<{ n: number; kind: string; old: string; status: string; stale: boolean }> = {}) => ({
    n: 1,
    kind: 'text',
    old: 'Retries are not implemented yet.\nSecond line here.',
    status: 'pending',
    stale: false,
    ...over,
  });
  const proposal = (changes: ReturnType<typeof ch>[], over = {}) => ({
    id: 'p1',
    status: 'waiting',
    memberName: 'Docs Writer',
    changes,
    ...over,
  });

  it('marks every line of a pending change by its trimmed text', () => {
    const m = proposedLines([proposal([ch()])]);
    expect(m.get('Retries are not implemented yet.')).toEqual({ proposalId: 'p1', n: 1, by: 'Docs Writer' });
    expect(m.get('Second line here.')?.n).toBe(1);
  });

  it('leaves out decided proposals, stale, decided and title changes and very short lines', () => {
    expect(proposedLines([proposal([ch()], { status: 'accepted' })]).size).toBe(0);
    expect(proposedLines([proposal([ch({ stale: true })])]).size).toBe(0);
    expect(proposedLines([proposal([ch({ status: 'accepted' })])]).size).toBe(0);
    expect(proposedLines([proposal([ch({ kind: 'title' })])]).size).toBe(0);
    expect(proposedLines([proposal([ch({ old: 'short' })])]).size).toBe(0);
  });

  it('hands a pending review over once', () => {
    setPendingReview('p9');
    expect(takePendingReview()).toBe('p9');
    expect(takePendingReview()).toBeNull();
  });
});
