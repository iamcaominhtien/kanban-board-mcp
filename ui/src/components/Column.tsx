import { useDroppable } from '@dnd-kit/core';
import type { Column as ColumnType, Member, Ticket } from '../types';
import { DraggableTicketCard } from './DraggableTicketCard';
import styles from './Board.module.css';

interface ColumnProps {
  column: ColumnType & { badgeTextColor: string; badgeBgColor?: string };
  tickets: Ticket[];
  onCardClick: (ticket: Ticket) => void;
  memberMap?: Map<string, Member>;
  childSummaryMap?: Map<string, { done: number; total: number }>;
}

export function Column({ column, tickets, onCardClick, memberMap, childSummaryMap }: ColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });

  const columnTicketIds = new Set(tickets.map((t) => t.id));

  // Sort by createdAt descending (newest first) before applying hierarchy
  const sorted = [...tickets].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  // Build ordered list: parents first, then their children immediately after
  const ordered: Ticket[] = [];
  const placed = new Set<string>();

  for (const ticket of sorted) {
    if (placed.has(ticket.id)) continue;
    // Only place as root if it's not a child of another ticket in this column
    const isChildInColumn = ticket.parentId != null && columnTicketIds.has(ticket.parentId);
    if (isChildInColumn) continue;
    ordered.push(ticket);
    placed.add(ticket.id);
    // Place direct children immediately after
    for (const child of sorted) {
      if (child.parentId === ticket.id && !placed.has(child.id)) {
        ordered.push(child);
        placed.add(child.id);
      }
    }
  }
  // Any remaining (shouldn't happen, but safety net)
  for (const ticket of sorted) {
    if (!placed.has(ticket.id)) ordered.push(ticket);
  }

  return (
    <div
      ref={setNodeRef}
      className={`${styles.column} ${isOver ? styles.columnOver : ''}`}
    >
      <div className={styles.columnAccentBar} style={{ backgroundColor: column.accentColor }} />
      <div className={styles.columnHeader}>
        <span className={styles.columnLabel}>{column.label}</span>
        <span
          className={styles.badge}
          style={{
            backgroundColor: column.badgeBgColor ?? column.accentColor,
            color: column.badgeTextColor,
          }}
          aria-label={`${tickets.length} ticket${tickets.length !== 1 ? 's' : ''}`}
        >
          {tickets.length}
        </span>
      </div>
      <div className={styles.columnBody}>
        {ordered.length === 0 && (
          <div className={styles.emptyState}>
            <span className={styles.emptyIcon} aria-hidden="true">◻</span>
            <span className={styles.emptyText}>No tickets</span>
          </div>
        )}
        {ordered.map((ticket) => {
          const indented = ticket.parentId != null && columnTicketIds.has(ticket.parentId);
          const childSummary = childSummaryMap?.get(ticket.id);
          return indented ? (
            <div key={ticket.id} className={styles.childIndent}>
              <DraggableTicketCard ticket={ticket} onCardClick={onCardClick} memberMap={memberMap} childSummary={childSummary} />
            </div>
          ) : (
            <DraggableTicketCard key={ticket.id} ticket={ticket} onCardClick={onCardClick} memberMap={memberMap} childSummary={childSummary} />
          );
        })}
        {isOver && <div className={styles.targetGhost} />}
      </div>
    </div>
  );
}
