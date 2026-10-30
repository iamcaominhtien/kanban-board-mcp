import { describe, expect, it } from 'vitest';
import type { DocsAiProposal, ProposalChange } from '../api/docsAiProposals';
import { acceptable, baseLine, bannerMeta, changeState, memberLabel, proposedText } from './docsProposalRules';

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
