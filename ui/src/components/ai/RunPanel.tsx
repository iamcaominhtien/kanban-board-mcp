import { useEffect, useRef, useState } from 'react';
import { aiApi, useAiApprovals, useAiMutation, useTicketRuns } from '../../api/ai';
import { extractError } from '../../api/extractError';
import type { AiRun } from '../../types/ai';
import type { Member, Ticket } from '../../types';
import { useToast } from '../Toast';
import { useScheduleList } from '../../api/schedules';
import { useSchedules } from '../schedules/SchedulesContext';
import { CalendarIcon, ChevronIcon, ListIcon, PlayIcon } from '../schedules/schedulesUi';
import { ApprovalCard } from './AiSafetyViews';
import { ASSIGN_AI_EVENT, fireAiEvent } from './AiTicketContext';
import { QuestionCard } from './QuestionCard';
import { SummaryCard } from './ReviewGate';
import { RaiseLimitButton, TakeOverButton, UndoRunDialog } from './RunActions';
import { BudgetStopBox, budgetStop } from './RunView';
import { ResumeAllDialog } from './AiKillSwitch';
import { PAUSE_COLOR, PauseGlyph, PausedStrip, clockTime, pausedSummary } from './pausedUi';
import {
  ACTIVE_RUN_STATES,
  AiAvatar,
  RunStateChip,
  SparkleIcon,
  fmtElapsed,
  hhmm,
  secondsSince,
  useAiBoardState,
  useNow,
} from './aiUi';

// The run view, steps, history and the AI tab live in RunView.tsx
export { RunSteps, RunView, RunHistory, TicketRunsTab } from './RunView';
export { QuestionCard } from './QuestionCard';

/**
 * Sparkle Run button for the ticket header, with a pulsing dot while a run is active. Its menu starts a run now,
 * schedules one, or shows the ticket's schedules (AI schedules, A2).
 */
