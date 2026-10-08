import type { IssueType, Member, Ticket } from '../types';
import { MemberAvatar } from './MemberAvatar';
import { TagPill } from './TagPill';
import { TicketTypeIcon, PriorityMark } from './icons';
import styles from './TicketCard.module.css';

const TYPE_LABELS: Record<IssueType, string> = {
  bug: 'Bug',
  feature: 'Feature',
  task: 'Task',
  chore: 'Chore',
};

function getDueDateDisplay(dueDate: string | null): { label: string; overdue: boolean } | null {
  if (!dueDate) return null;
  const due = new Date(dueDate);
  if (isNaN(due.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const overdue = due < today;
  const label = due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return { label, overdue };
}

interface TicketCardProps {
  ticket: Ticket;
  memberMap?: Map<string, Member>;
  isDragging?: boolean;
  className?: string;
  onClick?: () => void;
  subtaskStats?: { total: number; completed: number };
}

/**
 * Compact ticket card for the board.
 * @param props.memberMap - Members by id, used to render the assignee.
 * @param props.isDragging - Render the dragging style.
 * @param props.onClick - Called when the card is clicked.
 * @param props.subtaskStats - Sub-task totals shown on the card.
 */
export function TicketCard({ ticket, memberMap, isDragging, className, onClick, subtaskStats }: TicketCardProps) {
  const typeLabel = TYPE_LABELS[ticket.type] ?? 'Task';
  const due = getDueDateDisplay(ticket.dueDate);
  const assigneeMember = ticket.assignee && memberMap ? memberMap.get(ticket.assignee) : null;
  const isBlocked = (ticket.blockedBy ?? []).length > 0;
  const isDone = ticket.status === 'done';
  const completedAC = (ticket.acceptanceCriteria ?? []).filter((s) => s.done).length;
  const totalAC = (ticket.acceptanceCriteria ?? []).length;
  const hasSubtasks = subtaskStats && subtaskStats.total > 0;

  const cardClasses = [
    styles.card,
    isDragging ? styles.cardDragging : '',
    isBlocked ? styles.cardBlocked : '',
    isDone ? styles.cardDone : '',
    hasSubtasks ? styles.cardParent : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  const visibleTags = (ticket.tags ?? []).slice(0, 3);
  const overflowCount = (ticket.tags ?? []).length - visibleTags.length;

  return (
    <div className={cardClasses} onClick={onClick}>
      {/* Floating Blocked Badge */}
      {isBlocked && (
        <div className={styles.blockedBadge} title={`Blocked by ${ticket.blockedBy.join(', ')}`} aria-label="Blocked">
          <svg width="11" height="11" viewBox="0 0 14 14" fill="none">
            <rect x="3" y="6.5" width="8" height="6" rx="1.3" stroke="#C4432A" strokeWidth="1.4" />
            <path d="M4.6 6.5V4.8A2.4 2.4 0 0 1 9.4 4.8V6.5" stroke="#C4432A" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </div>
      )}

      <div className={styles.cardContent}>
        {/* Header: Type icon + label, and ID + drag dots */}
        <div className={styles.cardHeader}>
          <div className={styles.typeContainer}>
            <TicketTypeIcon type={ticket.type} size={15} />
            <span className={styles.typeLabel}>{typeLabel}</span>
          </div>

          <div className={styles.headerRight}>
            <span className={styles.cardId}>{ticket.id}</span>
            <span className={styles.dragHandle} aria-hidden="true">
              <svg width="10" height="14" viewBox="0 0 10 16" fill="#B7C4BC">
                <circle cx="2" cy="2" r="1.3" />
                <circle cx="8" cy="2" r="1.3" />
                <circle cx="2" cy="8" r="1.3" />
                <circle cx="8" cy="8" r="1.3" />
                <circle cx="2" cy="14" r="1.3" />
                <circle cx="8" cy="14" r="1.3" />
              </svg>
            </span>
          </div>
        </div>

        {/* Title: 2-line clamped */}
        <div className={styles.cardTitle}>{ticket.title}</div>

        {/* Parent chip & Tags row */}
        {(ticket.parentId || visibleTags.length > 0) && (
          <div className={styles.tagsRow}>
            {ticket.parentId && (
              <span className={styles.parentChip} title={`Sub-ticket of ${ticket.parentId}`}>
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 14 14"
                  fill="none"
                  stroke="#9AA8A0"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M3.5 2.5V8A2.5 2.5 0 0 0 6 10.5H9.5" />
                  <path d="M7.5 8.5L10 11L7.5 13.5" />
                </svg>
                {ticket.parentId}
              </span>
            )}
            {visibleTags.map((tag, idx) => (
              <TagPill key={`${tag}-${idx}`} tag={tag} size="small" />
            ))}
            {overflowCount > 0 && <span className={styles.tagOverflow}>+{overflowCount}</span>}
          </div>
        )}

        {/* Sub-tasks progress bar for parent tickets */}
        {hasSubtasks && subtaskStats && (
          <div className={styles.subtaskProgressBar}>
            <div className={styles.subtaskTrack}>
              <div
                className={styles.subtaskFill}
                style={{
                  width: `${Math.round((subtaskStats.completed / subtaskStats.total) * 100)}%`,
                }}
              />
            </div>
            <span className={styles.subtaskText}>
              {subtaskStats.completed}/{subtaskStats.total} sub-tasks
            </span>
          </div>
        )}

        {/* Footer: Assignee, Priority, Estimate, AC count, Due date */}
        <div className={styles.cardFooter}>
          {assigneeMember ? (
            <MemberAvatar member={assigneeMember} size={20} />
          ) : (
            <div
              style={{
                width: 20,
                height: 20,
                borderRadius: '50%',
                background: '#EEF1EE',
                color: '#9AA8A0',
                fontSize: 10,
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
              title="Unassigned"
            >
              –
            </div>
          )}

          <PriorityMark priority={ticket.priority} width={15} height={14} />

          <span className={styles.footerSpacer} />

          {ticket.estimate !== null && ticket.estimate !== undefined && (
            <span className={styles.estimate}>{ticket.estimate} pt</span>
          )}

          {totalAC > 0 && (
            <span className={completedAC === totalAC ? styles.subtasksDone : styles.subtasksProgress}>
              {completedAC}/{totalAC}
            </span>
          )}

          {due && (
            <span className={due.overdue ? styles.dueDateOverdue : styles.dueDate}>
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke={due.overdue ? '#C4432A' : '#5B6B60'}
                strokeWidth={due.overdue ? 2.2 : 2}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="3.5" y="5.5" width="17" height="15" rx="2.5" />
                <path d="M3.5 10H20.5" />
                <path d="M8 3V6.5" />
                <path d="M16 3V6.5" />
              </svg>
              Due {due.label}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
