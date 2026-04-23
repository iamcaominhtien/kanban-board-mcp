import { useEffect, useRef } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import type { IdeaColor, IdeaEnergy, IdeaTicket } from '../types';
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

const ENERGY_META: Record<IdeaEnergy, { emoji: string; label: string; bg: string }> = {
  seed:    { emoji: '🌱', label: 'Seed',    bg: 'rgba(170, 204, 46, 0.15)' },
  concept: { emoji: '💡', label: 'Concept', bg: 'rgba(245, 197, 24, 0.15)' },
  hot:     { emoji: '🔥', label: 'Hot',     bg: 'rgba(232, 68, 26, 0.15)' },
  big_bet: { emoji: '🚀', label: 'Big Bet', bg: 'rgba(139, 92, 246, 0.15)' },
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diff === 0) return 'today';
  if (diff === 1) return 'yesterday';
  if (diff < 7) return `${diff}d ago`;
  if (diff < 30) return `${Math.floor(diff / 7)}w ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

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
  const energy = ticket.ideaEnergy ? ENERGY_META[ticket.ideaEnergy] : null;

  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(transform),
    opacity: dragging ? 0.5 : isDropped ? 0.65 : ticket.ideaStatus === 'approved' ? 0.85 : 1,
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
      <div className={styles.colorStrip} style={{ background: accentColor }} />

      <div className={styles.cardContent}>
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
          {energy && (
            <span
              className={styles.energyTag}
              style={{ background: energy.bg, color: 'var(--color-dark)' }}
            >
              {energy.emoji} {energy.label}
            </span>
          )}

          <p className={styles.title}>{ticket.title}</p>

          {ticket.description && (
            <p className={styles.description}>{ticket.description}</p>
          )}

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

        <div className={styles.footer}>
          <span className={styles.footerId}>{ticket.id}</span>
          <span className={styles.footerDate}>{formatDate(ticket.createdAt)}</span>
        </div>
      </div>
    </div>
  );
}
