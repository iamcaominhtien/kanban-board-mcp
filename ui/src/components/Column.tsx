import { useDroppable } from '@dnd-kit/core';
import type { Column as ColumnType, Member, Ticket } from '../types';
import { DraggableTicketCard } from './DraggableTicketCard';
import styles from './Board.module.css';
import loading from './AppLoading.module.css';

interface ColumnProps {
  column: ColumnType;
  tickets: Ticket[];
  allTickets?: Ticket[];
  onCardClick: (ticket: Ticket) => void;
  memberMap?: Map<string, Member>;
  /** Tickets are still loading: real lane header, skeleton cards (same size as real cards, so nothing moves). */
  skeletonCards?: number;
}

/** One board column and its draggable ticket cards. */
export function Column({ column, tickets, allTickets, onCardClick, memberMap, skeletonCards }: ColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });

  const columnTicketIds = new Set(tickets.map((t) => t.id));

  // Sort by createdAt descending (newest first) before applying hierarchy
  const sorted = [...tickets].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

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
    <div ref={setNodeRef} className={`${styles.column} ${isOver ? styles.columnDragOver : ''}`}>
      <div className={styles.columnHeaderContainer}>
        <div className={styles.columnHeaderTop}>
          <span className={styles.columnLabel}>{column.label}</span>
          {skeletonCards !== undefined ? (
            <span className={`${loading.skel} ${loading.skelBadge}`} aria-hidden="true" />
          ) : (
            <span
              className={styles.columnBadge}
              style={{ backgroundColor: column.accentColor }}
              aria-label={`${tickets.length} ticket${tickets.length !== 1 ? 's' : ''}`}
            >
              {tickets.length}
            </span>
          )}
        </div>
        <div className={styles.columnBar} style={{ backgroundColor: column.accentColor }} />
      </div>

      <div className={styles.columnBody} aria-hidden={skeletonCards !== undefined ? true : undefined}>
        {skeletonCards !== undefined &&
          Array.from({ length: skeletonCards }).map((_, i) => (
            <div key={i} className={loading.skelCard} style={{ opacity: i > 0 ? 0.75 : 1 }}>
              <div className={loading.skel} style={{ width: 64, height: 10 }} />
              <div className={loading.skel} style={{ width: 90, height: 16, borderRadius: 999 }} />
              <div className={loading.skel} style={{ width: '100%', height: 12 }} />
              <div className={loading.skel} style={{ width: '70%', height: 12 }} />
            </div>
          ))}
        {skeletonCards === undefined && ordered.length === 0 && !isOver && (
          <div className={styles.emptyState}>
            <span className={styles.emptyIcon} aria-hidden="true">
              ◻
            </span>
            <span className={styles.emptyText}>No tickets</span>
          </div>
        )}
        {ordered.map((ticket) => {
          const indented = ticket.parentId != null && columnTicketIds.has(ticket.parentId);
          const childTicketsForThis = (allTickets ?? tickets).filter((t) => t.parentId === ticket.id);
          const subtaskStats =
            childTicketsForThis.length > 0
              ? {
                  total: childTicketsForThis.length,
                  completed: childTicketsForThis.filter((c) => c.status === 'done').length,
                }
              : undefined;

          return indented ? (
            <div key={ticket.id} className={styles.childIndent}>
              <DraggableTicketCard
                ticket={ticket}
                onCardClick={onCardClick}
                memberMap={memberMap}
                subtaskStats={subtaskStats}
              />
            </div>
          ) : (
            <DraggableTicketCard
              key={ticket.id}
              ticket={ticket}
              onCardClick={onCardClick}
              memberMap={memberMap}
              subtaskStats={subtaskStats}
            />
          );
        })}
        {isOver && <div className={styles.dropTargetGhost}>Drop here</div>}
      </div>
    </div>
  );
}
