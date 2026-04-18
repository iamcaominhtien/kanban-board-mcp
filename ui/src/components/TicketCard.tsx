import type { IssueType, Member, Priority, Ticket } from '../types';
import { MemberAvatar } from './MemberAvatar';
import styles from './TicketCard.module.css';

const PRIORITY_COLORS: Record<Priority, string> = {
  critical: '#DC2626',
  high:     '#E8441A',
  medium:   '#F5C518',
  low:      '#9CA3AF',
};

const TYPE_CONFIG: Record<IssueType, { label: string; icon: string; bg: string; color: string }> = {
  bug:     { label: 'Bug',     icon: '🐛', bg: '#FEE2E2', color: '#DC2626' },
  feature: { label: 'Feature', icon: '✨', bg: '#EDE9FE', color: '#7C3AED' },
  task:    { label: 'Task',    icon: '📋', bg: '#DBEAFE', color: '#2563EB' },
  chore:   { label: 'Chore',   icon: '🔧', bg: '#F3F4F6', color: '#6B7280' },
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
  const tc = TYPE_CONFIG[ticket.type];
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
          <span className={styles.dragHandle} aria-hidden="true">⠿</span>
        </div>
      </div>

      {/* Badges row: type + blocked + parent */}
      <div className={styles.badgeRow}>
        <span className={styles.typeBadge} style={{ backgroundColor: tc.bg, color: tc.color }}>
          {tc.icon} {tc.label}
        </span>
        {isBlocked && <span className={styles.blockedBadge} title="Blocked">🔒</span>}
        {ticket.parentId && <span className={styles.parentBadge}>⬆ sub</span>}
      </div>

      {/* Title */}
      <span className={styles.cardTitle}>{ticket.title}</span>

      {/* Footer: priority dot + tags + metadata */}
      <div className={styles.cardFooter}>
        <span
          className={styles.priorityDot}
          style={{ backgroundColor: PRIORITY_COLORS[ticket.priority] }}
          title={ticket.priority}
        />
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
          <span className={due.overdue ? styles.dueDateOverdue : styles.dueDate}>
            {due.overdue ? '⚠' : '📅'} {due.label}
          </span>
        )}
      </div>
    </div>
  );
}
