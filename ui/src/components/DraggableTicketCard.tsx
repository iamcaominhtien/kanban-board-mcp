import { useEffect, useRef } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import type { Member, Ticket } from '../types';
import { TicketCard } from './TicketCard';

interface DraggableTicketCardProps {
  ticket: Ticket;
  allTickets?: Ticket[];
  onCardClick?: (ticket: Ticket) => void;
  memberMap?: Map<string, Member>;
  subtaskStats?: { total: number; completed: number };
  onReopen?: (ticket: Ticket) => void;
  onPending?: (ticket: Ticket) => void;
  onResume?: (ticket: Ticket) => void;
  onDelete?: (ticket: Ticket) => void;
}

/**
 * Ticket card wired to drag and drop.
 */
export function DraggableTicketCard({
  ticket,
  allTickets,
  onCardClick,
  memberMap,
  subtaskStats,
  onReopen,
  onPending,
  onResume,
  onDelete,
}: DraggableTicketCardProps) {
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
      <TicketCard
        ticket={ticket}
        allTickets={allTickets}
        memberMap={memberMap}
        subtaskStats={subtaskStats}
        onReopen={onReopen}
        onPending={onPending}
        onResume={onResume}
        onDelete={onDelete}
      />
    </div>
  );
}
