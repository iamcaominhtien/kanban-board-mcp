import { useMemo, useState, useRef, useEffect } from 'react';
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

// ─── Event helpers ────────────────────────────────────────────────────────────

type EventCategory = 'created' | 'status_changed' | 'commented' | 'other';

function categorizeEvent(type: string): EventCategory {
  if (type === 'created') return 'created';
  if (type === 'commented') return 'commented';
  if (type.startsWith('changed:status')) return 'status_changed';
  return 'other';
}

function friendlyEventType(type: string): string {
  if (type === 'created') return 'Created';
  if (type === 'commented') return 'Commented';
  if (type.startsWith('changed:')) {
    const field = type.replace('changed:', '').replace(/_/g, ' ');
    return `Changed ${field}`;
  }
  return type;
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
                    {ticket.id}
                  </span>
                  <span className={styles.ganttTicketTitle} title={ticket.title}>
                    {ticket.title}
                  </span>
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

              return (
                <div key={ticket.id} className={styles.ganttBarRow} style={{ width: chartWidth }}>
                  <button
                    type="button"
                    className={`${styles.ganttBar} ${barClass}`}
                    style={{
                      left: leftPx,
                      width: widthPx,
                    }}
                    onClick={() => onCardClick(ticket)}
                    title={`${ticket.title}\n${formatShortDate(ticketStart)} → ${formatShortDate(ticketEnd)}`}
                  >
                    <span className={styles.ganttBarLabel}>{ticket.id}</span>

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
                hour: '2-digit',
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
                      {category === 'other' && (
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
                      {ev.detail && ev.eventType !== 'created' && (
                        <span className={styles.eventDetailDim}> — {ev.detail}</span>
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
