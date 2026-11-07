import { useState } from 'react';
import { Resources, RestartNotice } from './Resources';
import { RunCard } from './RunCard';
import { RunHistoryTable } from './RunHistoryTable';
import { RunPanel } from './RunPanel';
import { useTicketRuns } from '../../../api/ai';
import { TimelineTab } from '../../aiteam/TimelineTab';
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
  projectId,
  onOpenTimeline,
  onOpenRun,
}: {
  ticketId: string;
  projectId: string;
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
        <TimelineTab
          projectId={projectId}
          scopeTicketId={ticketId}
          compactChrome
          actions={{ onOpenTicket: () => undefined, onOpenDocsPage: () => undefined }}
        />
      </div>
    </div>
  );
}

/**
 * The run panel and the table of runs, as the canvas design draws them: the ticket's AI tab, opened by Open run. The
 * panel shows the newest run; a click on a row of the table shows that run instead (any run, from its first step).
 */
export function AiRunPanelDesign({ ticket }: { ticket: Ticket }) {
  const runs = (useTicketRuns(ticket.id).data ?? []).filter((r) => r.kind === 'team');
  const [picked, setPicked] = useState<string | null>(null);
  // a run that is gone (another ticket, a deleted run) falls back to the newest
  const shown = runs.find((r) => r.id === picked) ?? runs[0];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 2px' }} data-testid="ai-run-panel">
      {shown && <RunPanel key={shown.id} runId={shown.id} />}
      <div style={{ overflowX: 'auto' }}>
        <RunHistoryTable ticket={ticket} selectedId={shown?.id} onSelect={(id) => setPicked(id)} />
      </div>
    </div>
  );
}
