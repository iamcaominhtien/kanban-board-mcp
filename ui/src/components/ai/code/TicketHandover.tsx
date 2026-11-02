import { useState } from 'react';
import { PullStatus } from './PullStatus';
import { codeApi, useCodeMutation, useTicketFlags, useTicketWorktree } from '../../../api/aiCode';
import { extractError } from '../../../api/extractError';
import { useAiMember } from '../../../api/ai';
import type { Ticket } from '../../../types';
import type { HandoverRoute, MergeResult } from '../../../types/aiCode';
import { ConflictCard, ROUTE_TEXT, ROUTE_TITLE, StateChip, mbText, uncommittedText } from './worktreeUi';

/** A ticket's worktree and hand-over (design/screens/ai-operations.md, J): ready to hand over, merge, a conflict. */
export function TicketHandover({ ticket }: { ticket: Ticket }) {
  const wt = useTicketWorktree(ticket.id);
  const hasWt = !!wt.data && wt.data.state !== 'removed';
  const flags = useTicketFlags(ticket.id, hasWt);
  const assignee = useAiMember(ticket.assignee ?? null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MergeResult | null>(null);
  const merge = useCodeMutation(() => codeApi.merge(ticket.id));
  const handover = useCodeMutation((r: HandoverRoute) => codeApi.handover(ticket.id, r));
  const conflict = useCodeMutation((v: { choice: 'ai' | 'me' | 'later'; memberId?: string }) =>
    codeApi.conflict(ticket.id, v.choice, v.memberId),
  );

  const w = wt.data;
  if (!w || w.state === 'removed') return null;

  const openConflict = flags.data?.some((f) => f.kind === 'merge_conflict' && f.open) || w.state === 'conflict';
  const route = (w as { route?: HandoverRoute }).route ?? w.handover ?? 'auto';
  const eff: Exclude<HandoverRoute, 'auto'> = route === 'auto' ? 'pr' : route;
  const dirty = (w.live?.uncommitted.length ?? 0) > 0;
  const lastMember = assignee.data && assignee.data.kind === 'ai' ? assignee.data : null;
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(extractError(e));
    }
  };

  return (
    <div
      className="ai-card"
      style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}
      data-testid="ticket-handover"
      data-ticket={ticket.id}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }} data-testid="handover-worktree">
        <span style={{ fontSize: 13, fontWeight: 700 }}>Worktree</span>
        <StateChip state={w.state} />
        <span className="ai-mono" style={{ fontSize: 12 }}>
          {w.branch}
        </span>
        <span className="ai-muted">
          {w.live ? `${mbText(w.live.sizeMb)} · ` : ''}
          {w.port ? `port ${w.port} · ` : ''}
          {uncommittedText(w)}
        </span>
      </div>
      {w.prUrl && (
        <div>
          <a href={w.prUrl} target="_blank" rel="noreferrer" className="ai-link" data-testid="handover-pr">
            Pull request{w.prNumber ? ` #${w.prNumber}` : ''}
          </a>
        </div>
      )}

      {openConflict ? (
        <ConflictCard
          files={w.conflictFiles}
          memberName={lastMember?.name ?? null}
          busy={conflict.isPending}
          error={error}
          onChoose={(choice) =>
            void run(() => conflict.mutateAsync({ choice, memberId: choice === 'ai' ? lastMember?.id : undefined }))
          }
        />
      ) : w.state === 'merged' ? (
        <div className="ai-hint">Merged. The worktree is removed and its port is given back.</div>
      ) : (
        <div className="ai-notice ai-notice-info" style={{ display: 'block' }} data-testid="ready-to-hand-over">
          <div style={{ fontWeight: 700 }}>Ready to hand over</div>
          <div style={{ margin: '3px 0 8px' }}>
            This ticket hands over by <b>{ROUTE_TITLE[eff].toLowerCase()}</b>. {ROUTE_TEXT[eff]}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {eff !== 'local' ? (
              <button
                type="button"
                className="ai-btn ai-btn-sm"
                disabled={handover.isPending}
                data-testid="merge-here"
                onClick={() => void run(() => handover.mutateAsync('local'))}
              >
                Merge here instead
              </button>
            ) : null}
            {eff === 'local' && (
              <button
                type="button"
                className="ai-btn ai-btn-sm ai-btn-primary"
                disabled={merge.isPending || dirty}
                title={dirty ? 'Commit or keep the changes in the worktree first' : undefined}
                data-testid="merge-btn"
                onClick={() => void run(async () => setResult(await merge.mutateAsync(undefined)))}
              >
                {merge.isPending ? 'Merging...' : 'Merge'}
              </button>
            )}
            {eff === 'local' && (
              <span className="ai-hint">Merging also removes the worktree. Only you merge, never a rule or an AI.</span>
            )}
          </div>
        </div>
      )}
      {result?.refused && (
        <div className="ai-notice ai-notice-warn" role="alert" data-testid="merge-refused">
          {result.refused}
        </div>
      )}
      {result?.merged && <div className="ai-ok-text">Merged.</div>}
      {result?.prUrl && (
        <a href={result.prUrl} target="_blank" rel="noreferrer" className="ai-link">
          Pull request
        </a>
      )}
      {!openConflict && error && <div className="ai-error-text">{error}</div>}
      <PullStatus ticketId={ticket.id} />
    </div>
  );
}
