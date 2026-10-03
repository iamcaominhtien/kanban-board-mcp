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
  });

  const wasDragging = useRef(false);

  useEffect(() => {
    if (isDragging) {
      wasDragging.current = true;
    }
  }, [isDragging]);

  if (isDragging) {
    return (
      <div
        ref={setNodeRef}
        style={{
          minHeight: 118,
          borderRadius: 8,
          border: '1.5px dashed #C7D2CB',
          boxSizing: 'border-box',
          opacity: 0.75,
          margin: '2px 0',
        }}
      />
    );
  }

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

  return (
    <div ref={setNodeRef} style={style} {...listeners} {...attributes} onClick={handleClick}>
      <TicketCard ticket={ticket} memberMap={memberMap} />
    </div>
  );
}
