import { extractError } from '../../api/extractError';
import { scheduleApi, useScheduleCards, useScheduleList, useScheduleMutation } from '../../api/schedules';
import type { Ticket } from '../../types';
import type { Schedule, ScheduleRun } from '../../types/schedules';
import { AiAvatar, useAiBoardState } from '../ai/aiUi';
import { useToast } from '../Toast';
import { useSchedules } from './SchedulesContext';
import {
  CalendarIcon,
  CheckChips,
  ClockIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  ReviewIcon,
  ScheduleStateChip,
  WarnIcon,
  fmtNext,
  fmtSlot,
} from './schedulesUi';

/** "passed review", "failed"… the way the Last run line says how a slot ended. */
function endedAs(run: ScheduleRun, reviewed: boolean): string {
  switch (run.state) {
    case 'passed':
      return reviewed ? 'passed review' : 'finished';
    case 'partly':
      return 'partly done';
    case 'failed':
      return 'failed';
    case 'skipped':
      return 'was skipped';
    case 'cancelled':
      return 'was cancelled';
    case 'waiting':
      return 'is waiting for the runner';
    case 'ask':
      return 'is waiting for your answer';
    default:
      return 'is in progress';
  }
}

function ScheduleBlock({ s }: { s: Schedule }) {
  const toast = useToast();
  const { openEditor, openDetail } = useSchedules();
  const { members } = useAiBoardState();
  const ai = members.get(s.memberId);
  const run = useScheduleMutation(() => scheduleApi.runNow(s.id));
  const toggle = useScheduleMutation(() => (s.state === 'active' ? scheduleApi.pause(s.id) : scheduleApi.resume(s.id)));
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast.success(ok);
    } catch (err) {
      toast.error("That didn't work", extractError(err));
    }
  };
  const last = s.lastRun;
  return (
    <div className="sc-block" data-testid="ticket-schedule" data-schedule={s.id}>
      <div className="sc-inline" style={{ gap: 10 }}>
        <span style={{ color: '#2E6F40', display: 'flex' }}>
          <CalendarIcon size={16} />
        </span>
        <b style={{ fontSize: 14 }}>Schedule</b>
        <ScheduleStateChip state={s.state} />
        <span className="sc-grow" />
        <button
          type="button"
          className="ai-btn ai-btn-sm"
          onClick={() => void act(() => run.mutateAsync(undefined), 'Run started')}
          disabled={run.isPending || s.state === 'ended'}
          data-testid="block-run-now"
        >
          <PlayIcon size={12} /> Run now
        </button>
        {s.state !== 'ended' && (
          <button
            type="button"
            className="ai-btn ai-btn-sm"
            onClick={() => void act(() => toggle.mutateAsync(undefined))}
            disabled={toggle.isPending}
            data-testid="block-toggle"
          >
            {s.state === 'active' ? <PauseIcon size={12} /> : <PlayIcon size={12} />}
            {s.state === 'active' ? 'Pause' : 'Resume'}
          </button>
        )}
        <button
          type="button"
          className="ai-btn ai-btn-sm"
          onClick={() => openEditor({ scheduleId: s.id })}
          data-testid="block-edit"
        >
          <PencilIcon size={12} /> Edit
        </button>
      </div>
      <div className="sc-block-line">
        <span>{s.when}</span>
        {s.kind === 'repeat' && s.state === 'active' && s.nextRunAt && (
          <>
            <span className="ai-muted">·</span>
            <span>
              next <b>{fmtNext(s.nextRunAt)}</b>
            </span>
          </>
        )}
        {s.kind === 'once' && s.state === 'active' && s.nextIn && <span className="ai-muted">· {s.nextIn}</span>}
        <span className="ai-muted">·</span>
        <span className="sc-inline" style={{ gap: 6 }}>
          {ai && <AiAvatar provider={ai.provider} size={20} />}
          <b>{s.memberName}</b>
        </span>
      </div>
      {s.state === 'paused' && (
        <div className="sc-risk" style={{ marginBottom: 6 }}>
          <WarnIcon size={12} />{' '}
          {s.failuresInRow >= 3
            ? `Paused after ${s.failuresInRow} failed runs. Fix the cause, then resume.`
            : (s.pausedReason ?? 'Paused')}
        </div>
      )}
      <div className="sc-chips">
        <CheckChips schedule={s} aiLabel />
        {s.review.on && s.review.reviewerName && (
          <span className="sc-chip">
            <ReviewIcon size={12} />
            {s.review.reviewerName}
          </span>
        )}
      </div>
      <div className="ai-hint" style={{ marginTop: 8 }} data-testid="block-last">
        {last ? (
          <>
            Last run: <b style={{ color: '#1E2A22' }}>{fmtSlot(last.slotAt)}</b> {endedAs(last, s.review.on)}.{' '}
          </>
        ) : (
          <>Not run yet. </>
        )}
        <button type="button" className="ai-link" onClick={() => openDetail(s.id)} data-testid="block-all-runs">
          All runs
        </button>
      </div>
    </div>
  );
}

/** The Schedule block on a ticket, below the header (E1): state, quick actions, what it checks and the last run. */
export function ScheduleTicketBlock({ ticket }: { ticket: Ticket }) {
  const q = useScheduleList(ticket.projectId, ticket.id);
  const { viewForTicket } = useSchedules();
  const items = (q.data?.items ?? []).filter((s) => s.state !== 'ended' || s.lastRun);
  if (!items.length) return null;
  return (
    <div className="ai-root sc-blocks">
      {items.slice(0, 2).map((s) => (
        <ScheduleBlock key={s.id} s={s} />
      ))}
      {items.length > 2 && (
        <button type="button" className="ai-link" onClick={() => viewForTicket(ticket.id)}>
          View all {items.length} schedules for this ticket
        </button>
      )}
    </div>
  );
}

/** The small chip in a board card's footer (E2): "Tue 02:00", "Starts in 12 min", "Missed, waiting for runner". */
export function ScheduleCardChip({ ticket }: { ticket: Ticket }) {
  const cards = useScheduleCards(ticket.projectId);
  const { openDetail } = useSchedules();
  const card = cards.data?.get(ticket.id);
  if (!card) return null;
  const tone = card.state === 'missed' ? 'sc-cc-warn' : card.state === 'paused' ? 'sc-cc-grey' : 'sc-cc-slate';
  return (
    <div className="ai-root sc-card-chip-wrap">
      <button
        type="button"
        className={`sc-card-chip ${tone}`}
        onClick={(e) => {
          e.stopPropagation();
          openDetail(card.scheduleId);
        }}
        onPointerDown={(e) => e.stopPropagation()}
        title="Open this schedule"
        data-testid="card-schedule"
        data-state={card.state}
      >
        {card.state === 'paused' ? <PauseIcon size={11} /> : <ClockIcon size={11} />}
        {card.label}
      </button>
    </div>
  );
}
