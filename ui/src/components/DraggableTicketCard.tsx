import { useEffect, useRef } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import type { Member, Ticket } from '../types';
import { TicketCard } from './TicketCard';
import styles from './Board.module.css';

interface DraggableTicketCardProps {
  ticket: Ticket;
  onCardClick?: (ticket: Ticket) => void;
  memberMap?: Map<string, Member>;
  childSummary?: { done: number; total: number };
}

export function DraggableTicketCard({ ticket, onCardClick, memberMap, childSummary }: DraggableTicketCardProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: ticket.id,
  });

  const wasDragging = useRef(false);

  useEffect(() => {
    if (isDragging) {
      wasDragging.current = true;
    }
  }, [isDragging]);

  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(transform),
    cursor: 'grab',
  };

  function handleClick() {
    if (wasDragging.current) {
      wasDragging.current = false;
      return;
    }
    onCardClick?.(ticket);
  }

  // While this card is being dragged, the real content is shown by the
  // floating DragOverlay copy elsewhere. This slot becomes an empty
  // dashed-outline placeholder ("hole left behind"), matching the
  // mockup's .source-ghost element.
  if (isDragging) {
    return <div ref={setNodeRef} style={style} className={styles.sourceGhost} />;
  }

  return (
    <div ref={setNodeRef} style={style} {...listeners} {...attributes} onClick={handleClick}>
      <TicketCard ticket={ticket} memberMap={memberMap} childSummary={childSummary} />
    </div>
  );
}
