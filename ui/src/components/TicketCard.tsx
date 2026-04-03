import type { IssueType, Priority, Ticket } from '../types';
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
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const overdue = due < today;
  const label = due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return { label, overdue };
}

interface TicketCardProps {
  ticket: Ticket;
}

export function TicketCard({ ticket }: TicketCardProps) {
  const tc = TYPE_CONFIG[ticket.type];
  const due = getDueDateDisplay(ticket.dueDate);
  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <span className={styles.cardId}>{ticket.id}</span>
        <div className={styles.cardHeaderBadges}>
          {ticket.parentId && (
            <span className={styles.parentBadge}>⬆ {ticket.parentId}</span>
          )}
          <span
            className={styles.typeBadge}
            style={{ backgroundColor: tc.bg, color: tc.color }}
          >
            {tc.icon} {tc.label}
          </span>
        </div>
      </div>
      <span className={styles.cardTitle}>{ticket.title}</span>
      <div className={styles.cardFooter}>
        <span
          className={styles.priorityBadge}
          style={{ backgroundColor: PRIORITY_COLORS[ticket.priority] }}
        >
          {ticket.priority}
        </span>
        {ticket.estimate !== null && ticket.estimate !== undefined && (
          <span className={styles.estimateBadge}>SP: {ticket.estimate}</span>
        )}
        {ticket.tags.map((tag, i) => (
          <span key={`${tag}-${i}`} className={styles.tag}>
            {tag}
          </span>
        ))}
      </div>
      {due && (
        <span className={due.overdue ? styles.dueDateOverdue : styles.dueDate}>
          {due.overdue ? '⚠️' : '📅'} {due.label}
        </span>
      )}
      {(ticket.acceptanceCriteria ?? []).length > 0 && (() => {
        const completed = (ticket.acceptanceCriteria ?? []).filter((s) => s.completed).length;
        const total = (ticket.acceptanceCriteria ?? []).length;
        const allDone = completed === total;
        return (
          <span className={allDone ? styles.subTasksDone : styles.subTasksProgress}>
            {allDone ? '✓' : '◻'} {completed}/{total}
          </span>
        );
      })()}
    </div>
  );
}
