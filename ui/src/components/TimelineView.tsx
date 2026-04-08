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
const MIN_DAYS = 60;
const ROW_HEIGHT = 48;
const BAR_HEIGHT = 14;
const MIN_BAR_WIDTH = 12;

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
  created: '#22c55e',
  status_changed: '#3b82f6',
  commented: '#a855f7',
  other: '#9ca3af',
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

  const ganttTickets = useMemo(
    () => tickets.filter((t) => parseDate(t.startDate) || parseDate(t.dueDate)),
    [tickets],
  );

  const { rangeStart, totalDays } = useMemo(() => {
    if (ganttTickets.length === 0) return { rangeStart: today, totalDays: MIN_DAYS };
    const dates: Date[] = [];
    for (const t of ganttTickets) {
      const s = parseDate(t.startDate);
      const e = parseDate(t.dueDate);
      if (s) dates.push(s);
      if (e) dates.push(e);
    }
    dates.push(today);
    const minDate = new Date(Math.min(...dates.map((d) => d.getTime())));
    const maxDate = new Date(Math.max(...dates.map((d) => d.getTime())));
    // Add 3-day padding on each side
    minDate.setDate(minDate.getDate() - 3);
    maxDate.setDate(maxDate.getDate() + 3);
    const span = daysBetween(minDate, maxDate) + 1;
    // Always render at least MIN_DAYS to prevent squishing
    return { rangeStart: minDate, totalDays: Math.max(span, MIN_DAYS) };
  }, [ganttTickets, today]);

  if (ganttTickets.length === 0) {
    return (
      <div className={styles.emptyState}>
        No tickets have start or due dates. Add dates to tickets to see the Gantt chart.
      </div>
    );
  }

  const chartWidth = totalDays * DAY_WIDTH;
  const todayOffset = daysBetween(rangeStart, today);

  // Weekly header ticks
  const headerTicks: { day: number; label: string }[] = [];
  for (let i = 0; i < totalDays; i += 7) {
    const d = new Date(rangeStart);
    d.setDate(d.getDate() + i);
    headerTicks.push({
      day: i,
      label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    });
  }

  return (
    <div className={styles.ganttOuter}>
      {/* Header row */}
      <div className={styles.ganttHeaderRow} style={{ height: ROW_HEIGHT - 8 }}>
        <div className={styles.ganttLabelSticky} style={{ height: ROW_HEIGHT - 8 }} />
        <div className={styles.ganttBarArea} style={{ width: chartWidth, height: ROW_HEIGHT - 8, position: 'relative' }}>
          {todayOffset >= 0 && todayOffset < totalDays && (
            <span
              className={styles.ganttTodayLabel}
              style={{ left: todayOffset * DAY_WIDTH }}
            >
              Today
            </span>
          )}
          {headerTicks.map((t) => (
            <div
              key={t.day}
              className={styles.ganttTick}
              style={{ left: t.day * DAY_WIDTH }}
            >
              {t.label}
            </div>
          ))}
        </div>
      </div>

      {/* Data rows */}
      {ganttTickets.map((ticket) => {
        const start = parseDate(ticket.startDate) ?? parseDate(ticket.dueDate)!;
        const end = parseDate(ticket.dueDate) ?? parseDate(ticket.startDate)!;
        const effectiveStart = start <= end ? start : end;
        const effectiveEnd = start <= end ? end : start;

        const offsetDays = daysBetween(rangeStart, effectiveStart);
        const durationDays = Math.max(daysBetween(effectiveStart, effectiveEnd), 1);
        const leftPx = offsetDays * DAY_WIDTH;
        const widthPx = Math.max(durationDays * DAY_WIDTH, MIN_BAR_WIDTH);

        const isOverdue =
          parseDate(ticket.dueDate) !== null &&
          parseDate(ticket.dueDate)! < today &&
          ticket.status !== 'done' &&
          ticket.status !== 'wont_do';

        return (
          <div key={ticket.id} className={styles.ganttRow} style={{ height: ROW_HEIGHT }}>
            <div className={styles.ganttLabelSticky} style={{ height: ROW_HEIGHT }}>
              <span className={styles.ganttTicketId}>{ticket.id}</span>
              <span className={styles.ganttTicketTitle} title={ticket.title}>{ticket.title}</span>
            </div>
            <div className={styles.ganttBarArea} style={{ width: chartWidth, height: ROW_HEIGHT }}>
              {todayOffset >= 0 && todayOffset < totalDays && (
                <div
                  className={styles.ganttTodayLine}
                  style={{ left: todayOffset * DAY_WIDTH }}
                />
              )}
              <button
                type="button"
                className={`${styles.ganttBar} ${isOverdue ? styles.ganttBarOverdue : ''}`}
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
          </div>
        );
      })}

      <div className={styles.ganttLegend}>
        <span className={styles.legendDot} style={{ background: '#5BB8F5' }} /> Normal
        <span className={styles.legendDot} style={{ background: '#E8441A' }} /> Overdue
        <span className={styles.legendLine} /> Today
      </div>
    </div>
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
              const dotColor = EVENT_COLORS[category];
              const time = new Date(ev.at).toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
              });
              return (
                <div key={`${ev.ticketId}-${ev.at}-${idx}`} className={styles.eventItem}>
                  <div className={styles.eventDotWrap}>
                    <div className={styles.eventDot} style={{ background: dotColor }} />
                  </div>
                  <div className={styles.eventContent}>
                    <div className={styles.eventMeta}>
                      <span
                        className={styles.eventBadge}
                        style={{
                          background: `${dotColor}33`,
                          color: dotColor,
                        }}
                      >
                        {friendlyEventType(ev.eventType)}
                      </span>
                      <button
                        type="button"
                        className={styles.eventTicketLink}
                        onClick={() => ticket && onCardClick(ticket)}
                        disabled={!ticket}
                      >
                        {ev.ticketId}
                      </button>
                      <span className={styles.eventTitle}>{ev.ticketTitle}</span>
                      <span className={styles.eventTime}>{time}</span>
                    </div>
                    {ev.detail && ev.eventType !== 'created' && (
                      <div className={styles.eventDetail}>{ev.detail}</div>
                    )}
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