export function RunHeaderButton({ ticket, active, onClick }: { ticket: Ticket; active: boolean; onClick: () => void }) {
  const { runsByTicket, members } = useAiBoardState();
  const { openEditor, viewForTicket } = useSchedules();
  const toast = useToast();
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLSpanElement>(null);
  const schedules = useScheduleList(ticket.projectId, ticket.id);
  const run = runsByTicket.get(ticket.id);
  const live = run && (run.state === 'running' || run.state === 'starting');
  const assignee = ticket.assignee ? members.get(ticket.assignee) : undefined;
  const canRun = !!assignee && assignee.connection !== 'inbox' && !(run && ACTIVE_RUN_STATES.includes(run.state));
  const runMut = useAiMutation(() => aiApi.run(ticket.id));
  const count = schedules.data?.items.length ?? 0;
  useEffect(() => {
    if (!menu) return undefined;
    const down = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, [menu]);
  const border = (on: boolean) => `1px solid ${on ? '#2E6F40' : '#E3E8E5'}`;
  return (
    <span ref={menuRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        onClick={async () => {
          // With an AI assignee and nothing running, the sparkle is the Run button; it then shows the run
          if (canRun) {
            try {
              await runMut.mutateAsync(undefined);
            } catch (err) {
              toast.error("Couldn't start the run", extractError(err));
              return;
            }
            if (!active) onClick();
            return;
          }
          onClick();
        }}
        aria-label={canRun ? `Run ${assignee?.name}` : 'AI runs'}
        title={canRun ? `Start a run with ${assignee?.name}` : 'AI runs'}
        data-testid="ticket-ai-tab"
        data-can-run={canRun ? 'true' : undefined}
        style={{
          minWidth: 32,
          padding: canRun ? '0 10px' : 0,
          gap: 5,
          fontSize: 12.5,
          fontWeight: 700,
          fontFamily: 'inherit',
          height: 32,
          borderRadius: '8px 0 0 8px',
          border: border(active),
          background: active ? '#F1F8F3' : '#fff',
          color: '#2E6F40',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
        }}
      >
        <SparkleIcon size={14} />
        {canRun && 'Run'}
      </button>
      <button
        type="button"
        onClick={() => setMenu((v) => !v)}
        aria-label="Run options"
        aria-haspopup="menu"
        aria-expanded={menu}
        title="Run options"
        data-testid="ticket-run-menu"
        style={{
          width: 20,
          height: 32,
          borderRadius: '0 8px 8px 0',
          border: border(menu),
          borderLeft: 'none',
          background: menu ? '#F1F8F3' : '#fff',
          color: '#5B6B60',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          padding: 0,
        }}
      >
        <ChevronIcon size={12} />
      </button>
      {run && ACTIVE_RUN_STATES.includes(run.state) && (
        <span
          className={live ? 'ai-pulse' : undefined}
          style={{
            position: 'absolute',
            top: -2,
            right: -2,
            width: 9,
            height: 9,
            borderRadius: '50%',
            background: run.state === 'needs_input' ? '#5B6F86' : '#2E6F40',
            border: '1.5px solid #fff',
          }}
        />
      )}
      {menu && (
        <div className="sc-menu ai-root" role="menu" data-testid="run-menu">
          {canRun && (
            <button
              type="button"
              role="menuitem"
              className="ai-mi"
              data-testid="menu-run-now"
              onClick={async () => {
                setMenu(false);
                try {
                  await runMut.mutateAsync(undefined);
                } catch (err) {
                  toast.error("Couldn't start the run", extractError(err));
                }
              }}
            >
              <PlayIcon size={14} /> Run now
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="ai-mi"
            data-testid="menu-schedule"
            onClick={() => {
              setMenu(false);
              openEditor({ ticketId: ticket.id, memberId: assignee?.id });
            }}
          >
            <CalendarIcon size={14} /> Schedule a run…
          </button>
          <div className="sc-menu-sep" />
          <button
            type="button"
            role="menuitem"
            className="ai-mi"
            data-testid="menu-view-schedules"
            style={{ color: '#5B6B60' }}
            onClick={() => {
              setMenu(false);
              viewForTicket(ticket.id);
            }}
          >
            <ListIcon size={14} /> View schedules for this ticket
            {count > 0 && (
              <span className="ai-tab-count" style={{ marginLeft: 'auto' }}>
                {count}
              </span>
            )}
          </button>
        </div>
      )}
    </span>
  );
}

/** Header chip "Running · 3m 12s" next to the ticket id. */
export function RunHeaderChip({ ticket }: { ticket: Ticket }) {
  const { runsByTicket, members } = useAiBoardState();
  const run = runsByTicket.get(ticket.id);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!run || !ACTIVE_RUN_STATES.includes(run.state)) return null;
  const ai = members.get(run.memberId);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      {ai && <AiAvatar provider={ai.provider} color={ai.color} glyph={ai.glyph} size={24} />}
      <RunStateChip
        state={run.paused ? 'paused' : run.state}
        suffix={run.state === 'running' ? <span> · {fmtElapsed(secondsSince(run.startedAt))}</span> : undefined}
      />
    </span>
  );
}

// ---------------------------------------------------------------------------
// The AI block at the top of ticket detail: run card, question, review gate, approvals
// ---------------------------------------------------------------------------

/** Run in progress, the AI's question, its summary in Review, failures and pending approvals for this ticket. */
export function TicketAiPanel({
  ticket,
  members,
  onOpenRun,
}: {
  ticket: Ticket;
  members: Member[];
  onOpenRun: () => void;
}) {
  const runs = useTicketRuns(ticket.id);
  const { projectId, members: aiMembers, runsByTicket, settings } = useAiBoardState();
  const approvals = useAiApprovals(projectId, 'pending');
  const [keepQueued, setKeepQueued] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const list = runs.data ?? [];
  const work = list.filter((r) => r.mode === 'work');
  // The holder (or the last run when nobody holds it); a second AI waiting behind it is shown apart
  const latest = work.find((r) => !r.behindRunId) ?? work[0];
  const next = work.find((r) => r.behindRunId && ACTIVE_RUN_STATES.includes(r.state));
  const ticketApprovals = (approvals.data ?? []).filter((a) => a.ticketId === ticket.id);
  const asks = list.filter((r) => r.mode === 'ask' && ACTIVE_RUN_STATES.includes(r.state));
  // Pause all AI: the strip opens the panel (design/screens/ai-paused.md, E2), the last run says why it ended
  const aiAssignee = ticket.assignee ? aiMembers.get(ticket.assignee) : undefined;
  const paused = !!settings?.pausedAll && !!aiAssignee && !['done', 'wont_do'].includes(ticket.status);
  const stoppedByPause =
    paused && latest?.state === 'cancelled' && (latest.endedReason ?? '').startsWith('Pause all AI');
  const heldQueue = [...runsByTicket.values()]
    .filter((r) => r.state === 'queued' && r.mode === 'work')
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
  const heldPosition = latest ? heldQueue.findIndex((r) => r.id === latest.id) + 1 : 0;
  if (!latest && !ticketApprovals.length && !asks.length && !paused) return null;
  const queuedMember = latest?.state === 'queued' ? aiMembers.get(latest.memberId) : undefined;
  const offline = queuedMember?.status.code === 'runner_missing' && !keepQueued;
  // Fixed above the scrolling ticket body: bottom padding and a rule keep the body from looking covered.
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
      data-testid="ticket-ai-panel"
    >
      {paused && settings && (
        <PausedStrip settings={settings} onResume={() => setResumeOpen(true)}>
          {latest?.state === 'queued' ? 'Its next run is held.' : 'Nothing new starts on this ticket.'}
        </PausedStrip>
      )}
      {stoppedByPause && latest && (
        <div
          className="ai-card"
          style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}
          data-testid="run-stopped-by-pause"
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 13 }}>
            {latest.memberName} · run #{latest.number}
            <span className="ai-chip" style={{ background: '#FDF0E6', color: PAUSE_COLOR, gap: 5 }}>
              <PauseGlyph size={11} color={PAUSE_COLOR} />
              Stopped by the pause
            </span>
          </span>
          <span className="ai-muted" style={{ fontSize: 12.5 }}>
            Cancelled at step {latest.stepCount ?? latest.steps?.length ?? 0}, {clockTime(latest.endedAt)}. Partial work
            in the folder is kept.
          </span>
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button type="button" className="ai-btn ai-btn-sm" onClick={onOpenRun}>
              Open run
            </button>
            <button type="button" className="ai-btn ai-btn-sm" disabled title="Available after resume">
              Run again
            </button>
            <span className="ai-muted" style={{ fontSize: 12 }}>
              Available after resume
            </span>
          </span>
        </div>
      )}
      {paused && latest?.state === 'queued' && heldPosition > 0 && (
        <span className="ai-muted" style={{ fontSize: 12.5 }} data-testid="run-held-position">
          Next run for this ticket is held. It starts after resume, in order: position {heldPosition} of{' '}
          {heldQueue.length}.
        </span>
      )}
      {offline && latest && <OfflineBanner run={latest} ticketId={ticket.id} onKeep={() => setKeepQueued(true)} />}
      {latest && (latest.state === 'running' || latest.state === 'starting' || latest.state === 'queued') && (
        <ActiveRunCard run={latest} onOpenRun={onOpenRun} />
      )}
      {latest?.waitingApproval && <WaitingApprovalCard run={latest} />}
      {next && <NextInLineCard run={next} holder={latest} />}
      {latest?.state === 'needs_input' && latest.question && <QuestionCard run={latest} />}
      {latest &&
        (latest.state === 'failed' || latest.state === 'timed_out') &&
        (budgetStop(latest) ? (
          <BudgetStopBox run={latest} />
        ) : (
          <FailedCard run={latest} ticket={ticket} onOpenRun={onOpenRun} />
        ))}
      {latest?.state === 'finished' && ['review', 'testing'].includes(ticket.status) && (
        <SummaryCard run={latest} ticket={ticket} onOpenRun={onOpenRun} />
      )}
      {asks.map((r) => (
        <div key={r.id} className="ai-notice ai-notice-info" style={{ alignItems: 'center' }}>
          <span className="ai-spin" />
          <span>
            <b>{r.memberName}</b> is {r.state === 'queued' ? 'about to answer' : 'thinking about'} “
            {r.instruction.slice(0, 90)}”…
          </span>
        </div>
      ))}
      {ticketApprovals.map((a) => (
        <ApprovalCard key={a.id} approval={a} />
      ))}
      {members.length < 0 && null}
      {resumeOpen && (
        <ResumeAllDialog
          projectId={projectId}
          members={[...aiMembers.values()].filter((m) => m.kind === 'ai')}
          onClose={() => setResumeOpen(false)}
        />
      )}
    </div>
  );
}

