import { useEffect, useRef } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import type { IdeaColor, IdeaTicket } from '../types';
import styles from './IdeaCard.module.css';

const COLOR_MAP: Record<IdeaColor, string> = {
  yellow: 'var(--color-yellow)',
  orange: 'var(--color-orange)',
  lime:   'var(--color-lime)',
  pink:   'var(--color-pink)',
  blue:   'var(--color-blue)',
  purple: 'var(--color-purple)',
  teal:   'var(--color-teal)',
};

interface IdeaCardProps {
  ticket: IdeaTicket;
  isDragging?: boolean;
  onClick: () => void;
}

export function IdeaCard({ ticket, isDragging: externalDragging, onClick }: IdeaCardProps) {
  const isDropped = ticket.ideaStatus === 'dropped';

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: ticket.id,
    disabled: isDropped,
  });

  const wasDragging = useRef(false);
  useEffect(() => {
    if (isDragging) wasDragging.current = true;
  }, [isDragging]);

  const accentColor = COLOR_MAP[ticket.ideaColor] ?? 'var(--color-yellow)';
  const dragging = isDragging || externalDragging;

  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(transform),
    opacity: dragging ? 0.5 : isDropped ? 0.65 : 1,
    borderLeftColor: accentColor,
  };

  function handleClick() {
    if (wasDragging.current) {
      wasDragging.current = false;
      return;
    }
    onClick();
  }

  const visibleTags = ticket.tags.slice(0, 3);
  const extraTagCount = ticket.tags.length - visibleTags.length;

  return (
    <div
      ref={setNodeRef}
      className={`${styles.card} ${isDropped ? styles.cardDropped : ''}`}
      style={style}
      onClick={handleClick}
    >
      {!isDropped && (
        <button
          type="button"
          className={styles.dragHandle}
          {...listeners}
          {...attributes}
          onClick={(e) => e.stopPropagation()}
          aria-label="Drag card"
        >
          ⠿
        </button>
      )}

      <div className={styles.emoji}>{ticket.ideaEmoji || '💡'}</div>

      <div className={styles.body}>
        <p className={styles.title}>{ticket.title}</p>

        {ticket.ideaStatus === 'approved' && (
          <span className={styles.badgeApproved}>🔒 Approved</span>
        )}
        {ticket.ideaStatus === 'dropped' && (
          <span className={styles.badgeDropped}>✗ Dropped</span>
        )}

        {visibleTags.length > 0 && (
          <div className={styles.tags}>
            {visibleTags.map((tag) => (
              <span key={tag} className={styles.tag}>{tag}</span>
            ))}
            {extraTagCount > 0 && (
              <span className={styles.tagExtra}>+{extraTagCount}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
