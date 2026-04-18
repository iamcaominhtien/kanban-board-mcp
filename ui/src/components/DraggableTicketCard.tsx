import { useEffect, useRef } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import type { Member, Ticket } from '../types';
import { TicketCard } from './TicketCard';

interface DraggableTicketCardProps {
  ticket: Ticket;
  onCardClick?: (ticket: Ticket) => void;
  memberMap?: Map<string, Member>;
}

export function DraggableTicketCard({ ticket, onCardClick, memberMap }: DraggableTicketCardProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: ticket.id,
    attributes: {
      tabIndex: -1,
    },
  });

  const wasDragging = useRef(false);

  useEffect(() => {
    if (isDragging) {
      wasDragging.current = true;
    }
  }, [isDragging]);

  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.4 : undefined,
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
      <TicketCard ticket={ticket} memberMap={memberMap} />
    </div>
  );
}