/** The assigned AI is offline: the ticket is queued and starts when the runner reconnects (H3). */
function OfflineBanner({ run, ticketId, onKeep }: { run: AiRun; ticketId: string; onKeep: () => void }) {
  const cancel = useAiMutation(() => aiApi.cancel(run.id, 'Assigned to someone else'));
  return (
    <div className="ai-notice ai-notice-warn" style={{ alignItems: 'flex-start' }} data-testid="offline-banner">
      <div style={{ flex: 1 }}>
        <b>{run.memberName} is offline</b>
        <div>
          The desktop app is closed. The ticket is queued and starts when the runner reconnects. Nothing is lost.
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button type="button" className="ai-btn ai-btn-sm" onClick={onKeep}>
            Keep queued
          </button>
          <button
            type="button"
            className="ai-btn ai-btn-sm"
            onClick={async () => {
              await cancel.mutateAsync(undefined);
              fireAiEvent(ASSIGN_AI_EVENT, ticketId, '');
            }}
          >
            Assign to someone else
          </button>
        </div>
      </div>
    </div>
  );
}

/** A second AI waits for the holder of the ticket: “Next”, and who it waits for (H1). */
function NextInLineCard({ run, holder }: { run: AiRun; holder?: AiRun }) {
  const { members } = useAiBoardState();
  const ai = members.get(run.memberId);
  return (
    <div
      className="ai-card"
      style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 10 }}
      data-testid="next-in-line"
    >
      {ai && <AiAvatar provider={ai.provider} color={ai.color} glyph={ai.glyph} size={24} />}
      <b style={{ fontSize: 13 }}>{run.memberName}</b>
      <span className="ai-muted" style={{ fontSize: 12.5 }}>
        waits for the hold{holder ? ` of ${holder.memberName}` : ''}; it starts when it is released
      </span>
      <span style={{ flex: 1 }} />
      <span className="ai-chip" style={{ background: '#F5F3FD', color: '#6D5DD3' }}>
        Next
      </span>
    </div>
  );
}

