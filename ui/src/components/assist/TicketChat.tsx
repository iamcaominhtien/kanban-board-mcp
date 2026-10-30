import { useMemo } from 'react';
import { useTicketRuns } from '../../api/ai';
import type { Ticket } from '../../types/ticket';
import { RunStateChip, fmtElapsed, money, useAiBoardState } from '../ai/aiUi';
import { ScopedChat } from './ScopedChat';

/** The "Runs" tab of the ticket chat: the AI runs of this ticket, newest first, each opening its run page. */
function TicketRunsList({ ticketId, onOpenRun }: { ticketId: string; onOpenRun: (runId: string) => void }) {
  const runs = useTicketRuns(ticketId).data ?? [];
  if (!runs.length)
    return (
      <div className="ai-muted" data-testid="chat-runs-empty">
        No AI has worked on this ticket yet. Choose <b>Do the work</b> in the chat to start a run.
      </div>
    );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {runs.map((r) => (
        <div key={r.id} className="sc-runs-row" data-testid="chat-run-row">
          <b>Run #{r.number}</b>
          <span className="ai-muted">{r.mode === 'ask' ? 'Answer only' : 'Work'}</span>
          <RunStateChip state={r.state} />
          <span style={{ flex: 1 }} />
          <span className="ai-muted ai-mono">
            {r.metered ? money(r.costUsd) : 'Not metered'}
            {r.elapsedS != null ? ` · ${fmtElapsed(r.elapsedS)}` : ''}
          </span>
          <button type="button" className="ai-btn ai-btn-sm" onClick={() => onOpenRun(r.id)}>
            Open
          </button>
        </div>
      ))}
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
  const { openAiPage, openAiTab } = useAiBoardState();
  const runs = useTicketRuns(ticket.id).data ?? [];
  const scope = useMemo(() => ({ kind: 'ticket' as const, id: ticket.id }), [ticket.id]);
  return (
    <ScopedChat
      scope={scope}
      onClose={onClose}
      onOpenRun={onOpenRun}
      onOpenAiMembers={() => openAiPage?.()}
      onOpenUsage={() => openAiTab?.('usage')}
      runsTab={{
        label: `Runs ${runs.length}`,
        content: <TicketRunsList ticketId={ticket.id} onOpenRun={onOpenRun} />,
      }}
    />
  );
}
