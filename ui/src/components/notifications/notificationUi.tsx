import type { ReactNode } from 'react';
import type { NotificationRow } from '../../types/notifications';

/** The line icons of the design (design/source/Notifications.dc.html), 24-grid, drawn with the current colour. */
const PATHS: Record<string, ReactNode> = {
  bubble: <path d="M21 12a8 8 0 0 1-11.5 7.2L4 20.5l1.4-4.6A8 8 0 1 1 21 12z" />,
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  plug: <path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4" />,
  triangle: (
    <>
      <path d="M12 4l9 16H3L12 4z" />
      <path d="M12 10v4M12 17v.5" />
    </>
  ),
  mention: (
    <>
      <circle cx="12" cy="12" r="3.5" />
      <path d="M15.5 12v1.2a2.3 2.3 0 0 0 4.5 0V12a8 8 0 1 0-3.2 6.4" />
    </>
  ),
  doc: (
    <>
      <path d="M7 3h7l5 5v13H7z" />
      <path d="M14 3v5h5" />
    </>
  ),
  calendar: (
    <>
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path d="M4 10h16M9 3v4M15 3v4" />
    </>
  ),
  bolt: <path d="M13 3L5 13h6l-1 8 8-10h-6z" />,
  check: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l3 3 5-6" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4" />
    </>
  ),
  bell: <path d="M6 17V11a6 6 0 0 1 12 0v6l1.5 2h-15L6 17zM10 21h4" />,
  reply: (
    <>
      <path d="M9 7L4 12l5 5" />
      <path d="M4 12h9a7 7 0 0 1 7 7v1" />
    </>
  ),
  retry: <path d="M20 11a8 8 0 0 0-14.5-4M4 4v4h4M4 13a8 8 0 0 0 14.5 4M20 20v-4h-4" />,
  tick: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" />
    </>
  ),
  list: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
  down: <path d="M6 9l6 6 6-6" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  mute: (
    <path d="M3 3l18 18M10.6 6.2A9 9 0 0 1 12 6c5 0 8.5 4 9.5 6a13 13 0 0 1-2.6 3.4M6.2 7.6A13 13 0 0 0 2.5 12c1 2 4.5 6 9.5 6a9 9 0 0 0 3.2-.6" />
  ),
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  back: <path d="M15 6l-6 6 6 6" />,
  stop: (
    <>
      <rect x="7" y="5" width="3.5" height="14" rx="1" />
      <rect x="13.5" y="5" width="3.5" height="14" rx="1" />
    </>
  ),
  more: <path d="M5 12h.01M12 12h.01M19 12h.01" />,
  play: <path d="M7 5l12 7-12 7z" />,
};

export type IconName = keyof typeof PATHS;

/** An inline SVG icon of the design. */
export function Icon({
  name,
  size = 12,
  stroke = 1.7,
  color,
}: Readonly<{
  name: IconName;
  size?: number;
  stroke?: number;
  color?: string;
}>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color ?? 'currentColor'}
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      {PATHS[name]}
    </svg>
  );
}

interface Visual {
  icon: IconName;
  bg: string;
  fg: string;
}

const AMBER = { bg: '#FEF3D9', fg: '#B8860B' };
const RED = { bg: '#FDECE8', fg: '#C4432A' };
const BLUE = { bg: '#E8F1FA', fg: '#2F6FB0' };
const GREEN = { bg: '#E6F2EA', fg: '#2E6F40' };
const PURPLE = { bg: '#EFE8FB', fg: '#5B3AA6' };

