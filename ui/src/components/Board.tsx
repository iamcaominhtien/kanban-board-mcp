import { useState, type ReactNode } from 'react';
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import type { Column as ColumnType, IssueType, Member, Priority, Status, Ticket } from '../types';
import { Column } from './Column';
import { FilterBar } from './FilterBar';
import { ListView } from './ListView';
import { TimelineView } from './TimelineView';
import { TicketCard } from './TicketCard';
import styles from './Board.module.css';
import loadingStyles from './AppLoading.module.css';

const COLUMNS: ColumnType[] = [
  { id: 'backlog',     label: 'Backlog',      accentColor: 'var(--color-backlog)' },
  { id: 'todo',        label: 'To Do',        accentColor: 'var(--color-todo)' },
  { id: 'in-progress', label: 'In Progress',  accentColor: 'var(--color-inprogress)' },
  { id: 'review',      label: 'Review',       accentColor: 'var(--color-review)' },
  { id: 'testing',     label: 'Testing',      accentColor: 'var(--color-testing)' },
  { id: 'done',        label: 'Done',         accentColor: 'var(--color-done)' },
];

interface BoardProps {
  tickets: Ticket[];
  allTickets: Ticket[];
  onDragEnd: (ticketId: string, newStatus: Status) => void;
  onNewTicket: () => void;
  onCardClick: (ticket: Ticket) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  activeType?: IssueType | 'all';
  onTypeChange?: (t: IssueType | 'all') => void;
  activePriority: Priority | 'all';
  onPriorityChange: (p: Priority | 'all') => void;
  projectName: string;
  projectId?: string;
  viewMode: 'board' | 'list' | 'timeline';
  onViewModeChange: (v: 'board' | 'list' | 'timeline') => void;
  members?: Member[];
  activeAssignee?: string | 'all';
  onAssigneeChange?: (id: string | 'all') => void;
  /** 'projects': project list still loading (placeholders); 'tickets': real shell, skeleton cards. */
  loadState?: 'projects' | 'tickets';
  /** Replaces the lanes (e.g. the "couldn't load" panel). */
  lanesOverride?: ReactNode;
  /** Content of the reserved status row at the top right (the loading pill). */
  statusSlot?: ReactNode;
}

const SKELETON_COUNTS = [2, 2, 1, 1, 1, 1];

const VALID_STATUSES = new Set<string>(['backlog', 'todo', 'in-progress', 'review', 'testing', 'done']);

export function Board({
  tickets,
  allTickets,
  onDragEnd,
  onNewTicket,
  onCardClick,
  searchQuery,
  onSearchChange,
  activeType = 'all',
  onTypeChange,
  activePriority,
  onPriorityChange,
  projectName,
  projectId,
  viewMode,
  onViewModeChange,
  members = [],
  activeAssignee = 'all',
  onAssigneeChange,
  loadState,
  lanesOverride,
  statusSlot,
}: BoardProps) {
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
      <div className={styles.board} aria-busy={loadState ? true : undefined}>
        <div className={styles.statusRow}>{statusSlot}</div>
        <div className={styles.topBar}>
          {loadState === 'projects' ? (
            <h1 className={styles.title} aria-label="Loading project">
              <span className={`${loadingStyles.skel} ${loadingStyles.skelTitle}`} style={{ display: 'block' }} aria-hidden="true" />
            </h1>
          ) : (
            <h1 className={styles.title}>{projectName}</h1>
          )}
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
            <button type="button" className={styles.newButton} onClick={onNewTicket} disabled={!!loadState}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'block', flexShrink: 0 }}>
                <path d="M12 5v14M5 12h14" />
              </svg>
              <span>New Ticket</span>
            </button>
          </div>
        </div>

        <div {...(loadState === 'projects' ? { inert: '' as unknown as boolean, 'aria-hidden': true, style: { opacity: 0.55 } } : {})}>
        <FilterBar
          searchQuery={searchQuery}
          onSearchChange={onSearchChange}
          activeType={activeType}
          onTypeChange={onTypeChange}
          activePriority={activePriority}
          onPriorityChange={onPriorityChange}
          members={members}
          activeAssignee={activeAssignee}
          onAssigneeChange={onAssigneeChange ?? (() => {})}
        />
        </div>

        {lanesOverride ? (
          <div className={styles.columns}>{lanesOverride}</div>
        ) : loadState === 'projects' ? (
          <div className={styles.columns} aria-hidden="true">
            {COLUMNS.map((col) => (
              <div key={col.id} className={loadingStyles.ghostLane} />
            ))}
          </div>
        ) : loadState === 'tickets' ? (
          <div className={styles.columns}>
            {COLUMNS.map((col, i) => (
              <Column
                key={col.id}
                column={col}
                tickets={[]}
                onCardClick={onCardClick}
                memberMap={memberMap}
                skeletonCards={SKELETON_COUNTS[i]}
              />
            ))}
          </div>
        ) : viewMode === 'list' ? (
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
                  allTickets={tickets}
                  onCardClick={onCardClick}
                  memberMap={memberMap}
                />
              );
            })}
          </div>
        )}
      </div>

      <DragOverlay>
        {activeTicket ? (
          <div style={{ pointerEvents: 'none', width: 280 }}>
            <TicketCard ticket={activeTicket} memberMap={memberMap} isDragging={true} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
