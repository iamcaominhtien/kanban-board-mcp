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

// Extends the base Column shape with the count-pill's text (and, where the
// accent color itself is too light/mid-tone to clear 4.5:1 with either text
// color, a slightly darkened badge-only background) so every badge meets
// WCAG AA contrast against its own accent.
type BoardColumn = ColumnType & { badgeTextColor: string; badgeBgColor?: string };

const COLUMNS: BoardColumn[] = [
  { id: 'backlog',     label: 'Backlog',      accentColor: '#9AA8A0',              badgeTextColor: 'var(--color-dark)' },
  { id: 'todo',        label: 'To Do',        accentColor: 'var(--color-blue)',    badgeTextColor: 'var(--color-on-accent-dark)' },
  { id: 'in-progress', label: 'In Progress',  accentColor: 'var(--color-orange)',  badgeTextColor: 'var(--color-on-accent-dark)', badgeBgColor: '#BD531C' },
  { id: 'done',        label: 'Done',         accentColor: 'var(--color-lime)',    badgeTextColor: 'var(--color-dark)' },
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

  // Roll up sub-ticket completion per parent, computed once from the full
  // (unfiltered) ticket set so it stays accurate regardless of which column
  // or filter view a card currently sits in.
  const childSummaryMap = new Map<string, { done: number; total: number }>();
  for (const t of allTickets) {
    if (!t.parentId) continue;
    const entry = childSummaryMap.get(t.parentId) ?? { done: 0, total: 0 };
    entry.total += 1;
    if (t.status === 'done') entry.done += 1;
    childSummaryMap.set(t.parentId, entry);
  }

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
              return (
                <Column
                  key={col.id}
                  column={col}
                  tickets={colTickets}
                  onCardClick={onCardClick}
                  memberMap={memberMap}
                  childSummaryMap={childSummaryMap}
                />
              );
            })}
          </div>
        )}
      </div>

      <DragOverlay>
        {activeTicket ? (
          <div style={{ transform: 'scale(1.03) rotate(2deg)', pointerEvents: 'none' }}>
            <TicketCard ticket={activeTicket} memberMap={memberMap} childSummary={childSummaryMap.get(activeTicket.id)} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