/** "Needs approval" (safety): the run's tool call waits for a person; the run goes on once someone decides. */
function WaitingApprovalCard({ run }: { run: AiRun }) {
  const board = useAiBoardState();
  const w = run.waitingApproval!;
  return (
    <div className="as-tile as-tile-slate" data-testid="run-waiting-approval">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="ai-chip" style={{ background: '#EEF1F5', color: '#5B6B7A' }}>
          ✋ Needs approval
        </span>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{w.summary}</span>
      </div>
      <div className="ai-hint">
        {run.memberName ?? 'The AI'} waits for a decision since{' '}
        {new Date(w.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Approved, the board applies
        it and the run goes on; denied, the AI is told why.
      </div>
      {board.openAiTab && (
        <div>
          <button
            type="button"
            className="ai-btn ai-btn-sm ai-btn-primary"
            onClick={() => board.openAiTab?.('approvals')}
          >
            Review in Inbox
          </button>
        </div>
      )}
    </div>
  );
}

function ActiveRunCard({ run, onOpenRun }: { run: AiRun; onOpenRun: () => void }) {
  const toast = useToast();
  useNow(1000, run.state !== 'queued');
  const pause = useAiMutation(() => aiApi.pauseRun(run.id));
  const resume = useAiMutation(() => aiApi.resumeRun(run.id));
  const startNow = useAiMutation(() => aiApi.startNow(run.id));
  const refresh = useAiMutation(() => aiApi.refreshContext(run.id));
  const last = run.steps[run.steps.length - 1];
  const fresh = run.contextNotes.filter((n) => !n.delivered);
  const act = async (fn: () => Promise<unknown>, failure: string) => {
    try {
      await fn();
    } catch (err) {
      toast.error(failure, extractError(err));
    }
  };
  const stepWords = run.stepEstimate
    ? `step ${run.steps.length} of ~${Math.max(run.stepEstimate, run.steps.length)}`
    : `step ${run.steps.length}`;
  return (
    <div>
      <div
        className="ai-card"
        style={{
          padding: '10px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          borderColor: '#BFDCC7',
          background: '#F1F8F3',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <RunStateChip state={run.paused ? 'paused' : run.state} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>
            Run #{run.number}{' '}
            {run.state === 'queued'
              ? 'queued'
              : run.state === 'starting'
                ? 'starting'
                : run.paused
                  ? 'paused'
                  : 'in progress'}{' '}
            · {run.memberName}
          </div>
          <div className="ai-muted" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {run.state === 'queued'
              ? run.behindTicketId && !run.behindRunId
                ? `Position #${run.queuePosition ?? 1} behind ${run.behindTicketId}`
                : (run.waitingReason ?? 'Starts in a few seconds')
              : run.state === 'starting'
                ? 'Starting… the CLI or the agent loop is starting up'
                : `Started ${hhmm(run.startedAt)} · ${fmtElapsed(secondsSince(run.startedAt))} · ${stepWords}${last ? ` · ${last.text}` : ''}`}
          </div>
        </div>
        {run.state === 'running' && (
          <button
            type="button"
            className="ai-btn ai-btn-sm"
            disabled={pause.isPending || resume.isPending}
            onClick={() =>
              act(
                () => (run.paused ? resume : pause).mutateAsync(undefined),
                run.paused ? "Couldn't resume" : "Couldn't pause",
              )
            }
            data-testid={run.paused ? 'card-resume' : 'card-pause'}
          >
            {run.paused ? '▷ Resume' : '⏸ Pause run'}
          </button>
        )}
        {run.state === 'queued' && !run.behindRunId && (
          <button
            type="button"
            className="ai-btn ai-btn-sm"
            disabled={startNow.isPending}
            onClick={() => act(() => startNow.mutateAsync(undefined), "Can't start it now")}
            data-testid="card-start-now"
          >
            ▷ Start now
          </button>
        )}
        <button type="button" className="ai-btn ai-btn-sm" onClick={onOpenRun}>
          Open run
        </button>
        {run.state === 'running' && !run.paused && <div className="ai-progress" />}
      </div>
      {run.state === 'running' && (
        <div
          className="ai-hint"
          style={{ marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}
          data-testid="working-note"
        >
          <span>
            {run.memberName} is working on this. Your edits are saved and sent to it at its next step; it will not
            overwrite what you type.
          </span>
          {fresh.length > 0 && (
            <button
              type="button"
              className="ai-link"
              disabled={refresh.isPending}
              onClick={() => act(() => refresh.mutateAsync(undefined), "Couldn't refresh")}
            >
              Refresh context now
            </button>
          )}
          {run.contextNotes.length > 0 && (
            <span style={{ color: '#B4571F' }}>
              {run.contextNotes[run.contextNotes.length - 1].by} edited{' '}
              {run.contextNotes[run.contextNotes.length - 1].what}.
              {run.contextNotes[run.contextNotes.length - 1].delivered
                ? ` Run #${run.number} refreshed its context.`
                : ''}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function FailedCard({ run, ticket, onOpenRun }: { run: AiRun; ticket: Ticket; onOpenRun: () => void }) {
  const retry = useAiMutation(() => aiApi.retry(run.id));
  const toast = useToast();
  const [undo, setUndo] = useState(false);
  const canUndo = run.statusChanges.length > 0 || run.files.length > 0;
  return (
    <div
      className="ai-card"
      style={{
        padding: '10px 14px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
        borderColor: '#F0C4B8',
        background: '#FBEEEA',
      }}
      data-testid="failed-card"
    >
      <RunStateChip state={run.state} />
      <div style={{ flex: 1, minWidth: 180 }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>
          Run #{run.number} · {run.memberName}
        </div>
        <div className="ai-muted">
          {run.endedReason}
          {run.files.length > 0 ? ` · ${run.files.length} file${run.files.length === 1 ? '' : 's'} changed so far` : ''}
        </div>
      </div>
      <button type="button" className="ai-btn ai-btn-sm" onClick={onOpenRun}>
        Open run
      </button>
      <button
        type="button"
        className="ai-btn ai-btn-sm ai-btn-primary"
        onClick={async () => {
          try {
            await retry.mutateAsync(undefined);
          } catch (err) {
            toast.error("Couldn't retry", extractError(err));
          }
        }}
      >
        Retry
      </button>
      <TakeOverButton ticketId={ticket.id} projectId={ticket.projectId} />
      {run.state === 'timed_out' && <RaiseLimitButton run={run} />}
      {canUndo && (
        <button type="button" className="ai-btn ai-btn-sm" onClick={() => setUndo(true)} data-testid="failed-undo">
          ↶ Undo changes
        </button>
      )}
      {undo && <UndoRunDialog run={run} onClose={() => setUndo(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Board card footer (A4)
// ---------------------------------------------------------------------------

/** The AI line on a board card: run, queued, needs input, failed, summary ready. */
export function CardAiFooter({ ticket }: { ticket: Ticket }) {
  const { runsByTicket, members, settings } = useAiBoardState();
  const run = runsByTicket.get(ticket.id);
  const assignee = ticket.assignee ? members.get(ticket.assignee) : undefined;
  const runMut = useAiMutation(() => aiApi.run(ticket.id));
  const retry = useAiMutation((id: string) => aiApi.retry(id));
  const toast = useToast();
  const live = run?.state === 'running' || run?.state === 'starting';
  useNow(1000, !!live);
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  // Pause all AI (ai-paused.md, E1): one chip in the banner's colour. A ticket that needs your answer keeps its
  // amber footer: a pause does not hide it.
  if (settings?.pausedAll && assignee && !['done', 'wont_do'].includes(ticket.status) && run?.state !== 'needs_input') {
    const stopped = run?.state === 'cancelled' && (run.endedReason ?? '').startsWith('Pause all AI');
    return (
      <div className="ai-card-footer" data-testid="card-ai-paused" title={pausedSummary(settings)}>
        <span className="ai-chip" style={{ background: '#FDF0E6', color: PAUSE_COLOR, gap: 5 }}>
          <PauseGlyph size={11} color={PAUSE_COLOR} />
          {run?.state === 'queued' && run.mode === 'work' ? 'Held until resume' : 'AI paused'}
        </span>
        {stopped && (
          <span className="ai-muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
            Run stopped {clockTime(run.endedAt)}
          </span>
        )}
      </div>
    );
  }
  if (run && live && run.waitingApproval)
    return (
      <div className="ai-card-footer ai-card-footer-slate" data-testid="card-ai-approval">
        <span style={{ fontWeight: 800 }}>✋</span>
        <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          Needs approval: {run.waitingApproval.summary}
        </span>
      </div>
    );
  if (run && live)
    return (
      <div
        className="ai-card-footer ai-card-footer-running"
        data-testid="card-ai-running"
        style={{ position: 'relative', overflow: 'hidden' }}
      >
        <RunStateChip state={run.paused ? 'paused' : run.state === 'starting' ? 'starting' : 'running'} />
        {run.state === 'starting' ? (
          <span className="ai-muted">Starting…</span>
        ) : (
          <span className="ai-mono" style={{ fontWeight: 600, color: '#2E6F40' }}>
            {fmtElapsed(secondsSince(run.startedAt))}
          </span>
        )}
        <span className="ai-muted" style={{ marginLeft: 'auto' }} data-testid="card-step-hint">
          {run.state === 'starting'
            ? ''
            : run.stepEstimate
              ? `step ${run.stepCount ?? run.steps?.length ?? 0} of ~${Math.max(run.stepEstimate, run.stepCount ?? 0)}`
              : `step ${run.stepCount ?? run.steps?.length ?? 0}`}
        </span>
        {run.state === 'running' && !run.paused && <div className="ai-progress" />}
      </div>
    );
  if (run?.state === 'queued' && run.mode === 'work')
    return (
      <div className="ai-card-footer">
        <RunStateChip state="queued" />
        <span className="ai-muted" style={{ marginLeft: 'auto' }} data-testid="card-queue-hint">
          {run.behindRunId
            ? `Next · waits for ${run.behindTicketId ?? 'the holder'}`
            : run.behindTicketId
              ? `#${run.queuePosition ?? 1} behind ${run.behindTicketId}`
              : run.waitingReason
                ? (run.queuePosition ? `#${run.queuePosition} · ` : '') + run.waitingReason.split('(')[0]
                : 'starting soon'}
        </span>
      </div>
    );
  if (run?.state === 'needs_input')
    return (
      <div className="ai-card-footer ai-card-footer-slate" data-testid="card-ai-question">
        <span style={{ fontWeight: 800 }}>⏸</span>
        <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          Asks {run.question?.to}: {run.question?.text}
        </span>
        {(run.question?.reminders?.length ?? 0) > 0 && (
          <span
            className="tw-dot"
            style={{ marginLeft: 'auto' }}
            title="Still waiting for an answer"
            data-testid="card-reminder-dot"
          />
        )}
      </div>
    );
  if (run && (run.state === 'failed' || run.state === 'timed_out') && run.mode === 'work')
    return (
      <div className="ai-card-footer ai-card-footer-failed" onClick={stop}>
        <RunStateChip state={run.state} />
        <span className="ai-muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {run.exitCode != null ? `Exit code ${run.exitCode}` : ''}
        </span>
        <button type="button" className="ai-link" style={{ marginLeft: 'auto' }} onClick={() => retry.mutate(run.id)}>
          Retry
        </button>
      </div>
    );
  if (run?.state === 'finished' && run.mode === 'work' && ticket.status === 'review') {
    const t = run.tests ?? run.report.tests;
    const green = !!t && t.failed === 0 && t.passed > 0;
    return (
      <div
        className="ai-card-footer ai-card-footer-running"
        style={{ color: '#2E6F40', fontWeight: 600 }}
        data-testid="card-summary-ready"
      >
        <SparkleIcon size={11} /> AI summary ready{green ? ' · tests passed' : ''}
      </div>
    );
  }
  if (
    ticket.status === 'done' &&
    ticket.completedBy &&
    members.has(ticket.assignee ?? '') &&
    ticket.completedBy === assignee?.name
  )
    return (
      <div className="ai-card-footer ai-card-footer-running" style={{ color: '#2E6F40', fontWeight: 600 }}>
        ✓ AI-completed
      </div>
    );
  if (assignee && assignee.connection !== 'inbox' && !['done', 'wont_do', 'review', 'testing'].includes(ticket.status))
    return (
      <div className="ai-card-footer" onClick={stop}>
        <span className="ai-muted">Assigned · not started</span>
        <button
          type="button"
          className="ai-link"
          style={{ marginLeft: 'auto' }}
          onClick={async () => {
            try {
              await runMut.mutateAsync(undefined);
            } catch (err) {
              toast.error("Couldn't start the run", extractError(err));
            }
          }}
        >
          Run ▷
        </button>
      </div>
    );
  return null;
}
