import { useState, type CSSProperties } from 'react';
import { Resources, RestartNotice } from './Resources';
import { RunCard } from './RunCard';
import { RunHistoryTable } from './RunHistoryTable';
import { RunPanel, RunStepsBlock } from './RunPanel';
import { TicketAiStrips } from '../RunPanel';
import { useTicketRuns } from '../../../api/ai';
import { elapsedWords, isLive, startedByWords } from './runFormat';
import { useNow } from '../aiUi';
import { TimelineTab } from '../../aiteam/TimelineTab';
import type { AiRun } from '../../../types/ai';
import type { Ticket } from '../../../types';

/**
 * The ticket's AI activity view as the canvas design draws it (design/source/AiTicketWork, AiResources and
 * AiTimelineCases), in the order it had on main: the run going now, its restart notice and Resources strip, then the
 * ticket's Timeline under "Open in Timeline". The design's own mock numbers; connecting it to the board comes later.
 *
 * TODO(connect to data): the old code on `main` does this for real; port from it, see the table in `./mock.ts`.
 */
export function AiActivityDesign({
  ticket,
  ticketId,
  projectId,
  onOpenTimeline,
  onOpenRun,
}: {
  ticket: Ticket;
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
      <div className="ai-root" style={{ display: 'contents' }}>
        <TicketAiStrips ticket={ticket} />
      </div>
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
 * "Full history" shows every run of the ticket one after the other, oldest first, each with all of its steps.
 */
export function AiRunPanelDesign({ ticket }: { ticket: Ticket }) {
  const runs = (useTicketRuns(ticket.id).data ?? []).filter((r) => r.kind === 'team');
  const [picked, setPicked] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  // "Expand all" / "Collapse all" of the whole page of the full history
  const [allOpen, setAllOpen] = useState(false);
  // a run that is gone (another ticket, a deleted run) falls back to the newest
  const shown = runs.find((r) => r.id === picked) ?? runs[0];
  const seg = (on: boolean): CSSProperties => ({
    padding: '5px 11px',
    borderRadius: 7,
    border: `1px solid ${on ? '#2E6F40' : '#E3E8E5'}`,
    background: on ? '#2E6F40' : '#fff',
    color: on ? '#fff' : '#5B6B60',
    fontSize: 12,
    fontWeight: 600,
    fontFamily: 'inherit',
    cursor: 'pointer',
  });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 2px' }} data-testid="ai-run-panel">
      <div className="ai-root" style={{ display: 'contents' }}>
        <TicketAiStrips ticket={ticket} />
      </div>
      {runs.length > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span role="tablist" aria-label="What to show" style={{ display: 'inline-flex', gap: 6 }}>
            <button type="button" role="tab" aria-selected={!full} style={seg(!full)} onClick={() => setFull(false)}>
              One run
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={full}
              style={seg(full)}
              data-testid="full-history"
              onClick={() => setFull(true)}
            >
              Full history ({runs.length} runs)
            </button>
          </span>
          <span style={{ flex: 1 }} />
          {full && (
            <>
              <button type="button" className="mc-link" onClick={() => setAllOpen(true)}>
                Expand all
              </button>
              <button type="button" className="mc-link" onClick={() => setAllOpen(false)}>
                Collapse all
              </button>
            </>
          )}
        </div>
      )}
      {full ? <FullHistory runs={runs} allOpen={allOpen} /> : shown && <RunPanel key={shown.id} runId={shown.id} />}
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

/** Every run of the ticket, oldest first: its header, its request, how many steps, and its report. */
function FullHistory({ runs, allOpen }: { runs: AiRun[]; allOpen: boolean }) {
  const now = useNow(
    1000,
    runs.some((r) => isLive(r.state)),
  );
  const ordered = [...runs].reverse();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="full-history-view">
      {ordered.map((r) => (
        <section
          key={r.id}
          data-testid="full-history-run"
          style={{
            boxSizing: 'border-box',
            border: '1px solid #E3E8E5',
            borderRadius: 12,
            background: '#fff',
            padding: '10px 13px',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
            <b style={{ fontSize: 13.5 }}>
              {r.mode === 'ask' ? 'Answer' : 'Run'} #{r.number}
            </b>
            <span style={{ fontSize: 12, color: '#5B6B60' }}>
              {r.state.replace('_', ' ')} · {startedByWords(r)}
              {elapsedWords(r, now) ? ` · ${elapsedWords(r, now)}` : ''}
            </span>
          </div>
          <RunStepsBlock runId={r.id} allOpen={allOpen} />
        </section>
      ))}
    </div>
  );
}
