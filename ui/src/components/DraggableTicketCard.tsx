import { useEffect, useRef } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import type { Member, Ticket } from '../types';
import { TicketCard } from './TicketCard';
import cardStyles from './TicketCard.module.css';

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
  hideStoryChip?: boolean;
  /** Enter on the focused card opens it (defaults to onCardClick). */
  onCardOpen?: (ticket: Ticket) => void;
  /** Part of the selected parent group: the green ring (Sub-task Grouping 1). */
  groupSelected?: boolean;
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
  hideStoryChip,
  onCardOpen,
  groupSelected,
}: DraggableTicketCardProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging, active } = useDraggable({
    id: ticket.id,
  });

  const wasDragging = useRef(false);

  useEffect(() => {
    if (isDragging) {
      wasDragging.current = true;
    }
  }, [isDragging]);

  if (isDragging) {
    // The source ghost keeps the card's slot, so the cards below do not jump on pick-up (comp-1 DD-2)
    const slotHeight = active?.rect.current.initial?.height;
    return (
      <div
        ref={setNodeRef}
        data-testid="drag-source-ghost"
        style={{
          height: slotHeight ?? undefined,
          minHeight: slotHeight ? undefined : 90,
          borderRadius: 8,
          // a plain dashed outline at full strength, no margin, so nothing below moves (Drag & Drop 2, source ghost)
          border: '1.5px dashed #C7D2CB',
          boxSizing: 'border-box',
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
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) {
          e.preventDefault();
          (onCardOpen ?? onCardClick)?.(ticket);
        }
      }}
    >
      <TicketCard
        className={groupSelected ? cardStyles.cardGroupSelected : undefined}
        ticket={ticket}
        allTickets={allTickets}
        memberMap={memberMap}
        subtaskStats={subtaskStats}
        onReopen={onReopen}
        onPending={onPending}
        onResume={onResume}
        onDelete={onDelete}
        hideStoryChip={hideStoryChip}
      />
    </div>
  );
}
