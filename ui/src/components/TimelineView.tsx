import { useEffect, useMemo, useRef, useState } from 'react';
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
const ROW_HEIGHT = 48;
const BAR_HEIGHT = 14;
const MIN_BAR_PX = 12;

function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// UTC-safe day math for the drag-to-resize interaction: dates parsed from
// "YYYY-MM-DD" strings are UTC midnight (see parseDate), so we keep the
// arithmetic in UTC and re-serialize the same way to avoid local-timezone
// off-by-one drift.
function addDaysUTC(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

function formatISODateUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ─── Event helpers ────────────────────────────────────────────────────────────

type EventCategory = 'created' | 'status_changed' | 'commented' | 'other';

function categorizeEvent(type: string): EventCategory {
  if (type === 'created') return 'created';
  if (type === 'commented') return 'commented';
  if (type.startsWith('changed:status')) return 'status_changed';
  return 'other';
}

const EVENT_COLORS: Record<EventCategory, string> = {
  created: 'var(--color-lime)',
  status_changed: 'var(--color-orange)',
  commented: 'var(--color-blue)',
  other: 'var(--color-border-strong)',
};

const EVENT_ICONS: Record<EventCategory, string> = {
  created: '✦',
  status_changed: '⟳',
  commented: '◎',
  other: '·',
};

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

// ─── Gantt ────────────────────────────────────────────────────────────────────

interface GanttProps {
  tickets: Ticket[];
  onCardClick: (ticket: Ticket) => void;
}

interface DragOrigin {
  ticketId: string;
  edge: 'start' | 'end';
  startX: number;
  origStart: Date;
  origEnd: Date;
}

interface DragPreview {
  ticketId: string;
  edge: 'start' | 'end';
  deltaDays: number;
}

function GanttChart({ tickets, onCardClick }: GanttProps) {
  const updateTicket = useUpdateTicket();
  // Mutable drag origin (avoids re-subscribing window listeners on every
  // pointermove) + a small bit of state so the dragged bar re-renders live.
  // `deltaDaysRef` mirrors the latest pointermove delta synchronously, so
  // pointerup/pointercancel can read the final value directly (without going
  // through a setState updater, which React.StrictMode double-invokes in dev
  // and would otherwise fire the mutation twice per drag).
  const dragRef = useRef<DragOrigin | null>(null);
  const deltaDaysRef = useRef(0);
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null);
  // Guards against a click firing on the bar right after a resize-drag ends
  // (the browser dispatches `click` on the common ancestor of pointerdown/up
  // targets, which is the bar button itself when the pointer drifts off the
  // handle during the drag).
  const justDraggedRef = useRef(false);
  const mutateRef = useRef(updateTicket.mutate);
  mutateRef.current = updateTicket.mutate;

  useEffect(() => {
    function onPointerMove(e: PointerEvent) {
      const origin = dragRef.current;
      if (!origin) return;
      const deltaDays = Math.round((e.clientX - origin.startX) / DAY_WIDTH);
      deltaDaysRef.current = deltaDays;
      setDragPreview({ ticketId: origin.ticketId, edge: origin.edge, deltaDays });
    }
    function finishDrag(commit: boolean) {
      const origin = dragRef.current;
      if (!origin) return;
      dragRef.current = null;
      const deltaDays = deltaDaysRef.current;
      deltaDaysRef.current = 0;

      if (commit && deltaDays !== 0) {
        const MIN_DURATION_DAYS = 1;
        if (origin.edge === 'start') {
          const maxStart = addDaysUTC(origin.origEnd, -MIN_DURATION_DAYS);
          let newStart = addDaysUTC(origin.origStart, deltaDays);
          if (newStart.getTime() > maxStart.getTime()) newStart = maxStart;
          if (newStart.getTime() !== origin.origStart.getTime()) {
            mutateRef.current({
              ticketId: origin.ticketId,
              data: { startDate: formatISODateUTC(newStart) },
            });
          }
        } else {
          const minEnd = addDaysUTC(origin.origStart, MIN_DURATION_DAYS);
          let newEnd = addDaysUTC(origin.origEnd, deltaDays);
          if (newEnd.getTime() < minEnd.getTime()) newEnd = minEnd;
          if (newEnd.getTime() !== origin.origEnd.getTime()) {
            mutateRef.current({
              ticketId: origin.ticketId,
              data: { dueDate: formatISODateUTC(newEnd) },
            });
          }
        }
      }

      setDragPreview(null);
      justDraggedRef.current = true;
      setTimeout(() => { justDraggedRef.current = false; }, 0);
    }
    function onPointerUp() {
      finishDrag(true);
    }
    function onPointerCancel() {
      finishDrag(false);
    }
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
    };
  }, []);

  function handleEdgePointerDown(
    e: React.PointerEvent,
    ticketId: string,
    edge: 'start' | 'end',
    ticketStart: Date,
    ticketEnd: Date,
  ) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { ticketId, edge, startX: e.clientX, origStart: ticketStart, origEnd: ticketEnd };
    deltaDaysRef.current = 0;
    justDraggedRef.current = true;
    setDragPreview({ ticketId, edge, deltaDays: 0 });
  }

  function handleBarClick(ticket: Ticket) {
    if (justDraggedRef.current) return;
    onCardClick(ticket);
  }

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
  const todayLeftPx = 7 * DAY_WIDTH; // 126px — fixed!

  const ganttTickets = useMemo(() => {
    return tickets
      .filter((t) => parseDate(t.startDate) || parseDate(t.dueDate))
      .filter((t) => {
        // Skip tickets completely outside the window
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
        // Keep only if overlaps the window
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

  if (ganttTickets.length === 0) {
    return (
      <div className={styles.emptyState}>
        No tickets have start or due dates set.
      </div>
    );
  }

  return (
    <>
      <div className={styles.ganttWrapper}>
        {/* LEFT: Fixed label column */}
        <div className={styles.ganttLabelCol}>
          <div className={styles.ganttLabelHeader}>Ticket</div>
          {ganttTickets.map((ticket) => (
            <div
              key={ticket.id}
              className={styles.ganttLabelRow}
              style={{ height: ROW_HEIGHT }}
              onClick={() => onCardClick(ticket)}
            >
              <span className={styles.ganttTicketId}>{ticket.id}</span>
              <span className={styles.ganttTicketTitle} title={ticket.title}>
                {ticket.title}
              </span>
            </div>
          ))}
        </div>

        {/* RIGHT: Scrollable bar area */}
        <div className={styles.ganttBarArea}>
          {/* Date header */}
          <div className={styles.ganttDateHeader} style={{ width: chartWidth }}>
            {headerTicks.map((t) => (
              <div
                key={t.day}
                className={`${styles.ganttDateTick}${t.isToday ? ` ${styles.ganttDateTickToday}` : ''}`}
                style={{ left: t.day * DAY_WIDTH }}
              >
                {t.label}
              </div>
            ))}
          </div>

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

            // Clamp to window
            const effectiveStart = ticketStart < rangeStart ? rangeStart : ticketStart;
            const effectiveEnd = ticketEnd > rangeEnd ? rangeEnd : ticketEnd;

            let leftPx = daysBetween(rangeStart, effectiveStart) * DAY_WIDTH;
            const rawWidthPx = Math.max(daysBetween(effectiveStart, effectiveEnd), 1) * DAY_WIDTH;
            let widthPx = Math.max(rawWidthPx, MIN_BAR_PX);

            // Live visual preview while this bar's edge is being dragged.
            // Clamp deltaDays to the same 1-day-minimum-duration rule the
            // commit (onPointerUp) applies, rather than a raw pixel floor —
            // otherwise the bar snaps back visibly once the drag is released
            // past that point.
            const isDraggingThis = dragPreview?.ticketId === ticket.id;
            if (isDraggingThis) {
              const MIN_DURATION_DAYS = 1;
              const durationDays = Math.max(daysBetween(ticketStart, ticketEnd), 1);
              let clampedDeltaDays = dragPreview.deltaDays;
              if (dragPreview.edge === 'start') {
                const maxDeltaDays = durationDays - MIN_DURATION_DAYS;
                if (clampedDeltaDays > maxDeltaDays) clampedDeltaDays = maxDeltaDays;
              } else {
                const minDeltaDays = -(durationDays - MIN_DURATION_DAYS);
                if (clampedDeltaDays < minDeltaDays) clampedDeltaDays = minDeltaDays;
              }
              const shiftPx = clampedDeltaDays * DAY_WIDTH;
              if (dragPreview.edge === 'start') {
                leftPx += shiftPx;
                widthPx = Math.max(widthPx - shiftPx, DAY_WIDTH * MIN_DURATION_DAYS);
              } else {
                widthPx = Math.max(widthPx + shiftPx, DAY_WIDTH * MIN_DURATION_DAYS);
              }
            }

            const isOverdue =
              parseDate(ticket.dueDate) !== null &&
              parseDate(ticket.dueDate)! < today &&
              ticket.status !== 'done' &&
              ticket.status !== 'wont_do';

            return (
              <div
                key={ticket.id}
                className={styles.ganttBarRow}
                style={{ width: chartWidth, height: ROW_HEIGHT }}
              >
                <div
                  className={styles.ganttTodayLine}
                  style={{ left: todayLeftPx }}
                />
                <button
                  type="button"
                  className={`${styles.ganttBar} ${isOverdue ? styles.ganttBarOverdue : styles.ganttBarNormal}${isDraggingThis ? ` ${styles.ganttBarDragging}` : ''}`}
                  style={{
                    left: leftPx,
                    width: widthPx,
                    height: BAR_HEIGHT,
                    top: `calc(50% - ${BAR_HEIGHT / 2}px)`,
                  }}
                  onClick={() => handleBarClick(ticket)}
                  title={`${ticket.title}\n${ticket.startDate ? formatShortDate(ticket.startDate) : '?'} → ${ticket.dueDate ? formatShortDate(ticket.dueDate) : '?'}\n(drag either edge to reschedule)`}
                >
                  {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
                  <span
                    className={styles.ganttBarHandleLeft}
                    onPointerDown={(e) => handleEdgePointerDown(e, ticket.id, 'start', ticketStart, ticketEnd)}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <span className={styles.ganttBarLabel}>{ticket.id}</span>
                  <span
                    className={styles.ganttBarHandleRight}
                    onPointerDown={(e) => handleEdgePointerDown(e, ticket.id, 'end', ticketStart, ticketEnd)}
                    onClick={(e) => e.stopPropagation()}
                  />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div className={styles.ganttLegend}>
        <span className={styles.legendDot} style={{ background: 'var(--color-blue)' }} /> Normal
        <span className={styles.legendDot} style={{ background: 'var(--color-orange)' }} /> Overdue
        <span className={styles.legendLine} /> Today
      </div>
    </>
  );
}

// ─── Event Timeline ───────────────────────────────────────────────────────────

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
    <div className={styles.eventTimeline}>
      {groups.map((group) => (
        <div key={group.date} className={styles.eventGroup}>
          <div className={styles.eventGroupDate}>{group.date}</div>
          <div className={styles.eventRail}>
            {group.events.map((ev, idx) => {
              const ticket = ticketMap.get(ev.ticketId);
              const category = categorizeEvent(ev.eventType);
              const badgeColor = EVENT_COLORS[category];
              const icon = EVENT_ICONS[category];
              const time = new Date(ev.at).toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
              });
              return (
                <div key={`${ev.ticketId}-${ev.at}-${idx}`} className={styles.eventItem}>
                  <div
                    className={styles.eventBadgeCircle}
                    style={{ background: badgeColor }}
                  >
                    {icon}
                  </div>
                  <div className={styles.eventContent}>
                    <div className={styles.eventRow1}>
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
                    <div className={styles.eventRow2}>
                      <span className={styles.eventTypeLabel}>
                        {friendlyEventType(ev.eventType)}
                      </span>
                      {ev.detail && ev.eventType !== 'created' && (
                        <span className={styles.eventDetailText}>{ev.detail}</span>
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

// ─── Main component ───────────────────────────────────────────────────────────

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
