import { Resources, RestartNotice } from './Resources';
import { RunCard } from './RunCard';
import { RunHistoryTable } from './RunHistoryTable';
import { RunPanel } from './RunPanel';
import { useTicketRuns } from '../../../api/ai';
import { TicketTimeline } from './TicketTimeline';
import type { Ticket } from '../../../types';

/**
 * The ticket's AI activity view as the canvas design draws it (design/source/AiTicketWork, AiResources and
 * AiTimelineCases), in the order it had on main: the run going now, its restart notice and Resources strip, then the
 * ticket's Timeline under "Open in Timeline". The design's own mock numbers; connecting it to the board comes later.
 *
 * TODO(connect to data): the old code on `main` does this for real; port from it, see the table in `./mock.ts`.
 */
export function AiActivityDesign({
  ticketId,
  onOpenTimeline,
  onOpenRun,
}: {
  ticketId: string;
  onOpenTimeline?: () => void;
  onOpenRun?: () => void;
}) {
  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '12px 24px 24px' }}
      data-testid="ai-activity"
    >
      <RunCard ticketId={ticketId} onOpenRun={onOpenRun} />
      <RestartNotice ticketId={ticketId} onOpenRun={onOpenRun} />
      <Resources ticketId={ticketId} />
      {/* the button belongs to the Timeline under it: close to it, apart from the Resources card above */}
      <div data-testid="ticket-timeline" style={{ marginTop: 10 }}>
        <button
          type="button"
          className="ai-btn ai-btn-sm"
          style={{ marginBottom: 8 }}
          data-testid="open-in-timeline"
          onClick={onOpenTimeline}
        >
          Open in Timeline
        </button>
        <TicketTimeline ticketId={ticketId} />
      </div>
    </div>
  );
}

/** The run panel and the table of runs, as the canvas design draws them: the ticket's AI tab, opened by Open run. */
export function AiRunPanelDesign({ ticket }: { ticket: Ticket }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 2px' }} data-testid="ai-run-panel">
      <NewestRunPanel ticketId={ticket.id} />
      <div style={{ overflowX: 'auto' }}>
        <RunHistoryTable ticket={ticket} />
      </div>
    </div>
  );
}

/** The ticket's newest run in full (a click in the table below picks another one). */
function NewestRunPanel({ ticketId }: { ticketId: string }) {
  const runs = (useTicketRuns(ticketId).data ?? []).filter((r) => r.kind === 'team');
  if (!runs.length) return null;
  return <RunPanel key={runs[0].id} runId={runs[0].id} />;
}
