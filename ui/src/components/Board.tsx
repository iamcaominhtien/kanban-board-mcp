import { useState } from 'react';
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import { COLUMNS } from '../data/mock-tickets';
import type { Priority, Status, Ticket } from '../types';
import { Column } from './Column';
import { FilterBar } from './FilterBar';
import { TicketCard } from './TicketCard';
import styles from './Board.module.css';

interface BoardProps {
  tickets: Ticket[];
  allTickets: Ticket[];
  onDragEnd: (ticketId: string, newStatus: Status) => void;
  onNewTicket: () => void;
  onCardClick: (ticket: Ticket) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  activePriority: Priority | 'all';
  onPriorityChange: (p: Priority | 'all') => void;
  projectName: string;
}

const VALID_STATUSES = new Set<string>(['backlog', 'todo', 'in-progress', 'done']);

export function Board({ tickets, allTickets, onDragEnd, onNewTicket, onCardClick, searchQuery, onSearchChange, activePriority, onPriorityChange, projectName }: BoardProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );
  const [activeTicketId, setActiveTicketId] = useState<string | null>(null);
  const activeTicket = allTickets.find((t) => t.id === activeTicketId) ?? null;

  function handleDragStart(event: DragStartEvent) {
    setActiveTicketId(event.active.id as string);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || !VALID_STATUSES.has(over.id as string)) {
      setActiveTicketId(null);
      return;
    }
    setActiveTicketId(null);
    onDragEnd(active.id as string, over.id as Status);
  }

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className={styles.board}>
        <div className={styles.topBar}>
          <h1 className={styles.title}>{projectName}</h1>
          <button type="button" className={styles.newButton} onClick={onNewTicket}>+ New Ticket</button>
        </div>

        <FilterBar
          searchQuery={searchQuery}
          onSearchChange={onSearchChange}
          activePriority={activePriority}
          onPriorityChange={onPriorityChange}
        />

        <div className={styles.columns}>
          {COLUMNS.map((col) => {
            const colTickets = tickets.filter((t) => t.status === col.id);
            return <Column key={col.id} column={col} tickets={colTickets} onCardClick={onCardClick} />;
          })}
        </div>
      </div>

      <DragOverlay>
        {activeTicket ? (
          <div style={{ transform: 'scale(1.03) rotate(2deg)', pointerEvents: 'none' }}>
            <TicketCard ticket={activeTicket} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
