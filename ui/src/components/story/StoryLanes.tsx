import { useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import type { Column as ColumnType, Member, Status, Ticket } from '../../types';
import { DraggableTicketCard } from '../DraggableTicketCard';
import { useStoryOf } from './StoryCard';
import { Ico, RoleBadge, StoryBar, StoryStateChip, storyFace } from './storyUi';
import styles from './story.module.css';

/** A cell of a lane is a drop target: `lane:<lane>:<status>`; the board reads the status from the end. */
export const LANE_DROP_PREFIX = 'lane:';

/** The status a drop target stands for: a column id, or the last part of a lane cell id. */
export function statusOfDropId(id: string): string {
  return id.startsWith(LANE_DROP_PREFIX) ? id.slice(id.lastIndexOf(':') + 1) : id;
}

const LANE_ORDER: Record<string, number> = {
  'in-progress': 0,
  testing: 1,
  review: 2,
  todo: 3,
  backlog: 4,
  done: 5,
};

interface StoryLanesProps {
  columns: ColumnType[];
  /** The tickets the filters let through. */
  tickets: Ticket[];
  allTickets: Ticket[];
  onCardClick: (ticket: Ticket) => void;
  memberMap?: Map<string, Member>;
  onReopen?: (ticket: Ticket) => void;
  onPending?: (ticket: Ticket) => void;
  onResume?: (ticket: Ticket) => void;
  onDelete?: (ticket: Ticket) => void;
}

/**
 * The board grouped by Story (design/screens/ai-story-flow.md D): one lane per Story with the Story as its header and
 * its children in the board's six columns, so a person still reads left to right. Lanes collapse. A Draft has no
 * children yet and shows as a lane header in Backlog. Tickets without a Story go to the last lane.
 */
export function StoryLanes({
  columns,
  tickets,
  allTickets,
  onCardClick,
  memberMap,
  onReopen,
  onPending,
  onResume,
  onDelete,
}: StoryLanesProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const shownIds = new Set(tickets.map((t) => t.id));
  const storyIds = new Set(allTickets.filter((t) => t.type === 'story').map((t) => t.id));
  const cards = tickets.filter((t) => t.type !== 'story');
  const childrenOf = (id: string) => cards.filter((t) => t.parentId === id);

  const stories = allTickets
    .filter((t) => t.type === 'story' && t.status !== 'wont_do')
    .filter((s) => shownIds.has(s.id) || childrenOf(s.id).length > 0)
    .sort(
      (a, b) =>
        (LANE_ORDER[a.status] ?? 9) - (LANE_ORDER[b.status] ?? 9) ||
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  const loose = cards.filter((t) => !t.parentId || !storyIds.has(t.parentId));

  const cellProps = { allTickets, onCardClick, memberMap, onReopen, onPending, onResume, onDelete };

  return (
    <div className={styles.lanes} data-testid="story-lanes">
      <div className={`${styles.laneGrid} ${styles.laneCols}`}>
        {columns.map((c) => (
          <div key={c.id} className={styles.laneColHead}>
            <b>{c.label}</b>
            <span className={styles.hint}>{cards.filter((t) => t.status === c.id).length}</span>
          </div>
        ))}
      </div>

      {stories.map((s) => (
        <StoryLane
          key={s.id}
          story={s}
          childTickets={childrenOf(s.id)}
          columns={columns}
          collapsed={collapsed.has(s.id)}
          onToggle={() => toggle(s.id)}
          {...cellProps}
        />
      ))}

      {loose.length > 0 && (
        <>
          <div className={`${styles.laneHead} ${styles.laneHeadLoose}`} data-testid="lane-loose">
            <button
              type="button"
              className={styles.iconBtn}
              style={{ width: 22, height: 22 }}
              aria-expanded={!collapsed.has('__loose')}
              aria-label={collapsed.has('__loose') ? 'Unfold Not in a Story' : 'Fold Not in a Story'}
              onClick={() => toggle('__loose')}
            >
              <Ico name={collapsed.has('__loose') ? 'right' : 'down'} size={15} color="#5B6B60" width={2} />
            </button>
            <b style={{ fontSize: 13.5 }}>Not in a Story</b>
            <span className={styles.hint}>
              {loose.length} ticket{loose.length === 1 ? '' : 's'}
            </span>
          </div>
          {collapsed.has('__loose') ? (
            <CollapsedLine tickets={loose} columns={columns} />
          ) : (
            <LaneBody laneKey="__loose" tickets={loose} columns={columns} {...cellProps} />
          )}
        </>
      )}
    </div>
  );
}

type CellProps = Pick<
  StoryLanesProps,
  'allTickets' | 'onCardClick' | 'memberMap' | 'onReopen' | 'onPending' | 'onResume' | 'onDelete'
>;

function StoryLane({
  story: ticket,
  childTickets,
  columns,
  collapsed,
  onToggle,
  ...cellProps
}: {
  story: Ticket;
  childTickets: Ticket[];
  columns: ColumnType[];
  collapsed: boolean;
  onToggle: () => void;
} & CellProps) {
  const story = useStoryOf(ticket, cellProps.allTickets);
  const face = storyFace(story);
  const needsYou = face === 'blocked' || face === 'plan_needs_you';
  const draft = face === 'draft' && childTickets.length === 0;

  const header = (
    <div className={styles.laneHead} data-testid="lane-story" data-story-id={ticket.id}>
      {!draft && (
        <button
          type="button"
          className={styles.iconBtn}
          style={{ width: 22, height: 22 }}
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Unfold ${ticket.id}` : `Fold ${ticket.id}`}
          onClick={onToggle}
        >
          <Ico name={collapsed ? 'right' : 'down'} size={15} color="#1B3A6B" width={2} />
        </button>
      )}
      <Ico name="story" size={15} color="#1B3A6B" width={2} />
      <button
        type="button"
        className={styles.laneTitle}
        onClick={() => {
          const latest = cellProps.allTickets.find((t) => t.id === ticket.id) ?? ticket;
          cellProps.onCardClick(latest);
        }}
      >
        {story.title || ticket.title}
      </button>
      <span className={styles.mono}>{ticket.id}</span>
      <StoryStateChip face={face} />
      <span style={{ flex: 1 }} />
      {draft ? (
        // D: a Draft has the same full-width header; it simply has no tickets yet
        <span className={styles.hint} data-testid="lane-empty">
          0 tickets yet
        </span>
      ) : (
        <>
          {needsYou && <span style={{ fontSize: 11.5, color: '#A5321E', fontWeight: 600 }}>Needs you</span>}
          <StoryBar story={story} width={110} />
          <span style={{ fontSize: 12, color: '#3A4A3E', width: 92, flexShrink: 0 }}>
            {story.progress.done} of {story.progress.total} done
          </span>
        </>
      )}
      <RoleBadge role="pm" size={22} title={story.pm?.name ?? 'PM'} />
    </div>
  );

  if (draft) return header;

  return (
    <>
      {header}
      {collapsed ? (
        <CollapsedLine tickets={childTickets} columns={columns} />
      ) : (
        <LaneBody laneKey={ticket.id} tickets={childTickets} columns={columns} hideStoryChip {...cellProps} />
      )}
    </>
  );
}

function CollapsedLine({ tickets, columns }: { tickets: Ticket[]; columns: ColumnType[] }) {
  const parts = columns
    .map((c) => ({ c, n: tickets.filter((t) => t.status === c.id).length }))
    .filter((x) => x.n > 0)
    .map((x) => `${x.n} in ${x.c.label}`);
  return (
    <div className={styles.collapsedLine}>Collapsed: {parts.length > 0 ? parts.join(' · ') : 'no tickets yet'}</div>
  );
}

function LaneBody({
  laneKey,
  tickets,
  columns,
  hideStoryChip,
  ...cellProps
}: {
  laneKey: string;
  tickets: Ticket[];
  columns: ColumnType[];
  hideStoryChip?: boolean;
} & CellProps) {
  return (
    <div className={`${styles.laneGrid} ${styles.laneBody}`}>
      {columns.map((c) => (
        <LaneCell
          key={c.id}
          id={`${LANE_DROP_PREFIX}${laneKey}:${c.id}`}
          tickets={tickets
            .filter((t) => t.status === c.id)
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())}
          hideStoryChip={hideStoryChip}
          {...cellProps}
        />
      ))}
    </div>
  );
}

function LaneCell({
  id,
  tickets,
  hideStoryChip,
  allTickets,
  onCardClick,
  memberMap,
  onReopen,
  onPending,
  onResume,
  onDelete,
}: { id: string; tickets: Ticket[]; hideStoryChip?: boolean } & CellProps) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={`${styles.laneCell} ${isOver ? styles.laneCellOver : ''}`}
      data-status={id.slice(id.lastIndexOf(':') + 1) as Status}
    >
      {tickets.map((t) => (
        <DraggableTicketCard
          key={t.id}
          ticket={t}
          allTickets={allTickets}
          onCardClick={onCardClick}
          memberMap={memberMap}
          onReopen={onReopen}
          onPending={onPending}
          onResume={onResume}
          onDelete={onDelete}
          hideStoryChip={hideStoryChip}
        />
      ))}
    </div>
  );
}
