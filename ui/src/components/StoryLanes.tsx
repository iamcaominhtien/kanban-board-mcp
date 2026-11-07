import { useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import type { Column as ColumnType, Member, Status, Ticket } from '../types';
import { DraggableTicketCard } from './DraggableTicketCard';
import styles from './StoryLanes.module.css';

/** A cell of a lane is a drop target: `lane:<lane>:<status>`; the board reads the status from the end. */
export const LANE_DROP_PREFIX = 'lane:';

/** The status a drop target stands for: a column id, or the last part of a lane cell id. */
export function statusOfDropId(id: string): string {
  return id.startsWith(LANE_DROP_PREFIX) ? id.slice(id.lastIndexOf(':') + 1) : id;
}

/** Who is looking: the member the app acts as, or the board's own user. */
function personKey(): string {
  try {
    return localStorage.getItem('kanbanActor') || 'me';
  } catch {
    return 'me';
  }
}

const groupKey = () => `kanban.board.groupByStory.${personKey()}`;

/** Group by Story is off until someone turns it on; the choice is remembered per person. */
export function readGroupByStory(): boolean {
  try {
    return localStorage.getItem(groupKey()) === '1';
  } catch {
    return false;
  }
}

/** Remember the switch for this person. */
export function writeGroupByStory(on: boolean): void {
  try {
    if (on) localStorage.setItem(groupKey(), '1');
    else localStorage.removeItem(groupKey());
  } catch {
    /* storage unavailable: the switch lasts until the page reloads */
  }
}

// A Story that is going comes first, then the ones that wait, then the finished
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

type CellProps = Pick<
  StoryLanesProps,
  'allTickets' | 'onCardClick' | 'memberMap' | 'onReopen' | 'onPending' | 'onResume' | 'onDelete'
>;

const Chevron = ({ open }: { open: boolean }) => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="#5B6B60"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={open ? 'M6 9L12 15L18 9' : 'M9 6L15 12L9 18'} />
  </svg>
);

/**
 * The board grouped by Story: one lane per Story with the Story as its header and its sub-tickets in the board's
 * columns, so a person still reads left to right. Lanes fold. A ticket that is in no Story goes to the last lane.
 * (The Stories of the AI team of v1, with their plan and autonomy, are gone; a Story is a ticket of type Story.)
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
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setFolded((s) => {
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
  const cellProps: CellProps = { allTickets, onCardClick, memberMap, onReopen, onPending, onResume, onDelete };

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
          folded={folded.has(s.id)}
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
              aria-expanded={!folded.has('__loose')}
              aria-label={folded.has('__loose') ? 'Unfold Not in a Story' : 'Fold Not in a Story'}
              onClick={() => toggle('__loose')}
            >
              <Chevron open={!folded.has('__loose')} />
            </button>
            <b style={{ fontSize: 13.5 }}>Not in a Story</b>
            <span className={styles.hint}>
              {loose.length} ticket{loose.length === 1 ? '' : 's'}
            </span>
          </div>
          {folded.has('__loose') ? (
            <FoldedLine tickets={loose} columns={columns} />
          ) : (
            <LaneBody laneKey="__loose" tickets={loose} columns={columns} {...cellProps} />
          )}
        </>
      )}
    </div>
  );
}

function StoryLane({
  story,
  childTickets,
  columns,
  folded,
  onToggle,
  ...cellProps
}: {
  story: Ticket;
  childTickets: Ticket[];
  columns: ColumnType[];
  folded: boolean;
  onToggle: () => void;
} & CellProps) {
  // progress counts every sub-ticket of the Story, not only the ones the filters let through
  const all = cellProps.allTickets.filter((t) => t.parentId === story.id && t.type !== 'story');
  const done = all.filter((t) => t.status === 'done').length;
  const pct = all.length ? Math.round((done / all.length) * 100) : 0;
  return (
    <>
      <div className={styles.laneHead} data-testid="lane-story" data-story-id={story.id}>
        <button
          type="button"
          className={styles.iconBtn}
          aria-expanded={!folded}
          aria-label={folded ? `Unfold ${story.id}` : `Fold ${story.id}`}
          onClick={onToggle}
        >
          <Chevron open={!folded} />
        </button>
        <button
          type="button"
          className={styles.laneTitle}
          onClick={() => cellProps.onCardClick(cellProps.allTickets.find((t) => t.id === story.id) ?? story)}
        >
          {story.title}
        </button>
        <span className={styles.mono}>{story.id}</span>
        <span className={styles.hint}>{story.status.replace('-', ' ')}</span>
        <span style={{ flex: 1 }} />
        <span className={styles.bar} role="img" aria-label={`${pct}% done`}>
          <i style={{ width: `${pct}%` }} />
        </span>
        <span className={styles.progress}>
          {done} of {all.length} done
        </span>
      </div>
      {folded ? (
        <FoldedLine tickets={childTickets} columns={columns} />
      ) : (
        <LaneBody laneKey={story.id} tickets={childTickets} columns={columns} {...cellProps} />
      )}
    </>
  );
}

function FoldedLine({ tickets, columns }: { tickets: Ticket[]; columns: ColumnType[] }) {
  const parts = columns
    .map((c) => ({ c, n: tickets.filter((t) => t.status === c.id).length }))
    .filter((x) => x.n > 0)
    .map((x) => `${x.n} in ${x.c.label}`);
  return <div className={styles.collapsedLine}>Folded: {parts.length > 0 ? parts.join(' · ') : 'no tickets yet'}</div>;
}

function LaneBody({
  laneKey,
  tickets,
  columns,
  ...cellProps
}: { laneKey: string; tickets: Ticket[]; columns: ColumnType[] } & CellProps) {
  return (
    <div className={`${styles.laneGrid} ${styles.laneBody}`}>
      {columns.map((c) => (
        <LaneCell
          key={c.id}
          id={`${LANE_DROP_PREFIX}${laneKey}:${c.id}`}
          tickets={tickets
            .filter((t) => t.status === c.id)
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())}
          {...cellProps}
        />
      ))}
    </div>
  );
}

function LaneCell({
  id,
  tickets,
  allTickets,
  onCardClick,
  memberMap,
  onReopen,
  onPending,
  onResume,
  onDelete,
}: { id: string; tickets: Ticket[] } & CellProps) {
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
        />
      ))}
    </div>
  );
}
