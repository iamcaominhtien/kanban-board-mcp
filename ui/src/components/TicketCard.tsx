import type { IssueType, Member, Priority, Ticket } from '../types';
import { MemberAvatar } from './MemberAvatar';
import styles from './TicketCard.module.css';

const TYPE_CONFIG: Record<IssueType, { label: string; color: string }> = {
  bug:     { label: 'Bug',     color: 'var(--color-danger)' },
  feature: { label: 'Feature', color: 'var(--color-purple)' },
  task:    { label: 'Task',    color: 'var(--color-blue)' },
  chore:   { label: 'Chore',   color: 'var(--color-text-secondary)' },
};

// Small fixed palette used to deterministically color tag pills (hash by tag string),
// matching the palette used in TicketModal.tsx.
const TAG_PALETTE = [
  'var(--color-blue)',
  'var(--color-purple)',
  'var(--color-primary)',
  'var(--color-orange)',
  'var(--color-danger)',
  'var(--color-teal)',
];

function tagColor(tag: string): string {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = (hash + tag.charCodeAt(i)) % TAG_PALETTE.length;
  return TAG_PALETTE[hash];
}

function tagChipStyle(tag: string): { backgroundColor: string; color: string } {
  const color = tagColor(tag);
  return { backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`, color };
}

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

interface TypeIconProps {
  type: IssueType;
  color: string;
}

function TypeIcon({ type, color }: TypeIconProps) {
  switch (type) {
    case 'task':
      return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
          <rect x="3" y="3" width="18" height="18" rx="5" stroke={color} strokeWidth="2.2" />
          <path d="M7.5 12.3L10.3 15L16.5 8.2" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'bug':
      return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round">
          <ellipse cx="12" cy="14" rx="5" ry="6.5" />
          <circle cx="12" cy="6" r="2.6" />
          <path d="M7 11H4" />
          <path d="M7 16H4" />
          <path d="M17 11H20" />
          <path d="M17 16H20" />
        </svg>
      );
    case 'feature':
      return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3.5A6 6 0 0 0 8.5 14.3C9.3 15 9.8 15.8 9.8 16.8V17.5H14.2V16.8C14.2 15.8 14.7 15 15.5 14.3A6 6 0 0 0 12 3.5Z" />
          <path d="M10 20.5H14" />
        </svg>
      );
    case 'chore':
      return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round">
          <rect x="4" y="6" width="4" height="4" rx="1" />
          <path d="M10.5 8H20" />
          <rect x="4" y="14" width="4" height="4" rx="1" />
          <path d="M10.5 16H20" />
        </svg>
      );
    default:
      return null;
  }
}

const PRIORITY_BAR_COLORS: Record<Priority, string> = {
  low:      '#9BB3A4',
  medium:   'var(--color-yellow)',
  high:     'var(--color-orange)',
  critical: 'var(--color-danger)',
};

const PRIORITY_BAR_COUNT: Record<Priority, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

interface PriorityBarsProps {
  priority: Priority;
}

function PriorityBars({ priority }: PriorityBarsProps) {
  const litCount = PRIORITY_BAR_COUNT[priority];
  const litColor = PRIORITY_BAR_COLORS[priority];
  const greyColor = 'var(--color-border)';
  const bars = [
    { x: 0, y: 10, height: 4 },
    { x: 4.2, y: 7, height: 7 },
    { x: 8.4, y: 4, height: 10 },
    { x: 12.6, y: 1, height: 13 },
  ];
  return (
    <svg width="15" height="14" viewBox="0 0 15 14" fill="none" aria-label={`Priority: ${priority}`}>
      {bars.map((bar, i) => (
        <rect
          key={i}
          x={bar.x}
          y={bar.y}
          width="2.6"
          height={bar.height}
          rx="1"
          fill={i < litCount ? litColor : greyColor}
        />
      ))}
    </svg>
  );
}

function CalendarIcon({ overdue }: { overdue: boolean }) {
  const color = overdue ? 'var(--color-danger)' : 'var(--color-text-secondary)';
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="5.5" width="17" height="15" rx="2.5" />
      <path d="M3.5 10H20.5" />
      <path d="M8 3V6.5" />
      <path d="M16 3V6.5" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 14 14" fill="none">
      <rect x="3" y="6.5" width="8" height="6" rx="1.3" stroke="var(--color-danger)" strokeWidth="1.4" />
      <path d="M4.6 6.5V4.8A2.4 2.4 0 0 1 9.4 4.8V6.5" stroke="var(--color-danger)" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function SubTicketIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 14 14" fill="none" stroke="#9AA8A0" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 2.5V8A2.5 2.5 0 0 0 6 10.5H9.5" />
      <path d="M7.5 8.5L10 11L7.5 13.5" />
    </svg>
  );
}

interface TicketCardProps {
  ticket: Ticket;
  memberMap?: Map<string, Member>;
  childSummary?: { done: number; total: number };
}

export function TicketCard({ ticket, memberMap, childSummary }: TicketCardProps) {
  const tc = TYPE_CONFIG[ticket.type];
  const due = getDueDateDisplay(ticket.dueDate);
  const assigneeMember = ticket.assignee && memberMap ? memberMap.get(ticket.assignee) : null;
  const isBlocked = (ticket.blockedBy ?? []).length > 0;
  const completedAC = (ticket.acceptanceCriteria ?? []).filter((s) => s.done).length;
  const totalAC = (ticket.acceptanceCriteria ?? []).length;
  const isDone = ticket.status === 'done';
  const visibleTags = ticket.tags.slice(0, 3);
  const overflowTagCount = ticket.tags.length - visibleTags.length;
  const hasChildren = !!childSummary && childSummary.total > 0;
  const childProgressPct = hasChildren ? Math.round((childSummary!.done / childSummary!.total) * 100) : 0;

  return (
    <div className={`${styles.card} ${isBlocked ? styles.cardBlocked : ''} ${hasChildren ? styles.cardParent : ''}`}>
      <div className={styles.cardInner}>
        {/* Header: type icon + label on the left, ticket ID on the right */}
        <div className={styles.cardHeader}>
          <div className={styles.cardHeaderLeft}>
            <TypeIcon type={ticket.type} color={tc.color} />
            <span className={styles.typeLabel}>{tc.label}</span>
          </div>
          <span className={`${styles.cardId} ${isDone ? styles.cardIdDone : ''}`}>{ticket.id}</span>
        </div>

        {/* Title */}
        <span className={styles.cardTitle}>{ticket.title}</span>

        {/* Tags row */}
        {visibleTags.length > 0 && (
          <div className={styles.tagRow}>
            {visibleTags.map((tag, i) => (
              <span key={`${tag}-${i}`} className={styles.tagPill} style={tagChipStyle(tag)}>{tag}</span>
            ))}
            {overflowTagCount > 0 && <span className={styles.tagOverflow}>+{overflowTagCount}</span>}
          </div>
        )}

        {/* Sub-ticket progress rollup (parent cards only) */}
        {hasChildren && (
          <div className={styles.subTicketProgressRow}>
            <div className={styles.subTicketProgressTrack}>
              <div className={styles.subTicketProgressFill} style={{ width: `${childProgressPct}%` }} />
            </div>
            <span className={styles.subTicketProgressLabel}>
              {childSummary!.done}/{childSummary!.total} sub-tasks
            </span>
          </div>
        )}

        {/* Parent/sub-ticket chip */}
        {ticket.parentId && (
          <div className={styles.parentRow}>
            <span className={styles.parentChip}>
              <SubTicketIcon />
              {ticket.parentId}
            </span>
          </div>
        )}

        {/* Footer: priority bars + assignee + spacer + estimate + sub-tasks + due date */}
        <div className={styles.cardFooter}>
          {assigneeMember && <MemberAvatar member={assigneeMember} size={20} />}
          <PriorityBars priority={ticket.priority} />
          <span className={styles.footerSpacer} />
          {ticket.estimate !== null && ticket.estimate !== undefined && (
            <span className={styles.estimateBadge}>{ticket.estimate} pt</span>
          )}
          {totalAC > 0 && (
            <span className={completedAC === totalAC ? styles.subTasksDone : styles.subTasksProgress}>
              {completedAC}/{totalAC}
            </span>
          )}
          {due && (
            <span className={due.overdue ? styles.dueDateOverdue : styles.dueDate}>
              <CalendarIcon overdue={due.overdue} />
              Due {due.label}
            </span>
          )}
        </div>
      </div>

      {isBlocked && (
        <div
          className={styles.blockedBadge}
          title={ticket.blockedBy?.length ? `Blocked by ${ticket.blockedBy.join(', ')}` : 'Blocked'}
        >
          <LockIcon />
        </div>
      )}
    </div>
  );
}