/** Icon and colour of an event family: question amber, failure red, information blue, finished green. */
const VISUALS: Record<string, Visual> = {
  question: { icon: 'bubble', ...AMBER },
  run_failed: { icon: 'triangle', ...RED },
  run_stopped_memory: { icon: 'triangle', ...RED },
  account_signed_out: { icon: 'plug', ...RED },
  auto_trip: { icon: 'triangle', ...RED },
  offline: { icon: 'plug', ...RED },
  budget: { icon: 'bolt', ...AMBER },
  mention: { icon: 'mention', ...BLUE },
  access_request: { icon: 'mention', ...BLUE },
  page_published: { icon: 'doc', ...BLUE },
  run_cancelled: { icon: 'info', ...BLUE },
  comment: { icon: 'bubble', ...PURPLE },
  budget_warning: { icon: 'bolt', ...AMBER },
  ai_finished: { icon: 'check', ...GREEN },
  schedule: { icon: 'calendar', ...GREEN },
  schedule_started: { icon: 'calendar', ...GREEN },
  day_card: { icon: 'sun', ...AMBER },
  run_stuck: { icon: 'clock', ...AMBER },
  board_fault: { icon: 'triangle', ...RED },
  merge_conflict: { icon: 'triangle', ...RED },
  arbitration: { icon: 'bubble', ...AMBER },
  workflow_blocked: { icon: 'clock', ...AMBER },
  window_urgent: { icon: 'bolt', ...AMBER },
  window_wait: { icon: 'clock', ...BLUE },
  lesson: { icon: 'doc', ...GREEN },
};

/** The icon of a kind. */
export function visualOf(kind: string): Visual {
  return VISUALS[kind] ?? { icon: 'bell', ...BLUE };
}

const AVATAR_COLORS = [
  { bg: '#E6F2EA', fg: '#1F5A31', border: '#2E6F40' },
  { bg: '#FEF3D9', fg: '#7A5A06', border: '#B8860B' },
  { bg: '#E9EAF7', fg: '#3F4390', border: '#5B5FA8' },
  { bg: '#DFF3F3', fg: '#0B5F61', border: '#0F8B8D' },
];

