import { useMemo, useRef, useState, type ReactNode } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  defaultDropAnimationSideEffects,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent, DragStartEvent, DropAnimation } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import type { Column as ColumnType, IssueType, Member, Priority, Status, Ticket } from '../types';
import { Column } from './Column';
import { FilterBar } from './FilterBar';
import type { WorkflowFilterState } from '../types/aiWorkflowBoard';
import type { WorkflowFilterOptions } from './workflowBoard/workflowFilter';
import { ListView } from './ListView';
import { TimelineView } from './TimelineView';
import { DocsSpace } from './docs/DocsSpace';
import { AiTeamView } from './aiteam/AiTeamView';
import { useTeamNow } from '../api/aiTeam';
import { SchedulesTab } from './schedules/SchedulesTab';
import { CalendarIcon } from './schedules/schedulesUi';
import { useScheduleList } from '../api/schedules';
import { TicketCard } from './TicketCard';
import { ParentGroupLinks } from './ParentGroupLinks';
import { StoryLanes, statusOfDropId } from './story/StoryLanes';
import { GiveStoryDialog } from './story/GiveStoryDialog';
import { readGroupByStory, writeGroupByStory } from './story/storyLinks';
import styles from './Board.module.css';
import loadingStyles from './AppLoading.module.css';

const COLUMNS: ColumnType[] = [
  { id: 'backlog', label: 'Backlog', accentColor: 'var(--color-backlog)' },
  { id: 'todo', label: 'To Do', accentColor: 'var(--color-todo)' },
  { id: 'in-progress', label: 'In Progress', accentColor: 'var(--color-inprogress)' },
  { id: 'review', label: 'Review', accentColor: 'var(--color-review)' },
  { id: 'testing', label: 'Testing', accentColor: 'var(--color-testing)' },
  { id: 'done', label: 'Done', accentColor: 'var(--color-done)' },
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
  viewMode: 'board' | 'list' | 'timeline' | 'docs' | 'schedules' | 'ai_team';
  onViewModeChange: (v: 'board' | 'list' | 'timeline' | 'docs' | 'schedules' | 'ai_team') => void;
  /** AI Team view: open an AI member's page (fix its connection) and a Docs page (review its proposals). */
  onOpenAiMember?: (memberId: string) => void;
  onOpenDocsPage?: (pageId: string) => void;
  /** Docs view: a page to open (from a ticket's linked docs or a ?docs= link). */
  docsRequestedPageId?: string | null;
  onDocsRequestHandled?: () => void;
  /** Docs view: opens Settings (Docs turned off). */
  onOpenSettings?: () => void;
  members?: Member[];
  activeAssignee?: string | 'all';
  onAssigneeChange?: (id: string | 'all') => void;
  /** 'projects': project list still loading (placeholders); 'tickets': real shell, skeleton cards. */
  loadState?: 'projects' | 'tickets';
  /** Replaces the lanes (e.g. the "couldn't load" panel). */
  lanesOverride?: ReactNode;
  /** Content of the reserved status row at the top right (the loading pill). */
  statusSlot?: ReactNode;
  /** A notice shown over the board under the filter bar (the blocked-drag confirmation, Main Board 4). */
  boardNotice?: ReactNode;
  /** Extra controls at the left of the view switcher (Board health, Ask AI, the bell). */
  headerExtra?: ReactNode;
  /** Controls in the right action group, next to New Ticket (“Pause all AI” / “AI paused | Resume…”). */
  headerActions?: ReactNode;
  /** A banner under the top bar that pushes the page down (the AI paused banner). */
  topBanner?: ReactNode;
  filterReopened?: boolean;
  onFilterReopenedChange?: (val: boolean) => void;
  filterPending?: boolean;
  onFilterPendingChange?: (val: boolean) => void;
  hidePending?: boolean;
  onHidePendingChange?: (val: boolean) => void;
  reopenedCount?: number;
  pendingCount?: number;
  totalReopens30d?: number;
  waitingOnTicketsCount?: number;
  waitingOnPersonsCount?: number;
  fromIdeaCount?: number;
  filterFromIdea?: boolean;
  onFilterFromIdeaChange?: (val: boolean) => void;
  workflowOptions?: WorkflowFilterOptions;
  workflowFilter?: WorkflowFilterState;
  onWorkflowFilterChange?: (f: WorkflowFilterState) => void;
  onReopen?: (ticket: Ticket) => void;
  onPending?: (ticket: Ticket) => void;
  onResume?: (ticket: Ticket) => void;
  onDelete?: (ticket: Ticket) => void;
}

