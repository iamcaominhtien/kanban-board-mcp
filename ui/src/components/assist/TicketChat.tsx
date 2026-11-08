import { useMemo, useRef } from 'react';
import { useTicketRuns } from '../../api/ai';
import type { Ticket } from '../../types/ticket';
import { QuestionCard } from '../ai/QuestionCard';
import { useAnswerFocus } from '../ai/answerFocus';
import { RunStateChip, fmtElapsed, money, useAiBoardState } from '../ai/aiUi';
import { ScopedChat } from './ScopedChat';
import { ContextMeter } from './ContextMeter';

/** The "Runs" tab of the ticket chat: the AI runs of this ticket, newest first, each opening its run page. */
function TicketRunsList({ ticketId, onOpenRun }: { ticketId: string; onOpenRun: (runId: string) => void }) {
  const runs = useTicketRuns(ticketId).data ?? [];
  if (!runs.length)
    return (
      <div className="ai-muted" data-testid="chat-runs-empty">
        No AI team has worked on this ticket yet. Assign it to a team, or use <b>Run</b>.
      </div>
    );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {runs.map((r) => (
        <div key={r.id} className="sc-runs-row" data-testid="chat-run-row">
          <div className="sc-runs-main">
            <b>Run #{r.number}</b>
            <RunStateChip state={r.state} />
            <span style={{ flex: 1 }} />
            <button type="button" className="ai-btn ai-btn-sm" onClick={() => onOpenRun(r.id)}>
              Open
            </button>
          </div>
          <div className="sc-runs-meta ai-muted">
            <span>{r.mode === 'ask' ? 'Answer only' : 'Work'}</span>
            <span aria-hidden="true">·</span>
            <span className="ai-mono">
              {r.costUsd > 0 ? money(r.costUsd) : 'Not metered'}
              {r.startedAt && r.endedAt
                ? ` · ${fmtElapsed(Math.round((Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 1000))}`
                : ''}
            </span>
            {r.contextUsed && r.contextWindow ? (
              <ContextMeter used={r.contextUsed} size={r.contextWindow} inline />
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

/** A team's question waiting for this person on this ticket: answered here, in the chat the person is using. */
function AskBanner({ ticketId }: { ticketId: string }) {
  const runs = useTicketRuns(ticketId).data ?? [];
  const asking = runs.find((r) => r.state === 'needs_input' && r.question);
  const ref = useRef<HTMLDivElement>(null);
  useAnswerFocus(asking ? ticketId : null, ref);
  if (!asking) return null;
  return (
    <div ref={ref} style={{ padding: '10px 12px 0' }} data-testid="chat-ask-banner">
      <QuestionCard run={asking} />
    </div>
  );
}

/**
 * The AI chat docked in the ticket page (design/screens/ai-where-you-work.md, B): scoped to the ticket, it shows
 * what it reads, keeps the conversation private to the asker, and has the Runs of the ticket in a second tab.
 * @param props.ticket - The ticket the chat is about.
 * @param props.onClose - Close the panel.
 * @param props.onOpenRun - Open a run on the ticket's AI tab.
 */
export function TicketChat({
  ticket,
  onClose,
  onOpenRun,
}: {
  ticket: Ticket;
  onClose: () => void;
  onOpenRun: (runId: string) => void;
}) {
  const { openAiPage } = useAiBoardState();
  const runs = useTicketRuns(ticket.id).data ?? [];
  const scope = useMemo(() => ({ kind: 'ticket' as const, id: ticket.id }), [ticket.id]);
  return (
    <ScopedChat
      scope={scope}
      banner={<AskBanner ticketId={ticket.id} />}
      onClose={onClose}
      onOpenAiMembers={() => openAiPage?.()}
      runsTab={{
        label: `Runs ${runs.length}`,
        content: <TicketRunsList ticketId={ticket.id} onOpenRun={onOpenRun} />,
      }}
    />
  );
}
