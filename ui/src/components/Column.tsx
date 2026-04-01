import { useDroppable } from '@dnd-kit/core';
import type { Column as ColumnType, Ticket } from '../types';
import { DraggableTicketCard } from './DraggableTicketCard';
import styles from './Board.module.css';

interface ColumnProps {
  column: ColumnType;
  tickets: Ticket[];
  onCardClick: (ticket: Ticket) => void;
}

export function Column({ column, tickets, onCardClick }: ColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });

  return (
    <div
      ref={setNodeRef}
      className={styles.column}
      style={{
        backgroundColor: column.accentColor,
        filter: isOver ? 'brightness(0.88)' : undefined,
        outline: isOver ? '2px solid rgba(0,0,0,0.2)' : undefined,
        transition: 'filter 0.15s ease, outline 0.15s ease',
      }}
    >
      <div className={styles.columnHeader}>
        <span className={styles.columnLabel}>{column.label}</span>
        <span className={styles.badge}>{tickets.length}</span>
      </div>
      <div className={styles.columnBody}>
        {tickets.map((ticket) => (
          <DraggableTicketCard key={ticket.id} ticket={ticket} onCardClick={onCardClick} />
        ))}
      </div>
    </div>
  );
}
