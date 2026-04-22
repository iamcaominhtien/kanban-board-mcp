import { useDroppable } from '@dnd-kit/core';
import type { IdeaStatus, IdeaTicket } from '../types';
import { IdeaCard } from './IdeaCard';
import styles from './IdeaColumn.module.css';

export interface IdeaColumnDef {
  id: IdeaStatus;
  label: string;
  emoji: string;
  accentColor: string;
}

interface IdeaColumnProps {
  column: IdeaColumnDef;
  tickets: IdeaTicket[];
  isTerminal: boolean;
  onCardClick: (ticket: IdeaTicket) => void;
}

export function IdeaColumn({ column, tickets, isTerminal, onCardClick }: IdeaColumnProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: column.id,
    disabled: isTerminal,
  });

  return (
    <div
      className={`${styles.column} ${isOver ? styles.columnOver : ''}`}
      style={{ '--accent': column.accentColor } as React.CSSProperties}
    >
      <div className={styles.header}>
        <span className={styles.emoji}>{column.emoji}</span>
        <span className={styles.label}>{column.label}</span>
        <span className={styles.badge}>{tickets.length}</span>
      </div>

      <div ref={setNodeRef} className={styles.cardList}>
        {tickets.length === 0 ? (
          <div className={styles.empty}>No ideas here</div>
        ) : (
          tickets.map((ticket) => (
            <IdeaCard
              key={ticket.id}
              ticket={ticket}
              onClick={() => onCardClick(ticket)}
            />
          ))
        )}
      </div>
    </div>
  );
}
