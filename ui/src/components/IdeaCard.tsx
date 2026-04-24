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

type IdeaEnergy = 'seed' | 'concept' | 'hot' | 'big_bet';

const ENERGY_META: Record<IdeaEnergy, { emoji: string; label: string }> = {
  seed:    { emoji: '🌱', label: 'Seed' },
  concept: { emoji: '💡', label: 'Concept' },
  hot:     { emoji: '🔥', label: 'Hot' },
  big_bet: { emoji: '🚀', label: 'Big Bet' },
};

interface IdeaCardProps {
  ticket: IdeaTicket & { ideaEnergy?: IdeaEnergy };
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
    opacity: dragging ? 0.5 : 1,
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
  const energy = (ticket as IdeaCardProps['ticket']).ideaEnergy;
  const energyMeta = energy ? ENERGY_META[energy] : null;

  const energyClass = energy === 'hot'
    ? styles.energyTagHot
    : energy === 'big_bet'
    ? styles.energyTagBigBet
    : '';

  return (
    <div
      ref={setNodeRef}
      className={`${styles.card} ${isDropped ? styles.cardDropped : ''}`}
      style={style}
      onClick={handleClick}
    >
      {/* Color strip at top */}
      <div className={styles.colorStrip} style={{ background: accentColor }} />

      {/* Drag handle */}
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

      <div className={styles.inner}>
        {energyMeta && (
          <span className={`${styles.energyTag} ${energyClass}`}>
            {energyMeta.emoji} {energyMeta.label}
          </span>
        )}

        <div className={styles.emoji}>{ticket.ideaEmoji || '💡'}</div>

        <p className={styles.title}>{ticket.title}</p>

        {ticket.description && (
          <p className={styles.description}>{ticket.description}</p>
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
