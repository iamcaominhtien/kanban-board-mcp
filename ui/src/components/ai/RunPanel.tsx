import { useEffect, useRef, useState } from 'react';
import { aiApi, isActive, useAiMutation, useTicketRuns } from '../../api/ai';
import { extractError } from '../../api/extractError';
import type { Ticket } from '../../types';
import type { AiRun } from '../../types/ai';
import { useToast } from '../Toast';
import { useScheduleList } from '../../api/schedules';
import { useSchedules } from '../schedules/SchedulesContext';
import { CalendarIcon, ChevronIcon, ListIcon, PlayIcon } from '../schedules/schedulesUi';
import { ResumeAllDialog } from './AiKillSwitch';
import { PAUSE_COLOR, PauseGlyph, PausedStrip, clockTime, pausedSummary } from './pausedUi';
import { AccountNote } from './accounts/AccountBanner';
import { SignInAgainButton } from './accounts/SignedOutBanners';
import './accounts/accountsMember.css';
import { RestartNotice, RunResourcesStrip } from './RunResources';
import { AiAvatar, RunStateChip, SparkleIcon, fmtElapsed, hhmm, secondsSince, useAiBoardState, useNow } from './aiUi';
import { LineIcon } from '../ui/LineIcon';

// The run view, steps, history and the AI tab live in RunView.tsx
export { RunView, RunHistory, TicketRunsTab } from './RunView';
export { RunTree as RunSteps } from './run/RunTree';
export { QuestionCard } from './QuestionCard';

/**
 * Sparkle Run button for the ticket header, with a pulsing dot while a run is active. Its menu starts a run now,
 * schedules one, or shows the ticket's schedules.
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
  const canRun = !!assignee && !(run && isActive(run.state));
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
          // With a team assigned and nothing running, the sparkle is the Run button; it then shows the run
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
          minWidth: 30,
          padding: canRun ? '0 10px' : 0,
          gap: 5,
          fontSize: 12.5,
          fontWeight: 700,
          fontFamily: 'inherit',
          height: 30,
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
          height: 30,
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
      {run && isActive(run.state) && run.state !== 'queued' && (
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
  useNow(1000, !!run && isActive(run.state));
  if (!run || !isActive(run.state)) return null;
  const ai = members.get(run.memberId);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      {ai && <AiAvatar color={ai.color} size={24} />}
      <RunStateChip
        state={run.state}
        suffix={run.state === 'running' ? <span> · {fmtElapsed(secondsSince(run.startedAt))}</span> : undefined}
      />
    </span>
  );
}

// ---------------------------------------------------------------------------
// The AI block at the top of ticket detail: run card, question, failures
// ---------------------------------------------------------------------------

/** The newest run of the ticket, the lead's question, the pause for this ticket and the sign-in the team needs. */
/** The run now going on a ticket: who, since when, which step, and a bar moving while it works (as on main). */
function ActiveRunCard({ run, who, onOpenRun }: { run: AiRun; who: string; onOpenRun: () => void }) {
  useNow(1000, run.state !== 'queued');
  const queued = run.state === 'queued';
  const state = run.state === 'starting' ? 'starting' : queued ? 'queued' : 'in progress';
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
        data-testid="active-run-card"
      >
        <RunStateChip state={run.state} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>
            Run #{run.number} {state} · {who}
          </div>
          <div
            className="ai-muted"
            data-testid={queued ? 'why-waiting' : undefined}
            style={{
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              color: queued ? '#B4571F' : undefined,
            }}
          >
            {queued
              ? (run.waitingReason ?? 'Starts in a few seconds')
              : run.state === 'starting'
                ? 'Starting… the CLI is starting up'
                : `Started ${hhmm(run.startedAt)} · ${fmtElapsed(secondsSince(run.startedAt))} · step ${run.stepsCount}`}
          </div>
        </div>
        <button type="button" className="ai-btn ai-btn-sm" onClick={onOpenRun}>
          Open run
        </button>
        {run.state === 'running' && <div className="ai-progress" />}
      </div>
      <RestartNotice run={run} />
      {run.state === 'running' && <RunResourcesStrip run={run} />}
    </div>
  );
}

/** The strips of the ticket's AI tab: AI paused for the project ("Nothing new starts on this ticket.") and the account signed out. */
export function TicketAiStrips({ ticket }: { ticket: Ticket }) {
  const runs = useTicketRuns(ticket.id);
  const { members: aiMembers, settings } = useAiBoardState();
  const [resumeOpen, setResumeOpen] = useState(false);
  const latest = (runs.data ?? [])[0];
  const team = ticket.assignee ? aiMembers.get(ticket.assignee) : undefined;
  const paused = !!settings?.pausedAll && !!team && !['done', 'wont_do'].includes(ticket.status);
  const runTeam = latest ? aiMembers.get(latest.memberId) : undefined;
  const accountOut = !!latest && runTeam?.accountRef?.status === 'needs_sign_in';
  if (!paused && !accountOut) return null;
  return (
    <>
      {paused && settings && (
        <PausedStrip settings={settings} onResume={() => setResumeOpen(true)}>
          {latest?.state === 'queued' ? 'Its next run is held.' : 'Nothing new starts on this ticket.'}
        </PausedStrip>
      )}
      {latest && accountOut && runTeam?.accountRef && (
        <AccountNote
          tone="error"
          title={`${runTeam.accountRef.name} is signed out`}
          testId="account-signed-out"
          actions={<SignInAgainButton member={runTeam} primary />}
        >
          {runTeam.name} cannot work until the account is signed in again.
        </AccountNote>
      )}
      {resumeOpen && settings && (
        <ResumeAllDialog projectId={settings.projectId} onClose={() => setResumeOpen(false)} />
      )}
    </>
  );
}

