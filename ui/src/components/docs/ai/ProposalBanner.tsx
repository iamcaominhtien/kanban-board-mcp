import { useEffect, useState } from 'react';
import { useDocsAiState } from '../../../api/docsAi';
import { usePageProposals } from '../../../api/docsAiProposals';
import type { DocsPage } from '../../../types/docs';
import { aiGate } from '../../../utils/docsAiRules';
import { bannerMeta, memberLabel, REVIEW_PROPOSAL_EVENT } from '../../../utils/docsProposalRules';
import { Icon } from '../Icon';
import { ProposalReview } from './ProposalReview';

/**
 * "Docs Writer (Gemini) proposed 3 changes to this page, for KAN-31 · asked by Hoa Mai · expires in 6 days" with
 * Review changes (docs-ai-care B). Shown only to people who can edit the page, and only while Docs AI is on. It also
 * opens the review panel when a thread's "Review" link asks for a proposal.
 * @param props.projectId - The page's project.
 * @param props.page - The page shown.
 * @param props.canEdit - The person can edit the page (only they decide proposals).
 */
export function ProposalBanner({ projectId, page, canEdit }: { projectId: string; page: DocsPage; canEdit: boolean }) {
  const state = useDocsAiState(projectId);
  const on = aiGate(state.data).show && state.data?.state === 'ready';
  const q = usePageProposals(page.id, on && canEdit);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    const open = (e: Event) => {
      const id = (e as CustomEvent<{ proposalId?: string }>).detail?.proposalId;
      if (id) setOpenId(id);
    };
    window.addEventListener(REVIEW_PROPOSAL_EVENT, open);
    return () => window.removeEventListener(REVIEW_PROPOSAL_EVENT, open);
  }, []);
  useEffect(() => setOpenId(null), [page.id]);

  if (!on || !canEdit || !q.data?.canReview) return null;
  const all = q.data.proposals;
  const waiting = all.filter((p) => p.status === 'waiting');
  const open = all.find((p) => p.id === openId) ?? null;

  return (
    <>
      {waiting.map((p) => (
        <div
          key={p.id}
          data-testid="proposal-banner"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            margin: '0 0 16px',
            padding: '12px 14px',
            border: '1px solid #DDD0F7',
            borderRadius: 10,
            background: '#FAF7FF',
          }}
        >
          <span
            aria-hidden
            style={{
              display: 'inline-flex',
              width: 28,
              height: 28,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 14,
              background: '#EEE6FD',
              color: '#6B4FBB',
              fontSize: 14,
              flex: 'none',
            }}
          >
            ✦
          </span>
          <div style={{ flex: 1, minWidth: 0, fontSize: 13.5, lineHeight: 1.45, color: '#2A2340' }}>
            <div>
              <b>{memberLabel(p)}</b> proposed{' '}
              <b>
                {p.changes.length} {p.changes.length === 1 ? 'change' : 'changes'}
              </b>{' '}
              to this page{p.ticketId ? ', for' : '.'}
            </div>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: 6,
                color: '#6A6380',
                fontSize: 12.5,
              }}
            >
              {p.ticketId && (
                <span
                  style={{
                    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                    fontSize: 12,
                    fontWeight: 600,
                    padding: '1px 7px',
                    border: '1px solid #E2E5E2',
                    borderRadius: 6,
                    background: '#fff',
                    color: '#1E2A22',
                  }}
                >
                  {p.ticketId}
                </span>
              )}
              <span>{bannerMeta(p) ? `· ${bannerMeta(p)}` : ''}</span>
              {p.changedSince && <span style={{ color: '#B26A0B' }}>· page changed since v{p.baseVersion}</span>}
            </div>
          </div>
          <button
            type="button"
            data-testid="proposal-review"
            onClick={() => setOpenId(p.id)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 32,
              padding: '0 14px',
              border: 0,
              borderRadius: 8,
              background: '#7C5CD6',
              color: '#fff',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              flex: 'none',
            }}
          >
            <Icon name="eye" size={14} strokeWidth={1.9} /> Review changes
          </button>
        </div>
      ))}
      {open && (
        <ProposalReview
          proposal={open}
          pageId={page.id}
          days={state.data?.proposalDays ?? 7}
          earlier={all.filter((p) => p.id !== open.id && p.status !== 'waiting')}
          onClose={() => setOpenId(null)}
        />
      )}
    </>
  );
}
