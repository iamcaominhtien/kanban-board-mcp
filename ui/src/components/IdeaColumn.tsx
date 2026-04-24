import { useDroppable } from '@dnd-kit/core';
import type { IdeaStatus, IdeaTicket } from '../types';
import { IdeaCard } from './IdeaCard';
import styles from './IdeaColumn.module.css';

export interface IdeaColumnDef {
  id: IdeaStatus;
  label: string;
  emoji: string;
  accentColor: string;
  headerBg: string;   // background for the column body (tinted)
  accentBg: string;   // background for the emoji circle
}

interface IdeaColumnProps {
  column: IdeaColumnDef;
  tickets: IdeaTicket[];
  isTerminal: boolean;
  onCardClick: (ticket: IdeaTicket) => void;
}

export function IdeaColumn({ column, tickets, isTerminal: _isTerminal, onCardClick }: IdeaColumnProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: column.id,
  });

  return (
    <div
      ref={setNodeRef}
      className={`${styles.column} ${isOver ? styles.columnOver : ''}`}
      style={{
        '--col-bg': column.headerBg,
        '--col-accent': column.accentBg,
        background: column.headerBg,
      } as React.CSSProperties}
    >
      <div className={styles.header}>
        <span className={styles.emojiCircle}>{column.emoji}</span>
        <span className={styles.label}>{column.label}</span>
        <span className={styles.badge}>{tickets.length}</span>
      </div>

      <div className={styles.cardList}>
        {tickets.length === 0 ? (
          <div className={styles.empty}>{column.emoji} No ideas yet</div>
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