/** Initials of a name: "Dev An" is "DA". */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** The colours of a name's avatar, the same each time. */
export function avatarColors(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + (c.codePointAt(0) ?? 0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

/** The names behind a grouped row, in order of first appearance. */
export function groupActors(row: NotificationRow): string[] {
  const out: string[] = [];
  for (const i of row.items) if (i.actor && !out.includes(i.actor)) out.push(i.actor);
  return out;
}

/** Relative under a day ("41 min", "1 h"), then a date. */
export function relTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const m = Math.floor((now - t) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m} min`;
  if (m < 60 * 24) return `${Math.floor(m / 60)} h`;
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function dayStart(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** TODAY / YESTERDAY / a date, for the group header of a time. */
export function dayLabel(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  const diff = Math.round((dayStart(now) - dayStart(t)) / 86400000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

/**
 * Rows in the order given, cut into runs of the same day by `timeOf` (the time the list is sorted by). A label
 * is never emitted twice in a row; `key` is unique even when a label comes back.
 */
export function groupByDay(
  rows: NotificationRow[],
  now: number = Date.now(),
  timeOf: (r: NotificationRow) => string = rowTime,
): { key: string; label: string; rows: NotificationRow[] }[] {
  const out: { key: string; label: string; rows: NotificationRow[] }[] = [];
  for (const r of rows) {
    const label = dayLabel(timeOf(r), now);
    const last = out[out.length - 1];
    if (last?.label === label) last.rows.push(r);
    else out.push({ key: `${label}:${out.length}`, label, rows: [r] });
  }
  return out;
}

/** The time a row is placed by: for Needs you the waiting time (when it began), else the last activity. */
export function rowTime(r: NotificationRow): string {
  return r.needs ? r.createdAt : r.updatedAt;
}

/** The ISO times of the snooze menu: 1 hour, this evening 18:00, tomorrow morning 09:00. */
export function snoozeChoices(now: Date = new Date()): { label: string; until: string }[] {
  const hour = new Date(now.getTime() + 3_600_000);
  const evening = new Date(now);
  evening.setHours(18, 0, 0, 0);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const out = [{ label: '1 hour', until: hour.toISOString() }];
  if (evening.getTime() > now.getTime() + 3_600_000)
    out.push({ label: 'This evening 18:00', until: evening.toISOString() });
  out.push({ label: 'Tomorrow morning 09:00', until: tomorrow.toISOString() });
  return out;
}

/** "2 hours": the time left of a snooze, in the biggest fitting unit. */
function backIn(mins: number): string {
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
  if (mins < 60 * 24) {
    const hours = Math.round(mins / 60);
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${Math.round(mins / 1440)} days`;
}

/** "Snoozed until 14:00, back in 2 hours." */
export function snoozeText(until: string, now: number = Date.now()): string {
  const t = new Date(until);
  const clock = t.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  const sameDay = dayStart(t.getTime()) === dayStart(now);
  const when = sameDay
    ? clock
    : `${t.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} ${clock}`;
  const mins = Math.max(1, Math.round((t.getTime() - now) / 60000));
  return `Snoozed until ${when}, back in ${backIn(mins)}.`;
}

/** The name of the person using this browser: a member name chosen for it, or the board's own user. */
export function currentActor(): string {
  try {
    return localStorage.getItem('kanbanActor') || 'user';
  } catch {
    return 'user';
  }
}

/** Running inside the desktop app. */
export function inElectron(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI;
}

const OPEN_ORDER = ['open_ticket', 'open', 'open_run_log', 'sign_in', 'open_ai', 'reply'];

/** A ticket stopped at its token cap (`workflow_blocked`, flag quota_cap): Resume it from the row (ai-story-flow O). */
export function isCapStop(row: NotificationRow): boolean {
  return row.kind === 'workflow_blocked' && row.data?.flag === 'quota_cap' && !!row.ticketId;
}

/**
 * The actions a row offers: the server's, plus the ones the board adds itself. A ticket stopped at its token cap gets
 * Resume first and Open ticket, while it is still open; the row closes by itself once the ticket is resumed anywhere.
 */
export function rowActions(row: NotificationRow): NotificationRow['actions'] {
  if (!isCapStop(row) || row.done || row.gone) return row.actions;
  const rest = row.actions.filter((a) => a.id !== 'workflow:resume' && a.id !== 'open' && a.id !== 'open_ticket');
  return [{ id: 'workflow:resume', label: 'Resume' }, { id: 'open_ticket', label: 'Open ticket' }, ...rest];
}

/** The action that opens the thing a row is about (Enter, a click on a desktop notice); null when there is none. */
export function openActionOf(row: NotificationRow): string | null {
  // a row whose target is gone never opens anything; it only offers Dismiss
  if (row.gone) return null;
  for (const id of OPEN_ORDER) if (row.actions.some((a) => a.id === id)) return id;
  if (row.ticketId) return 'open_ticket';
  return row.kind === 'day_card' ? 'open' : null;
}

/** Run a row action from a click or a key without waiting for it; the handler reports its own errors. */
export function runAction(
  onAction: (row: NotificationRow, actionId: string, extra?: { until?: string | null }) => unknown,
  row: NotificationRow,
  actionId: string,
  extra?: { until?: string | null },
): void {
  const result = extra === undefined ? onAction(row, actionId) : onAction(row, actionId, extra);
  if (result instanceof Promise) result.catch(() => undefined);
}

/** What the row keys do to the selected row: E marks it read, S snoozes an open one for an hour, Enter opens it. */
export function rowKeyAction(
  onAction: (row: NotificationRow, actionId: string, extra?: { until?: string | null }) => unknown,
): (row: NotificationRow, what: 'open' | 'read' | 'snooze') => void {
  return (row, what) => {
    if (what === 'read') {
      runAction(onAction, row, 'read');
    } else if (what === 'snooze') {
      if (row.needs && !row.done) runAction(onAction, row, 'snooze', { until: snoozeChoices()[0].until });
    } else {
      const id = openActionOf(row);
      if (id) runAction(onAction, row, id);
    }
  };
}
