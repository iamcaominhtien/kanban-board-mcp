import { useDroppable } from '@dnd-kit/core';
import type { Column as ColumnType, Member, Ticket } from '../types';
import { DraggableTicketCard } from './DraggableTicketCard';
import styles from './Board.module.css';

interface ColumnProps {
  column: ColumnType;
  tickets: Ticket[];
  onCardClick: (ticket: Ticket) => void;
  memberMap?: Map<string, Member>;
}

export function Column({ column, tickets, onCardClick, memberMap }: ColumnProps) {
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
      className={styles.column}
      data-status={column.id}
      style={({
        backgroundColor: column.accentColor,
        '--column-accent': column.accentColor,
        filter: isOver ? 'brightness(0.88)' : undefined,
        outline: isOver ? '2px solid rgba(0,0,0,0.2)' : undefined,
        transition: 'filter 0.15s ease, outline 0.15s ease',
      } as React.CSSProperties)}
    >
      <div className={styles.columnHeader}>
        <span className={styles.columnLabel}>{column.label}</span>
        <span className={styles.badge}>{tickets.length}</span>
      </div>
      <div className={styles.columnBody}>
        {ordered.map((ticket) => {
          const indented = ticket.parentId != null && columnTicketIds.has(ticket.parentId);
          return indented ? (
            <div key={ticket.id} className={styles.childIndent}>
              <DraggableTicketCard ticket={ticket} onCardClick={onCardClick} memberMap={memberMap} />
            </div>
          ) : (
            <DraggableTicketCard key={ticket.id} ticket={ticket} onCardClick={onCardClick} memberMap={memberMap} />
          );
        })}
      </div>
    </div>
  );
}
