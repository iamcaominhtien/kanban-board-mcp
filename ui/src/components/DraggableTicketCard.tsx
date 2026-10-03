import { useEffect, useRef } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import type { Member, Ticket } from '../types';
import { TicketCard } from './TicketCard';

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
    transform: isDragging
      ? `${CSS.Translate.toString(transform)} rotate(1deg)`
      : CSS.Translate.toString(transform),
    opacity: isDragging ? 0.4 : undefined,
    boxShadow: isDragging ? '0 12px 24px rgba(30, 42, 34, 0.18)' : undefined,
    cursor: 'grab',
  };

  function handleClick() {
    if (wasDragging.current) {
      wasDragging.current = false;
      return;
    }
    onCardClick?.(ticket);
  }

  return (
    <div ref={setNodeRef} style={style} {...listeners} {...attributes} onClick={handleClick}>
      <TicketCard ticket={ticket} memberMap={memberMap} childSummary={childSummary} />
    </div>
  );
}
