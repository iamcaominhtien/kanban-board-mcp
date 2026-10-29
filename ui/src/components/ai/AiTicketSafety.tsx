import { useState } from 'react';
import { useAiMutation } from '../../api/ai';
import { safetyApi, useAiChain, useBlockedBanner, useCommentFlags, useRunLimit, useAiMe } from '../../api/aiSafety';
import { extractError } from '../../api/extractError';
import { useToast } from '../Toast';
import { RememberedApprovals } from './AiInbox';
import { Pill, TrustChip } from './aiSafetyUi';
import { useAiBoardState } from './aiUi';

/** Prompt-injection flag under a comment (F4): the chip, the “Why” popover and Keep fenced / Hide from AI agents. */
export function CommentAiFlag({ ticketId, commentId }: { ticketId: string; commentId: string }) {
  const flags = useCommentFlags(ticketId);
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const hide = useAiMutation((hidden: boolean) => safetyApi.hideComment(ticketId, commentId, hidden));
  const flag = flags.data?.find((f) => f.commentId === commentId);
  if (!flag) return null;
  const looksLike = flag.phrases.length > 0;
  return (
    <div
      className="ai-root"
      style={{ position: 'relative', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
      data-testid="comment-ai-flag"
    >
      {looksLike && (
        <Pill bg="#FDF5E6" color="#8A5A12">
          ⚠ Looks like instructions: treated as plain text
        </Pill>
      )}
      {!looksLike && flag.trust === 'untrusted' && (
        <Pill bg="#FDF5E6" color="#8A5A12">
          Outside the project: fenced for AI
        </Pill>
      )}
      {flag.hidden && <Pill>Hidden from AI agents</Pill>}
      <button type="button" className="ai-link" onClick={() => setOpen(!open)} data-testid="comment-ai-flag-why">
        Why
      </button>
      {open && (
        <div
          className="ai-popover-flag"
          style={{ position: 'static', width: '100%', maxWidth: 380 }}
          role="dialog"
          aria-label="Why this was flagged"
        >
          <b>Why this was flagged</b>
          {looksLike ? (
            <div style={{ fontSize: 12.5 }}>{flag.phrases.map((p) => `“${p}”`).join(' · ')}</div>
          ) : (
            <div style={{ fontSize: 12.5 }}>It was written by someone outside the project.</div>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <TrustChip trust={flag.trust} />
            <span className="ai-muted">{flag.author}: trust comes from who wrote it; there is no “mark as safe”.</span>
          </div>
          {(
            [
              [false, 'Keep fenced (default)'],
              [true, 'Hide from AI agents'],
            ] as const
          ).map(([hidden, label]) => (
            <button
              key={label}
              type="button"
              className={`ai-option ${flag.hidden === hidden ? 'ai-option-active' : ''}`}
              onClick={async () => {
                try {
                  await hide.mutateAsync(hidden);
                  void flags.refetch();
                } catch (err) {
                  toast.error("Couldn't change it", extractError(err));
                }
              }}
            >
              <span className={`ai-radio ${flag.hidden === hidden ? 'ai-radio-on' : ''}`} /> {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** What the ticket shows for safety: blocked banner (F5), the run-limit box (G), the chain of mentions and remembered approvals. */
export function TicketSafetyBlocks({ ticketId }: { ticketId: string }) {
  const blocked = useBlockedBanner(ticketId);
  const limit = useRunLimit(ticketId);
  const chain = useAiChain(ticketId);
  const board = useAiBoardState();
  const toast = useToast();
  const hide = useAiMutation((v: { commentId: string }) => safetyApi.hideComment(ticketId, v.commentId, true));
  const more = useAiMutation(() => safetyApi.allowMoreRuns(ticketId));
  const me = useAiMe(board.projectId);
  const banners = blocked.data ?? [];
  const showChain = (chain.data?.nodes.length ?? 0) > 2 || !!chain.data?.blocked;
  if (!banners.length && !limit.data?.reached && !showChain) return <RememberedApprovals ticketId={ticketId} />;
  return (
    <div
      className="ai-root"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '12px 24px',
        borderBottom: '1px solid #e3e8e5',
        background: '#fff',
      }}
      data-testid="ticket-safety"
    >
      {banners.slice(0, 1).map((b) => (
        <div
          key={b.entryId}
          className="ai-notice ai-notice-error"
          style={{ alignItems: 'center', flexWrap: 'wrap' }}
          data-testid="ai-blocked-banner"
        >
          <div style={{ flex: 1 }}>
            <b>AI action blocked on {ticketId}</b>
            <div>
              A run read an untrusted comment{b.author ? ` (${b.author})` : ''} and tried to{' '}
              {b.action.replace(/_/g, ' ')}. Nothing was changed. The comment is fenced for AI.
            </div>
          </div>
          <button type="button" className="ai-btn ai-btn-sm" onClick={() => board.openAiTab?.('audit')}>
            Open audit entry
          </button>
          <button
            type="button"
            className="ai-btn ai-btn-sm"
            onClick={async () => {
              try {
                await hide.mutateAsync({ commentId: b.commentId });
                void blocked.refetch();
              } catch (err) {
                toast.error("Couldn't hide it", extractError(err));
              }
            }}
            data-testid="blocked-hide-comment"
          >
            Hide comment from AI
          </button>
        </div>
      ))}
      {limit.data?.reached && (
        <div
          className="ai-notice ai-notice-warn"
          style={{ alignItems: 'center', flexWrap: 'wrap' }}
          data-testid="run-limit-box"
        >
          <div style={{ flex: 1 }}>
            <b>Run limit reached</b>
            <div>
              {ticketId} has used {limit.data.used} of {limit.data.limit} runs today.
            </div>
          </div>
          <button
            type="button"
            className="ai-btn ai-btn-sm"
            disabled={me.data?.role !== 'owner' || more.isPending}
            title={me.data?.role !== 'owner' ? 'Owners only' : undefined}
            onClick={async () => {
              try {
                await more.mutateAsync(undefined);
                toast.success('3 more runs allowed', 'Until midnight.');
                void limit.refetch();
              } catch (err) {
                toast.error("Couldn't allow more runs", extractError(err));
              }
            }}
            data-testid="allow-more-runs"
          >
            Allow 3 more runs <span className="ai-muted">owners only</span>
          </button>
        </div>
      )}
      {showChain && chain.data && (
        <div data-testid="ai-chain">
          <div className="ai-label ai-label-dark">Who woke whom</div>
          <div className="ai-chain" style={{ marginTop: 4 }}>
            {chain.data.nodes.map((n, i) => (
              <span key={i} style={{ display: 'contents' }}>
                {i > 0 && <span className="ai-muted">→</span>}
                <span className="ai-chain-node">
                  {n.name}
                  <small>{n.kind === 'person' ? 'person' : `depth ${n.depth} of ${chain.data!.maxDepth}`}</small>
                </span>
              </span>
            ))}
            {chain.data.blocked?.to && (
              <>
                <span className="ai-muted">→</span>
                <span className="ai-chain-node ai-chain-bad">
                  {chain.data.blocked.to}
                  <small>blocked</small>
                </span>
              </>
            )}
          </div>
          <div className="ai-chips" style={{ marginTop: 6 }}>
            <Pill>Max depth {chain.data.maxDepth}</Pill>
            <Pill>Cooldown {chain.data.cooldownS} s</Pill>
            {chain.data.blocked?.reason && (
              <Pill bg="#FBEEEA" color="#C4432A">
                {chain.data.blocked.to}: {chain.data.blocked.reason}
              </Pill>
            )}
          </div>
        </div>
      )}
      <RememberedApprovals ticketId={ticketId} />
    </div>
  );
}
