import { useState } from 'react';
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import type { Column as ColumnType, Member, Priority, Status, Ticket } from '../types';
import { Column } from './Column';
import { FilterBar } from './FilterBar';
import { ListView } from './ListView';
import { TimelineView } from './TimelineView';
import { TicketCard } from './TicketCard';
import styles from './Board.module.css';

const COLUMNS: ColumnType[] = [
  { id: 'backlog',     label: 'Backlog',      accentColor: '#533483' },
  { id: 'todo',        label: 'To Do',        accentColor: '#0f3460' },
  { id: 'in-progress', label: 'In Progress',  accentColor: '#e2b04a' },
  { id: 'done',        label: 'Done',         accentColor: '#2ecc71' },
];

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
  projectId?: string;
  viewMode: 'board' | 'list' | 'timeline';
  onViewModeChange: (v: 'board' | 'list' | 'timeline') => void;
  members?: Member[];
  activeAssignee?: string | 'all';
  onAssigneeChange?: (id: string | 'all') => void;
}

const VALID_STATUSES = new Set<string>(['backlog', 'todo', 'in-progress', 'done']);

export function Board({ tickets, allTickets, onDragEnd, onNewTicket, onCardClick, searchQuery, onSearchChange, activePriority, onPriorityChange, projectName, projectId, viewMode, onViewModeChange, members = [], activeAssignee = 'all', onAssigneeChange }: BoardProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );
  const [activeTicketId, setActiveTicketId] = useState<string | null>(null);
  const activeTicket = allTickets.find((t) => t.id === activeTicketId) ?? null;
  const memberMap = new Map(members.map((m) => [m.id, m]));

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
          <div className={styles.topBarRight}>
            <div className={styles.viewSwitcher}>
              <button
                type="button"
                className={`${styles.viewBtn} ${viewMode === 'board' ? styles.viewBtnActive : ''}`}
                onClick={() => onViewModeChange('board')}
              >
                Board
              </button>
              <button
                type="button"
                className={`${styles.viewBtn} ${viewMode === 'list' ? styles.viewBtnActive : ''}`}
                onClick={() => onViewModeChange('list')}
              >
                List
              </button>
              <button
                type="button"
                className={`${styles.viewBtn} ${viewMode === 'timeline' ? styles.viewBtnActive : ''}`}
                onClick={() => onViewModeChange('timeline')}
              >
                Timeline
              </button>
            </div>
            <button type="button" className={styles.newButton} onClick={onNewTicket}>+ New Ticket</button>
          </div>
        </div>

        <FilterBar
          searchQuery={searchQuery}
          onSearchChange={onSearchChange}
          activePriority={activePriority}
          onPriorityChange={onPriorityChange}
          members={members}
          activeAssignee={activeAssignee}
          onAssigneeChange={onAssigneeChange ?? (() => {})}
        />

        {viewMode === 'list' ? (
          <ListView tickets={tickets} onCardClick={onCardClick} />
        ) : viewMode === 'timeline' ? (
          <TimelineView tickets={tickets} projectId={projectId ?? ''} onCardClick={onCardClick} />
        ) : (
          <div className={styles.columns}>
            {COLUMNS.map((col) => {
              const colTickets = tickets.filter((t) => t.status === col.id);
              return <Column key={col.id} column={col} tickets={colTickets} onCardClick={onCardClick} memberMap={memberMap} />;
            })}
          </div>
        )}
      </div>

      <DragOverlay>
        {activeTicket ? (
          <div style={{ transform: 'scale(1.03) rotate(2deg)', pointerEvents: 'none' }}>
            <TicketCard ticket={activeTicket} memberMap={memberMap} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