/** What a ticket's AI tab says before anything else: AI paused for the project, or the account signed out (H2, H3). */
export function TicketAiPanel({ ticket, onOpenRun }: { ticket: Ticket; onOpenRun: () => void }) {
  const runs = useTicketRuns(ticket.id);
  const { members: aiMembers } = useAiBoardState();
  const latest = (runs.data ?? [])[0];
  const runTeam = latest ? aiMembers.get(latest.memberId) : undefined;
  const active = latest && ['running', 'starting', 'queued'].includes(latest.state) ? latest : undefined;
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
      <TicketAiStrips ticket={ticket} />
      {active && <ActiveRunCard run={active} who={runTeam?.name ?? 'The AI'} onOpenRun={onOpenRun} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Board card footer
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

  // Pause all AI: one chip in the banner's colour. A ticket that needs your answer keeps its footer.
  if (settings?.pausedAll && assignee && !['done', 'wont_do'].includes(ticket.status) && run?.state !== 'needs_input') {
    return (
      <div className="ai-card-footer" data-testid="card-ai-paused" title={pausedSummary(settings)}>
        <span className="ai-chip" style={{ background: '#FDF0E6', color: PAUSE_COLOR, gap: 5 }}>
          <PauseGlyph size={11} color={PAUSE_COLOR} />
          {run?.state === 'queued' ? 'Held until resume' : 'AI paused'}
        </span>
        {run?.state === 'cancelled' && run.endedAt && (
          <span className="ai-muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
            Run stopped {clockTime(run.endedAt)}
          </span>
        )}
      </div>
    );
  }
  if (run && live)
    return (
      <div
        className="ai-card-footer ai-card-footer-running"
        data-testid="card-ai-running"
        style={{ position: 'relative', overflow: 'hidden' }}
      >
        <RunStateChip state={run.state === 'starting' ? 'starting' : 'running'} />
        {run.state === 'starting' ? (
          <span className="ai-muted">Starting…</span>
        ) : (
          <span className="ai-mono" style={{ fontWeight: 600, color: '#2E6F40' }}>
            {fmtElapsed(secondsSince(run.startedAt))}
          </span>
        )}
        <span className="ai-muted" style={{ marginLeft: 'auto' }} data-testid="card-step-hint">
          {run.state === 'starting' ? '' : `step ${run.stepsCount}`}
        </span>
        {run.state === 'running' && <div className="ai-progress" />}
      </div>
    );
  if (run?.state === 'queued')
    return (
      <div className="ai-card-footer">
        <RunStateChip state="queued" />
        <span className="ai-muted" style={{ marginLeft: 'auto' }} data-testid="card-queue-hint">
          starting soon
        </span>
      </div>
    );
  if (run?.state === 'needs_input')
    return (
      <div className="ai-card-footer ai-card-footer-slate" data-testid="card-ai-question">
        <span style={{ fontWeight: 800 }}>
          <LineIcon name="pause" size={14} />
        </span>
        <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          Asks{run.question?.to ? ` ${run.question.to}` : ''}: {run.question?.text}
        </span>
      </div>
    );
  if (run && (run.state === 'failed' || run.state === 'timed_out'))
    return (
      <div className="ai-card-footer ai-card-footer-failed" onClick={stop}>
        <RunStateChip state={run.state} />
        <button
          type="button"
          className="ai-link"
          style={{ marginLeft: 'auto' }}
          onClick={() => retry.mutate(run.runId)}
        >
          Retry
        </button>
      </div>
    );
  if (run?.state === 'finished' && ticket.status === 'review')
    return (
      <div
        className="ai-card-footer ai-card-footer-running"
        style={{ color: '#2E6F40', fontWeight: 600 }}
        data-testid="card-summary-ready"
      >
        <SparkleIcon size={11} /> Report ready
      </div>
    );
  if (
    ticket.status === 'done' &&
    ticket.completedBy &&
    members.has(ticket.assignee ?? '') &&
    ticket.completedBy === assignee?.name
  )
    return (
      <div className="ai-card-footer ai-card-footer-running" style={{ color: '#2E6F40', fontWeight: 600 }}>
        <LineIcon name="check" size={12} /> AI-completed
      </div>
    );
  // A run that ended (and the ticket still open) is not "not started": say how it ended, and offer another run.
  if (
    run &&
    (run.state === 'finished' || run.state === 'cancelled') &&
    assignee &&
    !['done', 'wont_do', 'review', 'testing'].includes(ticket.status)
  )
    return (
      <div className="ai-card-footer" onClick={stop} data-testid="card-ai-ended">
        <RunStateChip state={run.state} />
        {run.endedAt && <span className="ai-muted">{clockTime(run.endedAt)}</span>}
        <button
          type="button"
          className="ai-link"
          style={{ marginLeft: 'auto' }}
          onClick={() => retry.mutate(run.runId)}
        >
          Run again
        </button>
      </div>
    );
  if (assignee && !['done', 'wont_do', 'review', 'testing'].includes(ticket.status))
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
          Run <LineIcon name="play" size={12} />
        </button>
      </div>
    );
  return null;
}
