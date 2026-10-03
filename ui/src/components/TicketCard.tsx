import type { IssueType, Member, Ticket } from '../types';
import { MemberAvatar } from './MemberAvatar';
import {
  TicketTypeIcon,
  PriorityMark,
  DueDateIcon,
  OverdueIcon,
  BlockedIcon,
  DragHandleIcon,
} from './icons';
import styles from './TicketCard.module.css';

const TYPE_CONFIG: Record<IssueType, { label: string; bg: string; color: string }> = {
  bug:     { label: 'Bug',     bg: '#FBE7E4', color: '#C4432A' },
  feature: { label: 'Feature', bg: '#EDE9F9', color: '#6D5DD3' },
  task:    { label: 'Task',    bg: '#E1EEFB', color: '#2F6FB0' },
  chore:   { label: 'Chore',   bg: '#EEF1EE', color: '#5B6B60' },
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
}

export function TicketCard({ ticket, memberMap }: TicketCardProps) {
  const tc = TYPE_CONFIG[ticket.type] ?? TYPE_CONFIG.task;
  const due = getDueDateDisplay(ticket.dueDate);
  const assigneeMember = ticket.assignee && memberMap ? memberMap.get(ticket.assignee) : null;
  const isBlocked = (ticket.blockedBy ?? []).length > 0;
  const completedAC = (ticket.acceptanceCriteria ?? []).filter((s) => s.done).length;
  const totalAC = (ticket.acceptanceCriteria ?? []).length;

  return (
    <div className={styles.card} style={{ borderLeftColor: tc.color }}>
      {/* Header: ID + assignee avatar + drag handle */}
      <div className={styles.cardHeader}>
        <span className={styles.cardId}>{ticket.id}</span>
        <div className={styles.cardHeaderRight}>
          {assigneeMember && <MemberAvatar member={assigneeMember} size={18} />}
          <span className={styles.dragHandle} aria-hidden="true">
            <DragHandleIcon size={14} fill="currentColor" />
          </span>
        </div>
      </div>

      {/* Badges row: type + blocked + parent */}
      <div className={styles.badgeRow}>
        <span className={styles.typeBadge} style={{ backgroundColor: tc.bg, color: tc.color, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <TicketTypeIcon type={ticket.type} size={13} /> {tc.label}
        </span>
        {isBlocked && (
          <span className={styles.blockedBadge} title="Blocked" style={{ display: 'inline-flex', alignItems: 'center' }}>
            <BlockedIcon size={13} />
          </span>
        )}
        {ticket.parentId && <span className={styles.parentBadge}>⬆ sub</span>}
      </div>

      {/* Title */}
      <span className={styles.cardTitle}>{ticket.title}</span>

      {/* Footer: priority + tags + metadata */}
      <div className={styles.cardFooter}>
        <PriorityMark priority={ticket.priority} width={16} height={14} />
        {ticket.tags.slice(0, 2).map((tag, i) => (
          <span key={`${tag}-${i}`} className={styles.tag}>{tag}</span>
        ))}
        {ticket.tags.length > 2 && (
          <span className={styles.tag}>+{ticket.tags.length - 2}</span>
        )}
        <span className={styles.footerSpacer} />
        {ticket.estimate !== null && ticket.estimate !== undefined && (
          <span className={styles.estimateBadge}>{ticket.estimate}sp</span>
        )}
        {totalAC > 0 && (
          <span className={completedAC === totalAC ? styles.subTasksDone : styles.subTasksProgress}>
            {completedAC}/{totalAC}
          </span>
        )}
        {due && (
          <span className={due.overdue ? styles.dueDateOverdue : styles.dueDate} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {due.overdue ? <OverdueIcon size={12} /> : <DueDateIcon size={12} />} {due.label}
          </span>
        )}
      </div>
    </div>
  );
}
