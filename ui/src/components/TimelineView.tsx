import { useMemo, useState } from 'react';
import type { Ticket } from '../types';
import { useProjectActivities } from '../api/tickets';
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

// ─── Event helpers ────────────────────────────────────────────────────────────

type EventCategory = 'created' | 'status_changed' | 'commented' | 'other';

function categorizeEvent(type: string): EventCategory {
  if (type === 'created') return 'created';
  if (type === 'commented') return 'commented';
  if (type.startsWith('changed:status')) return 'status_changed';
  return 'other';
}

const EVENT_COLORS: Record<EventCategory, string> = {
  created: '#AACC2E',
  status_changed: '#E8441A',
  commented: '#5BB8F5',
  other: 'rgba(61,12,17,0.2)',
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

function GanttChart({ tickets, onCardClick }: GanttProps) {
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

            const leftPx = daysBetween(rangeStart, effectiveStart) * DAY_WIDTH;
            const rawWidthPx = Math.max(daysBetween(effectiveStart, effectiveEnd), 1) * DAY_WIDTH;
            const widthPx = Math.max(rawWidthPx, MIN_BAR_PX);

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
                  className={`${styles.ganttBar} ${isOverdue ? styles.ganttBarOverdue : styles.ganttBarNormal}`}
                  style={{
                    left: leftPx,
                    width: widthPx,
                    height: BAR_HEIGHT,
                    top: `calc(50% - ${BAR_HEIGHT / 2}px)`,
                  }}
                  onClick={() => onCardClick(ticket)}
                  title={`${ticket.title}\n${ticket.startDate ? formatShortDate(ticket.startDate) : '?'} → ${ticket.dueDate ? formatShortDate(ticket.dueDate) : '?'}`}
                >
                  <span className={styles.ganttBarLabel}>{ticket.id}</span>
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div className={styles.ganttLegend}>
        <span className={styles.legendDot} style={{ background: '#93c5fd' }} /> Normal
        <span className={styles.legendDot} style={{ background: '#f97316' }} /> Overdue
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
