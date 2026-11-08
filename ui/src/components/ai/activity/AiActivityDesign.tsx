import { useState } from 'react';
import { Resources, RestartNotice } from './Resources';
import { RunCard } from './RunCard';
import { RunHistoryTable } from './RunHistoryTable';
import { RunPanel, RunStepsBlock } from './RunPanel';
import { useTicketRuns } from '../../../api/ai';
import { elapsedWords, isLive, startedByWords } from './runFormat';
import { useNow } from '../aiUi';
import { TimelineTab } from '../../aiteam/TimelineTab';
import type { AiRun } from '../../../types/ai';
import type { Ticket } from '../../../types';

/**
 * The ticket's AI activity view as the canvas design draws it (design/source/AiTicketWork, AiResources and
 * AiTimelineCases), in the order it had on main: the run going now, its restart notice and Resources strip, then the
 * ticket's Timeline under "Open in Flow". The design's own mock numbers; connecting it to the board comes later.
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
          Open in Flow
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
 * "Full history" shows every run of the ticket one after the other, oldest first, each with all of its steps.
 */
export function AiRunPanelDesign({ ticket }: { ticket: Ticket }) {
  const runs = (useTicketRuns(ticket.id).data ?? []).filter((r) => r.kind === 'team');
  const [picked, setPicked] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  // a run that is gone (another ticket, a deleted run) falls back to the newest
  const shown = runs.find((r) => r.id === picked) ?? runs[0];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 2px' }} data-testid="ai-run-panel">
      {runs.length > 1 && (
        <div style={{ display: 'flex', gap: 8 }} role="tablist" aria-label="What to show">
          <button
            type="button"
            role="tab"
            aria-selected={!full}
            className={`ai-btn ai-btn-sm${full ? '' : ' ai-btn-primary'}`}
            onClick={() => setFull(false)}
          >
            One run
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={full}
            className={`ai-btn ai-btn-sm${full ? ' ai-btn-primary' : ''}`}
            data-testid="full-history"
            onClick={() => setFull(true)}
          >
            Full history ({runs.length} runs)
          </button>
        </div>
      )}
      {full ? <FullHistory runs={runs} /> : shown && <RunPanel key={shown.id} runId={shown.id} />}
      <div style={{ overflowX: 'auto' }}>
        <RunHistoryTable
          ticket={ticket}
          selectedId={full ? undefined : shown?.id}
          onSelect={(id) => {
            setPicked(id);
            setFull(false);
          }}
        />
      </div>
    </div>
  );
}

/** Every run of the ticket, oldest first, each with the whole of its steps (a long run's earlier steps load too). */
function FullHistory({ runs }: { runs: AiRun[] }) {
  const [allOpen, setAllOpen] = useState(false);
  const now = useNow(
    1000,
    runs.some((r) => isLive(r.state)),
  );
  const ordered = [...runs].reverse();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }} data-testid="full-history-view">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: '#1E2A22' }}>Full history</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="mc-link" onClick={() => setAllOpen(true)}>
          Expand all
        </button>
        <button type="button" className="mc-link" onClick={() => setAllOpen(false)}>
          Collapse all
        </button>
      </div>
      {ordered.map((r) => (
        <section key={r.id} data-testid="full-history-run">
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'baseline',
              gap: '4px 10px',
              padding: '6px 0',
              borderBottom: '2px solid #DCE3DE',
              marginBottom: 4,
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 700, color: '#1E2A22' }}>Run #{r.number}</span>
            <span style={{ fontSize: 11.5, color: '#5B6B60' }}>
              {r.state.replace('_', ' ')} · {startedByWords(r)} · {elapsedWords(r, now)}
            </span>
          </div>
          <RunStepsBlock runId={r.id} allOpen={allOpen} />
        </section>
      ))}
    </div>
  );
}
