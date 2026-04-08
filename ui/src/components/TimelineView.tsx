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

function friendlyEventType(type: string): string {
  if (type === 'created') return 'Created';
  if (type === 'commented') return 'Commented';
  if (type.startsWith('changed:')) {
    const field = type.replace('changed:', '').replace('_', ' ');
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
    if (ganttTickets.length === 0) return { rangeStart: today, totalDays: 30 };
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
    return { rangeStart: minDate, totalDays: daysBetween(minDate, maxDate) + 1 };
  }, [ganttTickets, today]);

  if (ganttTickets.length === 0) {
    return (
      <div className={styles.emptyState}>
        No tickets have start or due dates. Add dates to tickets to see the Gantt chart.
      </div>
    );
  }

  const todayOffset = daysBetween(rangeStart, today);

  // Build header ticks — show a label every ~7 days
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
    <div className={styles.gantt}>
      {/* Header row with date ticks */}
      <div className={styles.ganttHeader}>
        <div className={styles.ganttLabelCol} />
        <div className={styles.ganttTrackArea}>
          {headerTicks.map((t) => (
            <div
              key={t.day}
              className={styles.ganttTick}
              style={{ left: `${(t.day / totalDays) * 100}%` }}
            >
              {t.label}
            </div>
          ))}
          {todayOffset >= 0 && todayOffset < totalDays && (
            <div
              className={styles.ganttTodayLine}
              style={{ left: `${(todayOffset / totalDays) * 100}%` }}
              title="Today"
            />
          )}
        </div>
      </div>

      {/* Rows */}
      {ganttTickets.map((ticket) => {
        const start = parseDate(ticket.startDate) ?? parseDate(ticket.dueDate)!;
        const end = parseDate(ticket.dueDate) ?? parseDate(ticket.startDate)!;
        const effectiveStart = start < end ? start : end;
        const effectiveEnd = start < end ? end : start;

        const offsetDays = daysBetween(rangeStart, effectiveStart);
        const durationDays = Math.max(daysBetween(effectiveStart, effectiveEnd), 1);
        const leftPct = (offsetDays / totalDays) * 100;
        const widthPct = (durationDays / totalDays) * 100;

        const isOverdue =
          parseDate(ticket.dueDate) !== null &&
          parseDate(ticket.dueDate)! < today &&
          ticket.status !== 'done' &&
          ticket.status !== 'wont_do';

        return (
          <div key={ticket.id} className={styles.ganttRow}>
            <div className={styles.ganttLabelCol} title={ticket.title}>
              <span className={styles.ganttTicketId}>{ticket.id}</span>
              <span className={styles.ganttTicketTitle}>{ticket.title}</span>
            </div>
            <div className={styles.ganttTrackArea}>
              {todayOffset >= 0 && todayOffset < totalDays && (
                <div
                  className={styles.ganttTodayLineRow}
                  style={{ left: `${(todayOffset / totalDays) * 100}%` }}
                />
              )}
              <button
                type="button"
                className={`${styles.ganttBar} ${isOverdue ? styles.ganttBarOverdue : ''}`}
                style={{ left: `${leftPct}%`, width: `${Math.max(widthPct, 0.5)}%` }}
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
          {group.events.map((ev, idx) => {
            const ticket = ticketMap.get(ev.ticketId);
            const time = new Date(ev.at).toLocaleTimeString('en-US', {
              hour: '2-digit',
              minute: '2-digit',
            });
            return (
              <div key={`${ev.ticketId}-${ev.at}-${idx}`} className={styles.eventItem}>
                <div className={styles.eventDot} />
                <div className={styles.eventContent}>
                  <div className={styles.eventMeta}>
                    <button
                      type="button"
                      className={styles.eventTicketLink}
                      onClick={() => ticket && onCardClick(ticket)}
                      disabled={!ticket}
                    >
                      {ev.ticketId}
                    </button>
                    <span className={styles.eventType}>{friendlyEventType(ev.eventType)}</span>
                    <span className={styles.eventTime}>{time}</span>
                  </div>
                  <div className={styles.eventTitle}>{ev.ticketTitle}</div>
                  {ev.detail && ev.eventType !== 'created' && (
                    <div className={styles.eventDetail}>{ev.detail}</div>
                  )}
                </div>
              </div>
            );
          })}
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
