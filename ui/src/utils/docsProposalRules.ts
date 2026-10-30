/** What the proposal banner and review panel say (docs-ai-care B). Pure, so it is tested. */
import type { DocsAiProposal, ProposalChange } from '../api/docsAiProposals';

/** Window event that opens the review panel of a proposal (a thread's Review button; ProposalBanner listens). */
export const REVIEW_PROPOSAL_EVENT = 'docs-ai:review-proposal';

/** "Docs Writer (Gemini)" */
export function memberLabel(p: Pick<DocsAiProposal, 'memberName' | 'memberProvider'>): string {
  const name = p.memberName ?? 'An AI member';
  return p.memberProvider ? `${name} (${p.memberProvider})` : name;
}

/** "proposed 3 changes to this page" */
export function proposedText(n: number): string {
  return `proposed ${n} ${n === 1 ? 'change' : 'changes'} to this page`;
}

/** "asked by Hoa Mai · expires in 6 days" (the parts after the ticket). */
export function bannerMeta(p: Pick<DocsAiProposal, 'onBehalfOf' | 'expiresInDays'>): string {
  const parts: string[] = [];
  if (p.onBehalfOf) parts.push(`asked by ${p.onBehalfOf === 'user' ? 'the board owner' : p.onBehalfOf}`);
  if (p.expiresInDays !== null && p.expiresInDays !== undefined) {
    parts.push(
      p.expiresInDays <= 0
        ? 'expires today'
        : `expires in ${p.expiresInDays} ${p.expiresInDays === 1 ? 'day' : 'days'}`,
    );
  }
  return parts.join(' · ');
}

/** "Made against v14. Each change can be accepted on its own." or the "page changed since" line. */
export function baseLine(
  p: Pick<DocsAiProposal, 'baseVersion' | 'pageVersion' | 'changedSince' | 'stillApply' | 'changes'>,
): string {
  if (!p.changedSince) return `Made against v${p.baseVersion}. Each change can be accepted on its own.`;
  const total = p.changes.length;
  return `Made against v${p.baseVersion}, page is now v${p.pageVersion}. ${p.stillApply} of ${total} ${
    total === 1 ? 'change still applies' : 'changes still apply'
  }.`;
}

export type ChangeState = 'pending' | 'accepted' | 'rejected' | 'stale';

/** The state a change shows: Needs a new look wins over pending. */
export function changeState(c: ProposalChange): ChangeState {
  if (c.status === 'pending' && c.stale) return 'stale';
  return c.status;
}

/** Changes "Accept all" would put into the draft (pending ones that still apply). */
export function acceptable(p: Pick<DocsAiProposal, 'changes'>): number {
  return p.changes.filter((c) => changeState(c) === 'pending').length;
}

export const STATUS_LABEL: Record<DocsAiProposal['status'], string> = {
  waiting: 'Waiting',
  accepted: 'Accepted',
  partial: 'Partly accepted',
  rejected: 'Rejected',
  expired: 'Expired',
};

/** The states legend of the review panel (docs-ai-care B, "States of a proposal"). */
export function statesLegend(days: number): { key: string; label: string; text: string; color: string }[] {
  return [
    { key: 'waiting', label: 'Waiting', text: `Waits for a reviewer. Expires after ${days} days.`, color: '#7C5CD6' },
    {
      key: 'accepted',
      label: 'Accepted',
      text: 'The accepted changes are in your draft. The proposal stays in Activity.',
      color: '#2E6F40',
    },
    {
      key: 'rejected',
      label: 'Rejected',
      text: 'Closed. The AI member sees it was rejected and why, if you add a reason.',
      color: '#8A8F8B',
    },
    {
      key: 'expired',
      label: 'Expired',
      text: `No decision in ${days} days. Nothing was changed. The AI member can propose again.`,
      color: '#C4432A',
    },
    {
      key: 'changed',
      label: 'Page changed since',
      text: 'Changes whose text is gone show Needs a new look and cannot be accepted.',
      color: '#D98A1C',
    },
  ];
}

/** A block of the page that a waiting proposal wants to change (shown with a purple mark in the page). */
export interface ProposedMark {
  proposalId: string;
  n: number;
  by: string;
}

/**
 * The page lines a waiting proposal would replace, by trimmed source line: a block that contains one of them is
 * marked "Proposed by <AI>" in the page (click to review). Stale and decided changes are not marked.
 */
export function proposedLines(
  proposals: {
    id: string;
    status: string;
    memberName: string | null;
    changes: { n: number; kind: string; old: string; status: string; stale: boolean }[];
  }[],
): Map<string, ProposedMark> {
  const out = new Map<string, ProposedMark>();
  for (const p of proposals) {
    if (p.status !== 'waiting') continue;
    for (const c of p.changes) {
      if (c.kind !== 'text' || c.status !== 'pending' || c.stale) continue;
      for (const line of c.old.split('\n')) {
        const key = line.trim();
        if (key.length >= 6 && !out.has(key))
          out.set(key, { proposalId: p.id, n: c.n, by: p.memberName ?? 'An AI member' });
      }
    }
  }
  return out;
}

let pendingReview: string | null = null;

/** A proposal to open for review as soon as its page is shown (the Approvals list's "Review on page"). */
export function setPendingReview(proposalId: string | null): void {
  pendingReview = proposalId;
}

/** The proposal waiting to be opened, once. */
export function takePendingReview(): string | null {
  const id = pendingReview;
  pendingReview = null;
  return id;
}
