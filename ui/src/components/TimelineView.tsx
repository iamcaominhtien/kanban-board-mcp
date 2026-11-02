import { useMemo, useState, useRef, useEffect } from 'react';
import { IdeaBulb } from './ideas/ideaLinks';
import type { Ticket } from '../types';
import { useProjectActivities, useUpdateTicket } from '../api/tickets';
import type { ActivityEvent } from '../api/tickets';
import styles from './TimelineView.module.css';

type SubMode = 'gantt' | 'events';

interface TimelineViewProps {
  tickets: Ticket[];
  projectId: string;
  onCardClick: (ticket: Ticket) => void;
}

// ─── Gantt helpers ───────────────────────────────────────────────────────────

const DAY_WIDTH = 18; // px per day
const WINDOW_DAYS = 60;
const MIN_BAR_PX = 18;

function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

function formatShortDate(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDateString(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Pending periods (TicketPending F3) and reopen markers / earlier Done spans (TicketReopen E3), from the ticket's own data
interface PendingPeriod {
  start: Date;
  end: Date;
  open: boolean;
}

function pendingPeriods(ticket: Ticket, today: Date): PendingPeriod[] {
  const out: PendingPeriod[] = [];
  let from: Date | null = null;
  const log = [...(ticket.activityLog ?? [])].sort(
    (a, b) => new Date(a.at ?? 0).getTime() - new Date(b.at ?? 0).getTime(),
  );
  for (const e of log) {
    const at = parseDate(e.at);
    if (!at) continue;
    if (e.field === 'pending_set' && !from) from = at;
    if (e.field === 'pending_cleared' && from) {
      out.push({ start: from, end: at, open: false });
      from = null;
    }
  }
  if (ticket.pending) {
    const since = from ?? parseDate(ticket.pendingSince);
    if (since) out.push({ start: since, end: today, open: true });
  }
  return out;
}

interface ReopenMark {
  at: Date;
  doneFrom: Date | null;
}

function reopenMarks(ticket: Ticket): ReopenMark[] {
  return (ticket.reopenHistory ?? [])
    .map((h) => ({
      at: parseDate(h.at),
      doneFrom: parseDate(h.previousCompletedAt),
    }))
    .filter((m): m is ReopenMark => m.at !== null);
}

// ─── Event helpers ────────────────────────────────────────────────────────────

type EventCategory = 'created' | 'status_changed' | 'commented' | 'reopened' | 'pending' | 'other';

function categorizeEvent(type: string): EventCategory {
  if (type === 'created') return 'created';
  if (type === 'commented') return 'commented';
  if (type.startsWith('changed:status')) return 'status_changed';
  if (type === 'changed:reopen') return 'reopened';
  if (type.startsWith('changed:pending')) return 'pending';
  return 'other';
}

const EVENT_STATUS_LABELS: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  'in-progress': 'In Progress',
  in_progress: 'In Progress',
  review: 'Review',
  testing: 'Testing',
  done: 'Done',
  wont_do: "Won't Do",
};

const EVENT_NAMES: Record<string, string> = {
  doc_ref_added: 'Linked a doc',
  doc_ref_removed: 'Unlinked a doc',
  reopen: 'Reopened',
  pending_set: 'Marked pending',
  pending_cleared: 'No longer pending',
  pending_prompt: 'Pending reminder',
};

function friendlyEventType(type: string): string {
  if (type === 'created') return 'Created';
  if (type === 'commented') return 'Commented';
  if (type.startsWith('changed:')) {
    const field = type.replace('changed:', '');
    return EVENT_NAMES[field] ?? `Changed ${field.replace(/_/g, ' ')}`;
  }
  return type;
}

/** Markdown and stored tokens as plain words: "@[Hoa](member:…)" is "@Hoa", "[[Data model]]" is "Data model". */
function plainText(text: string, max = 140): string {
  const t = text
    .replace(/@\[([^\]]+)\]\(member:[^)]+\)/g, '@$1')
    .replace(/\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|[^\]]+)?\]\]/g, (_m, page: string, sec?: string) =>
      sec ? `${page} › ${sec}` : page,
    )
    .replace(/!?\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/(\*\*|__|`|~~)/g, '')
    .replace(/^\s*(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** A Python list as the server writes it ("['a', 'b']") as "a, b". */
function listText(v: string): string {
  const m = /^\[(.*)\]$/.exec(v.trim());
  if (!m) return v;
  const items = m[1].match(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g) ?? [];
  return items.map((x) => x.slice(1, -1)).join(', ');
}

/** "todo → done" as "To Do → Done"; nothing at all for "None → None" (the server writes Python's None for empty). */
function friendlyEventDetail(type: string, detail: string | null | undefined): string | null {
  if (!detail || type === 'created') return null;
  if (type === 'commented') return plainText(detail) || null;
  const parts = detail.split(' → ');
  if (parts.length !== 2) return plainText(detail);
  const field = type.replace('changed:', '');
  const show = (v: string) => {
    const t = v.trim();
    if (!t || t === 'None' || t === 'null' || t === 'undefined' || t === '[]') return '';
    if (field === 'status' || field === 'reopen') return EVENT_STATUS_LABELS[t] ?? t;
    if (t.startsWith('[') && t.endsWith(']')) return listText(t);
    return plainText(t, 80);
  };
  const [from, to] = parts.map(show);
  if (!from && !to) return null;
  // a link added or removed names its page only
  if (field === 'doc_ref_added') return to ? to.replace('#', ' › ') : null;
  if (field === 'doc_ref_removed') return from ? from.replace('#', ' › ') : null;
  return `${from || 'none'} → ${to || 'none'}`;
}

function groupEventsByDate(events: ActivityEvent[]): { date: string; events: ActivityEvent[] }[] {
  const map = new Map<string, ActivityEvent[]>();
  for (const ev of events) {
    const dateKey = new Date(ev.at).toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
    if (!map.has(dateKey)) map.set(dateKey, []);
    map.get(dateKey)!.push(ev);
  }
  return Array.from(map.entries()).map(([date, evs]) => ({ date, events: evs }));
}

// ─── Gantt Chart with Edge Resizing ───────────────────────────────────────────

interface GanttProps {
  tickets: Ticket[];
  onCardClick: (ticket: Ticket) => void;
}

interface DragResizeState {
  ticketId: string;
  edge: 'start' | 'due';
  startX: number;
  initialStart: Date;
  initialDue: Date;
  currentDate: Date;
}

function GanttChart({ tickets, onCardClick }: GanttProps) {
  const updateTicketMutation = useUpdateTicket();
  const [dragResize, setDragResize] = useState<DragResizeState | null>(null);
  const dragRef = useRef<DragResizeState | null>(null);
  // The click that follows releasing a resize handle must not open the ticket (only the date changes)
  const justResized = useRef(false);
  dragRef.current = dragResize;

  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);

  // Fixed 60-day window: today - 7 to today + 53
  const rangeStart = useMemo(() => {
    const d = new Date(today);
    d.setDate(d.getDate() - 7);
    return d;
  }, [today]);

  const rangeEnd = useMemo(() => {
    const d = new Date(today);
    d.setDate(d.getDate() + 53);
    return d;
  }, [today]);

  const chartWidth = WINDOW_DAYS * DAY_WIDTH; // 1080px
  const todayLeftPx = 7 * DAY_WIDTH; // 126px

  const ganttTickets = useMemo(() => {
    return tickets
      .filter((t) => parseDate(t.startDate) || parseDate(t.dueDate))
      .filter((t) => {
        const rawStart = parseDate(t.startDate);
        const rawEnd = parseDate(t.dueDate);
        let ticketStart: Date;
        let ticketEnd: Date;
        if (rawStart && rawEnd) {
          ticketStart = rawStart <= rawEnd ? rawStart : rawEnd;
          ticketEnd = rawStart <= rawEnd ? rawEnd : rawStart;
        } else if (rawStart) {
          ticketStart = rawStart;
          ticketEnd = new Date(rawStart);
          ticketEnd.setDate(ticketEnd.getDate() + 1);
        } else {
          ticketEnd = rawEnd!;
          ticketStart = new Date(rawEnd!);
          ticketStart.setDate(ticketStart.getDate() - 1);
        }
        return ticketStart <= rangeEnd && ticketEnd >= rangeStart;
      });
  }, [tickets, rangeStart, rangeEnd]);

  // Weekly header ticks
  const headerTicks = useMemo(() => {
    const ticks: { day: number; label: string; isToday: boolean }[] = [];
    for (let i = 0; i < WINDOW_DAYS; i += 7) {
      const d = new Date(rangeStart);
      d.setDate(d.getDate() + i);
      ticks.push({
        day: i,
        label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        isToday: d.toDateString() === today.toDateString(),
      });
    }
    return ticks;
  }, [rangeStart, today]);

  // Handle pointer move & up globally during drag resize
  useEffect(() => {
    if (!dragResize) return;

    function handlePointerMove(e: PointerEvent) {
      const state = dragRef.current;
      if (!state) return;

      const deltaX = e.clientX - state.startX;
      const dayDiff = Math.round(deltaX / DAY_WIDTH);

      if (state.edge === 'start') {
        const newStart = new Date(state.initialStart);
        newStart.setDate(newStart.getDate() + dayDiff);
        // Clamp: start date cannot exceed due date - 1 day
        const maxStart = new Date(state.initialDue);
        maxStart.setDate(maxStart.getDate() - 1);
        const clamped = newStart > maxStart ? maxStart : newStart;
        setDragResize((prev) => (prev ? { ...prev, currentDate: clamped } : null));
      } else {
        const newDue = new Date(state.initialDue);
        newDue.setDate(newDue.getDate() + dayDiff);
        // Clamp: due date cannot be before start date + 1 day
        const minDue = new Date(state.initialStart);
        minDue.setDate(minDue.getDate() + 1);
        const clamped = newDue < minDue ? minDue : newDue;
        setDragResize((prev) => (prev ? { ...prev, currentDate: clamped } : null));
      }
    }

    function handlePointerUp() {
      const state = dragRef.current;
      if (state) {
        const target = tickets.find((t) => t.id === state.ticketId);
        if (target) {
          if (state.edge === 'start') {
            const newIso = formatDateString(state.currentDate);
            updateTicketMutation.mutate({
              ticketId: state.ticketId,
              data: { startDate: newIso },
            });
          } else {
            const newIso = formatDateString(state.currentDate);
            updateTicketMutation.mutate({
              ticketId: state.ticketId,
              data: { dueDate: newIso },
            });
          }
        }
      }
      setDragResize(null);
      justResized.current = true;
      window.setTimeout(() => {
        justResized.current = false;
      }, 0);
    }

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [dragResize, tickets, updateTicketMutation]);

  function startResize(
    e: React.PointerEvent,
    ticket: Ticket,
    edge: 'start' | 'due',
    currentStart: Date,
    currentDue: Date,
  ) {
    e.stopPropagation();
    e.preventDefault();
    setDragResize({
      ticketId: ticket.id,
      edge,
      startX: e.clientX,
      initialStart: currentStart,
      initialDue: currentDue,
      currentDate: edge === 'start' ? currentStart : currentDue,
    });
  }

  if (ganttTickets.length === 0) {
    return <div className={styles.emptyState}>No tickets have start or due dates set.</div>;
  }

  return (
    <>
      <div className={styles.ganttCard}>
        <div className={styles.ganttWrapper}>
          {/* LEFT: Fixed label column */}
          <div className={styles.ganttLabelCol}>
            <div className={styles.ganttLabelHeader}>Ticket</div>
            {ganttTickets.map((ticket) => {
              const isDone = ticket.status === 'done';
              return (
                <div key={ticket.id} className={styles.ganttLabelRow} onClick={() => onCardClick(ticket)}>
                  <span className={`${styles.ganttTicketId} ${isDone ? styles.ganttTicketIdDone : ''}`}>
                    {ticket.fromIdeaId && <IdeaBulb ticketId={ticket.id} ideaId={ticket.fromIdeaId} />} {ticket.id}
                  </span>
                  <span className={styles.ganttTicketTitle} title={ticket.title}>
                    {ticket.title}
                  </span>
                  {(ticket.reopenCount ?? 0) > 0 && ticket.status !== 'done' && ticket.status !== 'wont_do' && (
                    <span className={styles.ganttIconBadgeReopen} title={`Reopened ${ticket.reopenCount}x`}>
                      <svg
                        width="11"
                        height="11"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="#C77700"
                        strokeWidth="2.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                        <path d="M3 3v5h5" />
                      </svg>
                    </span>
                  )}
                  {ticket.pending && (
                    <span className={styles.ganttIconBadgePending} title="Pending">
                      <svg
                        width="11"
                        height="11"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="#5B6F86"
                        strokeWidth="2.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M8.5 5.5V18.5" />
                        <path d="M15.5 5.5V18.5" />
                      </svg>
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {/* RIGHT: Scrollable bar area */}
          <div className={styles.ganttBarArea}>
            {/* Date header */}
            <div className={styles.ganttDateHeader} style={{ width: chartWidth }}>
              {headerTicks.map((t) => (
                <div
                  key={t.day}
                  className={`${styles.ganttDateTick} ${t.isToday ? styles.ganttDateTickToday : ''}`}
                  style={{ left: t.day * DAY_WIDTH }}
                >
                  {t.label}
                </div>
              ))}
            </div>

            {/* Vertical Today Line */}
            <div className={styles.ganttTodayLine} style={{ left: todayLeftPx }} />

            {/* Bar rows */}
            {ganttTickets.map((ticket) => {
              const rawStart = parseDate(ticket.startDate);
              const rawEnd = parseDate(ticket.dueDate);

              let ticketStart: Date;
              let ticketEnd: Date;
              if (rawStart && rawEnd) {
                ticketStart = rawStart <= rawEnd ? rawStart : rawEnd;
                ticketEnd = rawStart <= rawEnd ? rawEnd : rawStart;
              } else if (rawStart) {
                ticketStart = rawStart;
                ticketEnd = new Date(rawStart);
                ticketEnd.setDate(ticketEnd.getDate() + 1);
              } else {
                ticketEnd = rawEnd!;
                ticketStart = new Date(rawEnd!);
                ticketStart.setDate(ticketStart.getDate() - 1);
              }

              const origStart = ticketStart;
              const origEnd = ticketEnd;

              // If currently resizing this ticket, adjust live date
              if (dragResize && dragResize.ticketId === ticket.id) {
                if (dragResize.edge === 'start') {
                  ticketStart = dragResize.currentDate;
                } else {
                  ticketEnd = dragResize.currentDate;
                }
              }

              // Clamp to window
              const effectiveStart = ticketStart < rangeStart ? rangeStart : ticketStart;
              const effectiveEnd = ticketEnd > rangeEnd ? rangeEnd : ticketEnd;

              const leftPx = daysBetween(rangeStart, effectiveStart) * DAY_WIDTH;
              const rawWidthPx = Math.max(daysBetween(effectiveStart, effectiveEnd), 1) * DAY_WIDTH;
              const widthPx = Math.max(rawWidthPx, MIN_BAR_PX);

              const isDone = ticket.status === 'done';
              const isOverdue =
                parseDate(ticket.dueDate) !== null &&
                parseDate(ticket.dueDate)! < today &&
                !isDone &&
                ticket.status !== 'wont_do';

              const barClass = isDone
                ? styles.ganttBarDone
                : isOverdue
                  ? styles.ganttBarOverdue
                  : styles.ganttBarNormal;

              const isDraggingThis = dragResize?.ticketId === ticket.id;
              // Where the bar started before this drag: drawn as a dashed outline (Timeline 3)
              const ghostLeft = daysBetween(rangeStart, origStart < rangeStart ? rangeStart : origStart) * DAY_WIDTH;
              const ghostWidth = Math.max(
                Math.max(
                  daysBetween(origStart < rangeStart ? rangeStart : origStart, origEnd > rangeEnd ? rangeEnd : origEnd),
                  1,
                ) * DAY_WIDTH,
                MIN_BAR_PX,
              );

              return (
                <div key={ticket.id} className={styles.ganttBarRow} style={{ width: chartWidth }}>
                  {isDraggingThis && (
                    <span
                      className={styles.ganttStartGhost}
                      style={{ left: ghostLeft, width: ghostWidth }}
                      aria-hidden="true"
                      data-testid="gantt-start-ghost"
                    />
                  )}
                  <button
                    type="button"
                    className={`${styles.ganttBar} ${barClass} ${isDraggingThis ? styles.ganttBarDragging : ''}`}
                    style={{
                      left: leftPx,
                      width: widthPx,
                    }}
                    onClick={() => {
                      if (!justResized.current) onCardClick(ticket);
                    }}
                    title={`${ticket.id} · ${ticket.title}\n${formatShortDate(ticketStart)} → ${formatShortDate(ticketEnd)}`}
                  >
                    {/* A marker too narrow for the ID shows no label (the ID is in the tooltip) */}
                    {widthPx >= 40 && <span className={styles.ganttBarLabel}>{ticket.id}</span>}

                    {/* Left Resize Handle */}
                    <div
                      className={`${styles.resizeHandle} ${styles.resizeHandleLeft} ${isDraggingThis && dragResize?.edge === 'start' ? styles.resizeHandleDragging : ''}`}
                      onPointerDown={(e) => startResize(e, ticket, 'start', ticketStart, ticketEnd)}
                      title="Drag to change start date"
                    >
                      <span className={styles.resizeGrip} />
                    </div>

                    {/* Right Resize Handle */}
                    <div
                      className={`${styles.resizeHandle} ${styles.resizeHandleRight} ${isDraggingThis && dragResize?.edge === 'due' ? styles.resizeHandleDragging : ''}`}
                      onPointerDown={(e) => startResize(e, ticket, 'due', ticketStart, ticketEnd)}
                      title="Drag to change due date"
                    >
                      <span className={styles.resizeGrip} />
                    </div>

                    {/* Dragging Tooltip */}
                    {isDraggingThis && (
                      <div
                        className={styles.dragTooltip}
                        style={{
                          left: dragResize?.edge === 'start' ? 0 : '100%',
                        }}
                      >
                        {dragResize?.edge === 'start'
                          ? `Starts ${formatShortDate(dragResize.currentDate)}`
                          : `Due ${formatShortDate(dragResize.currentDate)}`}
                      </div>
                    )}
                  </button>

                  {/* Earlier Done spans (faded) and reopen markers */}
                  {reopenMarks(ticket).map((m, i) => {
                    const px = (d: Date) => daysBetween(rangeStart, d) * DAY_WIDTH;
                    const doneLeft = m.doneFrom ? px(m.doneFrom) : null;
                    return (
                      <span key={`reopen-${i}`}>
                        {doneLeft !== null && m.at >= rangeStart && (
                          <span
                            className={styles.ganttEarlierDone}
                            style={{
                              left: Math.max(doneLeft, 0),
                              width: Math.max(px(m.at) - Math.max(doneLeft, 0), MIN_BAR_PX),
                            }}
                          >
                            Done
                          </span>
                        )}
                        {m.at >= rangeStart && m.at <= rangeEnd && (
                          <span className={styles.ganttReopenMarker} style={{ left: px(m.at) - 5 }} title="Reopened" />
                        )}
                      </span>
                    );
                  })}

                  {/* Pending bands (hatched; faded once resumed) */}
                  {pendingPeriods(ticket, today).map((p, i) => {
                    const start = p.start < rangeStart ? rangeStart : p.start;
                    const end = p.end > rangeEnd ? rangeEnd : p.end;
                    if (end < start) return null;
                    const left = daysBetween(rangeStart, start) * DAY_WIDTH;
                    const width = Math.max(daysBetween(start, end) * DAY_WIDTH, 8);
                    return (
                      <span
                        key={`pending-${i}`}
                        className={p.open ? styles.ganttPendingNow : styles.ganttPendingPast}
                        style={{ left, width }}
                        title={p.open ? 'Pending now' : 'Past pending'}
                      />
                    );
                  })}

                  {/* Overdue text notice if narrow bar */}
                  {isOverdue && widthPx <= 24 && rawEnd && (
                    <span className={styles.overdueNotice} style={{ left: leftPx + widthPx + 8 }}>
                      Due {formatShortDate(rawEnd)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Gantt Legend */}
      <div className={styles.ganttLegend}>
        <span className={styles.legendItem}>
          <span className={styles.legendDot} style={{ background: '#2F6FB0' }} />
          Normal
        </span>
        <span className={styles.legendItem}>
          <span className={styles.legendDot} style={{ background: '#C4432A' }} />
          Overdue
        </span>
        <span className={styles.legendItem}>
          <span className={styles.legendDot} style={{ background: '#68BA7F', opacity: 0.6 }} />
          Done
        </span>
        <span className={styles.legendItem}>
          <span className={styles.legendHatch} />
          Pending now
        </span>
        <span className={styles.legendItem}>
          <span className={styles.legendHatch} style={{ opacity: 0.4 }} />
          Past pending
        </span>
        <span className={styles.legendItem}>
          <span className={styles.legendReopen} />
          Reopened
        </span>
        <span className={styles.legendItem}>
          <span className={styles.legendDot} style={{ background: '#C9DDD0' }} />
          Earlier Done span
        </span>
        <span className={styles.legendItem}>
          <span className={styles.legendLine} />
          Today
        </span>
      </div>
    </>
  );
}

// ─── Event Timeline (Debug Space Rail Pattern) ───────────────────────────────

interface EventTimelineProps {
  projectId: string;
  tickets: Ticket[];
  onCardClick: (ticket: Ticket) => void;
}

function EventTimeline({ projectId, tickets, onCardClick }: EventTimelineProps) {
  const { data: events = [], isLoading, isError } = useProjectActivities(projectId);
  const ticketMap = useMemo(() => new Map(tickets.map((t) => [t.id, t])), [tickets]);

  if (isLoading) return <div className={styles.emptyState}>Loading activity…</div>;
  if (isError) return <div className={styles.emptyState}>Failed to load activity.</div>;
  if (events.length === 0) return <div className={styles.emptyState}>No activity yet for this project.</div>;

  const groups = groupEventsByDate(events);

  return (
    <div className={styles.eventTimelineCard}>
      {groups.map((group, groupIdx) => (
        <div key={group.date} className={styles.eventGroup}>
          {groupIdx > 0 && <div className={styles.eventDivider} />}
          <div className={styles.eventGroupDate}>{group.date}</div>

          <div className={styles.eventItems}>
            {group.events.map((ev, idx) => {
              const ticket = ticketMap.get(ev.ticketId);
              const category = categorizeEvent(ev.eventType);
              const time = new Date(ev.at).toLocaleTimeString('en-US', {
                hour: 'numeric',
                minute: '2-digit',
              });

              return (
                <div key={`${ev.ticketId}-${ev.at}-${idx}`} className={styles.dbgItem}>
                  <div className={styles.dbgRail}>
                    <span
                      className={styles.dbgDot}
                      style={{
                        background:
                          category === 'created'
                            ? '#2E6F40'
                            : category === 'status_changed'
                              ? '#2F6FB0'
                              : category === 'commented'
                                ? '#6D5DD3'
                                : category === 'reopened'
                                  ? '#B4791E'
                                  : category === 'pending'
                                    ? '#5B6B80'
                                    : '#9AA8A0',
                      }}
                    >
                      {category === 'created' && (
                        <svg
                          width="7"
                          height="7"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="#FFFFFF"
                          strokeWidth="3"
                          strokeLinecap="round"
                        >
                          <path d="M12 5V19M5 12H19" />
                        </svg>
                      )}
                      {category === 'status_changed' && (
                        <svg
                          width="7"
                          height="7"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="#FFFFFF"
                          strokeWidth="2.6"
                          strokeLinecap="round"
                        >
                          <path d="M4 4V10H10M4 10L8 6.5A8 8 0 1 1 4 14" />
                        </svg>
                      )}
                      {category === 'commented' && (
                        <svg
                          width="7"
                          height="7"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="#FFFFFF"
                          strokeWidth="2.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M21 15A2 2 0 0 1 19 17H7L3 21V5A2 2 0 0 1 5 3H19A2 2 0 0 1 21 5Z" />
                        </svg>
                      )}
                      {(category === 'other' || category === 'reopened' || category === 'pending') && (
                        <span style={{ width: 3, height: 3, borderRadius: '50%', background: '#FFFFFF' }} />
                      )}
                    </span>
                    <span className={styles.dbgLine} />
                  </div>

                  <div className={styles.eventBody}>
                    <div className={styles.eventHeaderRow}>
                      <button
                        type="button"
                        className={styles.eventTicketChip}
                        onClick={() => ticket && onCardClick(ticket)}
                        disabled={!ticket}
                      >
                        {ev.ticketId}
                      </button>
                      <span className={styles.eventTicketTitle}>{ev.ticketTitle}</span>
                      <span className={styles.eventTime}>{time}</span>
                    </div>

                    <div className={styles.eventActionDesc}>
                      {friendlyEventType(ev.eventType)}
                      {friendlyEventDetail(ev.eventType, ev.detail) && (
                        <span className={styles.eventDetailDim}> — {friendlyEventDetail(ev.eventType, ev.detail)}</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

/**
 * Timeline of tickets over time.
 * @param props.projectId - Project the timeline belongs to.
 * @param props.onCardClick - Called with the clicked ticket.
 */
export function TimelineView({ tickets, projectId, onCardClick }: TimelineViewProps) {
  const [subMode, setSubMode] = useState<SubMode>('gantt');

  return (
    <div className={styles.container}>
      <div className={styles.subModeSwitcher}>
        <button
          type="button"
          className={`${styles.subModeBtn} ${subMode === 'gantt' ? styles.subModeBtnActive : ''}`}
          onClick={() => setSubMode('gantt')}
        >
          Gantt
        </button>
        <button
          type="button"
          className={`${styles.subModeBtn} ${subMode === 'events' ? styles.subModeBtnActive : ''}`}
          onClick={() => setSubMode('events')}
        >
          Event Timeline
        </button>
      </div>

      {subMode === 'gantt' ? (
        <GanttChart tickets={tickets} onCardClick={onCardClick} />
      ) : (
        <EventTimeline projectId={projectId} tickets={tickets} onCardClick={onCardClick} />
      )}
    </div>
  );
}
