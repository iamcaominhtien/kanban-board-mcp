import { useEffect, useState, type CSSProperties } from 'react';
import { Resources, RestartNotice, StopNotice } from './Resources';
import { RunCard } from './RunCard';
import { RunHistoryTable } from './RunHistoryTable';
import { RunPanel, RunStepsBlock } from './RunPanel';
import { TicketAiStrips } from '../RunPanel';
import { useTicketRuns } from '../../../api/ai';
import { elapsedWords, isLive, startedByWords } from './runFormat';
import { LoadError, useNow } from '../aiUi';
import { TimelineTab } from '../../aiteam/TimelineTab';
import { TicketHandover } from '../code/TicketHandover';
import { PullStatus } from '../code/PullStatus';
import type { AiRun } from '../../../types/ai';
import type { Ticket } from '../../../types';

/**
 * The ticket's AI activity, in the canvas design's look (design/source/AiTicketWork, AiResources, AiOperations H and
 * AiTimelineCases), read from the board: the strips that stop work (AI paused, the account signed out), the newest
 * run, its restart or memory-stop notice and Resources, the hand-over of its code (the worktree, what is left
 * uncommitted, the route, Merge, a conflict) and the pull request the board watches, then the ticket's Timeline under
 * "Open in Flow". Each block shows nothing when the board has nothing for it.
 */
export function AiActivity({
  ticket,
  ticketId,
  projectId,
  shown = true,
  onOpenTimeline,
  onOpenRun,
}: {
  ticket: Ticket;
  ticketId: string;
  projectId: string;
  /** Whether the view is on screen: the Timeline is only loaded then (the rest is small and tells the modal its dot). */
  shown?: boolean;
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
      <StopNotice ticketId={ticketId} onOpenRun={onOpenRun} />
      <Resources ticketId={ticketId} />
      <TicketHandover ticket={ticket} />
      <PullStatus ticketId={ticketId} />
      {/* the button belongs to the Timeline under it: close to it, apart from the Resources card above */}
      {shown && projectId && (
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
      )}
    </div>
  );
}

/**
 * The run panel and the table of runs, as the canvas design draws them: the ticket's AI tab, opened by Open run. The
 * panel shows the newest run, or `runId` when a link asked for that one (a run link in the thread or the chat); a click
 * on a row of the table shows that run instead (any run, from its first step). "Full history" shows every run of the
 * ticket one after the other, oldest first, each with all of its steps.
 */
export function AiRunPanel({ ticket, runId }: { ticket: Ticket; runId?: string | null }) {
  const q = useTicketRuns(ticket.id);
  const runs = (q.data ?? []).filter((r) => r.kind === 'team');
  const [picked, setPicked] = useState<string | null>(runId ?? null);
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!runId) return;
    setPicked(runId);
    setFull(false);
  }, [runId]);
  // "Expand all" / "Collapse all" of the whole page of the full history
  const [allOpen, setAllOpen] = useState(false);
  // a run that is gone (another ticket, a deleted run) falls back to the newest
  const shown = runs.find((r) => r.id === picked) ?? runs[0];
  if (q.isError) return <LoadError what="the runs" error={q.error} onRetry={() => void q.refetch()} />;
  if (q.isLoading) return <span className="ai-spin" />;
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
        <div className="dz dz-tw" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
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
      {!shown && (
        <div className="ai-card ai-root" style={{ padding: 20 }} data-testid="no-runs">
          <b>No AI runs on this ticket yet</b>
          <div className="ai-hint">Assign it to a team, or use Run.</div>
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