const SKELETON_COUNTS = [2, 2, 1, 1, 1, 1];

/** Drop: a small overshoot (105 %), then the card eases to rest in 220 ms (Drag & Drop 1, "Dropped"). */
const DROP_ANIMATION: DropAnimation = {
  duration: 220,
  easing: 'cubic-bezier(.4,0,.2,1)',
  keyframes: ({ transform: { initial, final } }) => [
    { transform: CSS.Transform.toString(initial) },
    { transform: CSS.Transform.toString({ ...final, scaleX: 1.05, scaleY: 1.05 }), offset: 0.55 },
    { transform: CSS.Transform.toString(final) },
  ],
  sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: '0.75' } } }),
};

const VALID_STATUSES = new Set<string>(['backlog', 'todo', 'in-progress', 'review', 'testing', 'done']);

/**
 * Kanban board with drag-and-drop columns.
 */
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
  docsRequestedPageId,
  onDocsRequestHandled,
  onOpenSettings,
  onOpenAiMember,
  onOpenDocsPage,
  members = [],
  activeAssignee = 'all',
  onAssigneeChange,
  loadState,
  lanesOverride,
  statusSlot,
  boardNotice,
  headerExtra,
  headerActions,
  topBanner,
  filterReopened,
  onFilterReopenedChange,
  filterPending,
  onFilterPendingChange,
  hidePending,
  onHidePendingChange,
  reopenedCount,
  pendingCount,
  fromIdeaCount,
  filterFromIdea,
  onFilterFromIdeaChange,
  workflowOptions,
  workflowFilter,
  onWorkflowFilterChange,
  totalReopens30d,
  waitingOnTicketsCount,
  waitingOnPersonsCount,
  onReopen,
  onPending,
  onResume,
  onDelete,
}: BoardProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const [activeTicketId, setActiveTicketId] = useState<string | null>(null);
  // The lifted card keeps the footprint of the card it was picked from (Drag & Drop 1, comp-1 DD-1)
  const [activeWidth, setActiveWidth] = useState<number | null>(null);
  // Group by Story (ai-story-flow D): off until someone turns it on, remembered per person
  const [groupByStory, setGroupByStory] = useState(readGroupByStory);
  const [givingStory, setGivingStory] = useState(false);
  const toggleGroupByStory = (on: boolean) => {
    setGroupByStory(on);
    writeGroupByStory(on);
  };
  const activeTicket = allTickets.find((t) => t.id === activeTicketId) ?? null;
  const dragKind: 'reopen' | 'pending' | null = !activeTicket
    ? null
    : activeTicket.status === 'done' || activeTicket.status === 'wont_do'
      ? 'reopen'
      : activeTicket.pending
        ? 'pending'
        : null;
  const memberMap = new Map(members.map((m) => [m.id, m]));

  // Sub-task Grouping 1 (comp-1 BG-1): pointing at a parent (or focusing it) shows its group: a ring on it and its
  // sub-tickets, and connectors to them. A click still opens the ticket at once, as it always did.
  const columnsRef = useRef<HTMLDivElement>(null);
  const [selectedParentId, setSelectedParentId] = useState<string | null>(null);
  const childrenOf = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const t of allTickets) {
      if (!t.parentId) continue;
      map.set(t.parentId, [...(map.get(t.parentId) ?? []), t.id]);
    }
    return map;
  }, [allTickets]);
  const selectedChildIds = useMemo(
    () =>
      selectedParentId ? (childrenOf.get(selectedParentId) ?? []).filter((id) => tickets.some((t) => t.id === id)) : [],
    [selectedParentId, childrenOf, tickets],
  );
  const selectedGroup = useMemo(
    () => (selectedParentId && selectedChildIds.length ? new Set([selectedParentId, ...selectedChildIds]) : null),
    [selectedParentId, selectedChildIds],
  );
  /** The parent card under the pointer or the focus, if any (a story card is not a group). */
  function showGroupFor(target: EventTarget | null) {
    if (activeTicketId) return setSelectedParentId(null);
    const id = (target as HTMLElement | null)?.closest?.('[data-ticket-id]')?.getAttribute('data-ticket-id') ?? null;
    const t = id ? tickets.find((x) => x.id === id) : undefined;
    const isParent = !!t && t.type !== 'story' && (childrenOf.get(t.id)?.length ?? 0) > 0;
    setSelectedParentId(isParent ? t!.id : null);
  }
  function handleBoardCardClick(t: Ticket) {
    setSelectedParentId(null);
    onCardClick(t);
  }
  function handleBoardCardOpen(t: Ticket) {
    setSelectedParentId(null);
    onCardClick(t);
  }
  // Schedules that will run in the next 24 hours (badge on the tab)
  const { data: scheduleList } = useScheduleList(projectId ?? '');
  // The AI Team view exists for a project with AI members; its badge counts what waits for a person
  const hasAiTeam = members.some((m) => m.kind === 'ai');
  const teamNow = useTeamNow(hasAiTeam ? (projectId ?? '') : '', 'today');
  const waitingForYou = teamNow.data?.needsYou.length ?? 0;

  function handleDragStart(event: DragStartEvent) {
    setSelectedParentId(null);
    setActiveTicketId(event.active.id as string);
    setActiveWidth(event.active.rect.current.initial?.width ?? null);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    // A lane cell of the board grouped by Story is `lane:<lane>:<status>`
    const status = over ? statusOfDropId(String(over.id)) : '';
    if (!over || !VALID_STATUSES.has(status)) {
      setActiveTicketId(null);
      return;
    }
    setActiveTicketId(null);
    onDragEnd(active.id as string, status as Status);
  }

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className={styles.board} aria-busy={loadState ? true : undefined}>
        <div className={styles.statusRow}>{statusSlot}</div>
        <div className={styles.topBar}>
          {loadState === 'projects' ? (
            <h1 className={styles.title} aria-label="Loading project">
              <span
                className={`${loadingStyles.skel} ${loadingStyles.skelTitle}`}
                style={{ display: 'block' }}
                aria-hidden="true"
              />
            </h1>
          ) : (
            <h1 className={styles.title} title={projectName}>
              {projectName}
            </h1>
          )}
          <div className={styles.topBarRight}>
            {headerExtra}
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
              <button
                type="button"
                className={`${styles.viewBtn} ${viewMode === 'docs' ? styles.viewBtnActive : ''}`}
                onClick={() => onViewModeChange('docs')}
                data-testid="view-docs"
              >
                Docs
              </button>
              {hasAiTeam && (
                <button
                  type="button"
                  className={`${styles.viewBtn} ${viewMode === 'ai_team' ? styles.viewBtnActive : ''}`}
                  onClick={() => onViewModeChange('ai_team')}
                  data-testid="view-ai-team"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#7C5CD6"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
                  </svg>
                  AI Team
                  {waitingForYou > 0 && (
                    <span
                      data-testid="ai-team-badge"
                      title="Things waiting for you"
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 10.5,
                        fontWeight: 700,
                        color: '#253D2C',
                        background: '#E8B93A',
                        padding: '0 5px',
                        borderRadius: 999,
                      }}
                    >
                      {waitingForYou}
                    </span>
                  )}
                </button>
              )}
              <button
                type="button"
                className={`${styles.viewBtn} ${viewMode === 'schedules' ? styles.viewBtnActive : ''}`}
                onClick={() => onViewModeChange('schedules')}
                data-testid="view-schedules"
                title="Count = schedules that will run in the next 24 hours"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                <CalendarIcon size={13} />
                Schedules
                {scheduleList && (
                  <span
                    data-testid="schedules-badge"
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 10,
                      fontWeight: 700,
                      color: '#2E6F40',
                      background: '#DCEEE1',
                      padding: '1px 6px',
                      borderRadius: 999,
                    }}
                  >
                    {scheduleList.next24H}
                  </span>
                )}
              </button>
            </div>
            {projectId && hasAiTeam && (
              <button
                type="button"
                className={styles.storyButton}
                onClick={() => setGivingStory(true)}
                disabled={!!loadState}
                title="Hand a job to the PM: it plans it, splits it into tickets and runs them"
                data-testid="give-story"
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  style={{ display: 'block', flexShrink: 0 }}
                >
                  <path d="M6.5 3h11a1 1 0 0 1 1 1v17l-6.5-4.2L5.5 21V4a1 1 0 0 1 1-1z" />
                </svg>
                <span>Give a Story</span>
              </button>
            )}
            {headerActions}
            <button type="button" className={styles.newButton} onClick={onNewTicket} disabled={!!loadState}>
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                style={{ display: 'block', flexShrink: 0 }}
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
              <span>New Ticket</span>
            </button>
          </div>
        </div>

        {topBanner}

        <div
          {...(loadState === 'projects'
            ? { inert: '' as unknown as boolean, 'aria-hidden': true, style: { opacity: 0.55 } }
            : {})}
        >
          {viewMode !== 'docs' && viewMode !== 'schedules' && viewMode !== 'ai_team' && (
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
              filterReopened={filterReopened}
              onFilterReopenedChange={onFilterReopenedChange}
              filterPending={filterPending}
              onFilterPendingChange={onFilterPendingChange}
              hidePending={hidePending}
              onHidePendingChange={onHidePendingChange}
              reopenedCount={reopenedCount}
              pendingCount={pendingCount}
              totalReopens30d={totalReopens30d}
              waitingOnTicketsCount={waitingOnTicketsCount}
              waitingOnPersonsCount={waitingOnPersonsCount}
              fromIdeaCount={fromIdeaCount}
              filterFromIdea={filterFromIdea}
              onFilterFromIdeaChange={onFilterFromIdeaChange}
              workflowOptions={workflowOptions}
              workflowFilter={workflowFilter}
              onWorkflowFilterChange={onWorkflowFilterChange}
              groupByStory={viewMode === 'board' ? groupByStory : undefined}
              onGroupByStoryChange={toggleGroupByStory}
            />
          )}
        </div>

        {boardNotice && (
          <div className={styles.noticeAnchor}>
            <div className={styles.notice}>{boardNotice}</div>
          </div>
        )}

        {viewMode === 'docs' && projectId && !loadState ? (
          <DocsSpace
            projectId={projectId}
            projectName={projectName}
            requestedPageId={docsRequestedPageId}
            onRequestHandled={onDocsRequestHandled}
            onOpenSettings={onOpenSettings}
            onBack={() => onViewModeChange('board')}
            onOpenTicket={(id) => {
              const t = allTickets.find((x) => x.id === id);
              if (t) onCardClick(t);
            }}
          />
        ) : viewMode === 'ai_team' && projectId && !loadState ? (
          <AiTeamView
            projectId={projectId}
            projectName={projectName}
            onOpenTicket={(id) => {
              const t = allTickets.find((x) => x.id === id);
              if (t) onCardClick(t);
            }}
            onOpenMember={(id) => onOpenAiMember?.(id)}
            onOpenDocsPage={(id) => onOpenDocsPage?.(id)}
          />
        ) : viewMode === 'schedules' && projectId && !loadState ? (
          <SchedulesTab projectId={projectId} tickets={allTickets} />
        ) : lanesOverride ? (
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
          <ListView tickets={tickets} members={members} onCardClick={onCardClick} />
        ) : viewMode === 'timeline' ? (
          <TimelineView tickets={tickets} projectId={projectId ?? ''} onCardClick={onCardClick} />
        ) : groupByStory ? (
          <StoryLanes
            columns={COLUMNS}
            tickets={tickets}
            allTickets={allTickets}
            onCardClick={onCardClick}
            memberMap={memberMap}
            onReopen={onReopen}
            onPending={onPending}
            onResume={onResume}
            onDelete={onDelete}
          />
        ) : (
          <div
            ref={columnsRef}
            className={styles.columns}
            onMouseOver={(e) => showGroupFor(e.target)}
            onMouseLeave={() => setSelectedParentId(null)}
            onFocus={(e) => showGroupFor(e.target)}
            onBlur={() => setSelectedParentId(null)}
          >
            {selectedGroup && selectedParentId && (
              <ParentGroupLinks
                containerRef={columnsRef}
                parentId={selectedParentId}
                childIds={selectedChildIds}
                version={tickets}
              />
            )}
            {COLUMNS.map((col) => {
              const colTickets = tickets.filter((t) => t.status === col.id);
              return (
                <Column
                  key={col.id}
                  column={col}
                  tickets={colTickets}
                  allTickets={allTickets}
                  onCardClick={handleBoardCardClick}
                  onCardOpen={handleBoardCardOpen}
                  selectedGroup={selectedGroup}
                  memberMap={memberMap}
                  onReopen={onReopen}
                  onPending={onPending}
                  onResume={onResume}
                  onDelete={onDelete}
                  dragKind={dragKind}
                />
              );
            })}
          </div>
        )}
      </div>

      <DragOverlay dropAnimation={DROP_ANIMATION}>
        {activeTicket ? (
          <div style={{ pointerEvents: 'none', width: activeWidth ?? 188, position: 'relative' }}>
            {dragKind && (
              <span className={dragKind === 'reopen' ? styles.dragLabelReopen : styles.dragLabelPending}>
                {dragKind === 'reopen' ? 'Reopen' : 'Still pending'}
              </span>
            )}
            <TicketCard ticket={activeTicket} memberMap={memberMap} isDragging={true} />
          </div>
        ) : null}
      </DragOverlay>
      {givingStory && projectId && <GiveStoryDialog projectId={projectId} onClose={() => setGivingStory(false)} />}
    </DndContext>
  );
}
