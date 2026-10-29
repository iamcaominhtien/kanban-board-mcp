import { useTicketRuns } from '../../api/ai';
import type { Ticket } from '../../types';
import { ACTIVE_RUN_STATES, hhmm, useAiBoardState } from './aiUi';
import './ticketWork.css';

/** “moved by Claude Code · Backend” under the Status of a ticket whose last status change an AI made. */
export function StatusMovedBy({ ticket }: { ticket: Ticket }) {
  const log = ticket.activityLog ?? [];
  const last = [...log].reverse().find((e) => e.field === 'status');
  if (!last?.ai || !last.actor) return null;
  return (
    <div className="ai-muted" style={{ marginTop: 3, fontSize: 12 }} data-testid="status-moved-by">
      moved by {last.actor}
    </div>
  );
}

/**
 * One agent holds a ticket at a time: “Held since 12:41” while an AI run holds it, “Held by …” when the holder is
 * not the assignee, and who waits next in line (design H1).
 */
export function HoldChips({ ticket }: { ticket: Ticket }) {
  const { members } = useAiBoardState();
  const runs = useTicketRuns(ticket.id).data ?? [];
  const work = runs.filter((r) => r.mode === 'work' && ACTIVE_RUN_STATES.includes(r.state));
  const holder = work.find((r) => !r.behindRunId);
  const next = work.find((r) => r.behindRunId);
  if (!holder) return null;
  const holderName = members.get(holder.memberId)?.name ?? holder.memberName;
  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8, alignItems: 'flex-start' }}
      data-testid="hold-chips"
    >
      <span className="tw-hold">🔒 Held since {hhmm(holder.startedAt ?? holder.queuedAt)}</span>
      {holder.memberId !== ticket.assignee && (
        <span className="tw-hold" data-testid="held-by">
          Held by {holderName}
        </span>
      )}
      {next && (
        <span className="ai-muted" style={{ fontSize: 12 }} data-testid="next-in-line-chip">
          Next: <b style={{ color: '#6D5DD3' }}>{next.memberName}</b> waits for the hold
        </span>
      )}
    </div>
  );
}

/** AI-completed: an AI member moved the ticket to Done (its permission allowed it), so it is never mistaken for a
 * person's approval (design F4). */
export function AiCompletedBadge({ ticket }: { ticket: Ticket }) {
  const { members } = useAiBoardState();
  if (ticket.status !== 'done' || !ticket.completedBy) return null;
  const done = [...(ticket.activityLog ?? [])].reverse().find((e) => e.field === 'status' && e.to === 'done');
  const byAi = done?.ai || [...members.values()].some((m) => m.name === ticket.completedBy);
  if (!byAi) return null;
  return (
    <span
      className="ai-chip"
      style={{ background: '#E5F2E9', color: '#2E6F40' }}
      data-testid="ai-completed-badge"
      title={`Moved to Done by ${ticket.completedBy}`}
    >
      ✓ AI-completed
    </span>
  );
}
