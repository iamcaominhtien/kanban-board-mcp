import type { CSSProperties, ReactNode } from 'react';
import type { Status, Ticket } from '../../types';
import type { StoryPlanItem, StoryState, StoryView } from '../../types/story';
import styles from './story.module.css';

/**
 * Pieces shared by the Story card, the lanes, the page and the dialogs (design/source/AiStoryFlow.dc.html, C to F).
 */

/** What a Story card shows: its state, with the two faces of Planning and Blocked on top of a step. */
export type StoryFace =
  'draft' | 'planning' | 'plan_needs_you' | 'in_progress' | 'blocked' | 'review' | 'done' | 'dropped';

/** The Story's ticket status follows its state (spec: draft → backlog … dropped → wont_do). */
const STATE_OF_STATUS: Record<Status, StoryState> = {
  backlog: 'draft',
  todo: 'planning',
  'in-progress': 'in_progress',
  testing: 'in_progress',
  review: 'review',
  done: 'done',
  wont_do: 'dropped',
};

/** A view of a Story ticket while the Story API has not answered (or failed): what its status says. */
export function fallbackStory(ticket: Ticket, allTickets: Ticket[] = []): StoryView {
  const children = allTickets.filter((t) => t.parentId === ticket.id && t.status !== 'wont_do');
  return {
    id: ticket.id,
    projectId: ticket.projectId,
    title: ticket.title,
    goal: ticket.description ?? '',
    state: STATE_OF_STATUS[ticket.status] ?? 'draft',
    blocked: null,
    planWaiting: false,
    approve: 'person',
    paused: false,
    pm: null,
    criteria: (ticket.acceptanceCriteria ?? []).map((c) => ({
      id: c.id,
      text: c.text,
      done: c.done,
      ticketId: null,
      state: c.done ? 'met' : 'not_started',
    })),
    plan: null,
    progress: {
      done: children.filter((c) => c.status === 'done').length,
      total: children.length,
      building: children.filter((c) => c.status === 'in-progress').length,
      waiting: 0,
    },
    tokens: { used: 0, budget: 0 },
    costUsd: 0,
    interventions: { count: 0, needed: 0, avoidable: 0, byRule: 0 },
    handedAt: null,
    startedAt: null,
    closedAt: null,
    createdAt: ticket.createdAt,
  };
}

/** Which of the C2 faces a Story shows. */
export function storyFace(s: StoryView): StoryFace {
  if (s.state === 'planning' && s.planWaiting) return 'plan_needs_you';
  if ((s.state === 'in_progress' || s.state === 'review' || s.state === 'planning') && s.blocked) return 'blocked';
  return s.state;
}

const ICON_PATHS: Record<string, ReactNode> = {
  story: <path d="M6.5 3h11a1 1 0 0 1 1 1v17l-6.5-4.2L5.5 21V4a1 1 0 0 1 1-1z" />,
  draft: (
    <>
      <path d="M4 20h4L19 9l-4-4L4 16v4z" />
      <path d="M13.5 6.5l4 4" />
    </>
  ),
  planning: <path d="M5 6h14M5 12h14M5 18h9" />,
  hand: (
    <path d="M8 12V6a1.5 1.5 0 0 1 3 0v5M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6a1.5 1.5 0 0 1 3 0v8c0 4-2 6-5 6-3 0-4-1.5-5.5-4L4 12a1.5 1.5 0 0 1 2.5-1.5L8 12" />
  ),
  play: <path d="M7 5l12 7-12 7z" />,
  warn: (
    <>
      <path d="M12 4l9 16H3L12 4z" />
      <path d="M12 10v4M12 17v.5" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  check: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l3 3 5-6" />
    </>
  ),
  tick: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  send: <path d="M4 12l16-8-6 16-3-7-7-1z" />,
  pause: (
    <>
      <rect x="7" y="5" width="3.5" height="14" rx="1" />
      <rect x="13.5" y="5" width="3.5" height="14" rx="1" />
    </>
  ),
  flow: (
    <>
      <circle cx="12" cy="12" r="3" />
      <circle cx="4.5" cy="5.5" r="1.8" />
      <circle cx="19.5" cy="5.5" r="1.8" />
      <circle cx="4.5" cy="18.5" r="1.8" />
      <circle cx="19.5" cy="18.5" r="1.8" />
      <path d="M6 7l4 3.5M18 7l-4 3.5M6 17l4-3.5M18 17l-4-3.5" />
    </>
  ),
  dots: (
    <>
      <circle cx="5" cy="12" r="1.3" />
      <circle cx="12" cy="12" r="1.3" />
      <circle cx="19" cy="12" r="1.3" />
    </>
  ),
  undo: (
    <>
      <path d="M9 7L4 12l5 5" />
      <path d="M4 12h9a6 6 0 0 1 6 6" />
    </>
  ),
  battery: (
    <>
      <rect x="2.5" y="7" width="16" height="10" rx="2" />
      <path d="M21 10.5v3M6 10v4M10 10v4" />
    </>
  ),
  chat: <path d="M21 12a8 8 0 0 1-11.5 7.2L4 20.5l1.4-4.6A8 8 0 1 1 21 12z" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  down: <path d="M6 9l6 6 6-6" />,
  right: <path d="M9 6l6 6-6 6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  group: (
    <>
      <path d="M3.5 6h17M3.5 12h17M3.5 18h17" />
      <path d="M8 4v4M14 10v4M10 16v4" strokeWidth="2.4" />
    </>
  ),
  circleCheck: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 12.5l2.5 2.5 4.5-5" />
    </>
  ),
  up: <path d="M6 15l6-6 6 6" />,
  reopen: (
    <>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </>
  ),
  open: (
    <>
      <path d="M14 3H21V10" />
      <path d="M21 3L11 13" />
      <path d="M19 14V19A2 2 0 0 1 17 21H5A2 2 0 0 1 3 19V7A2 2 0 0 1 5 5H10" />
    </>
  ),
};

/** A stroke icon from the design's set. */
export function Ico({
  name,
  size = 12,
  color = 'currentColor',
  width = 2.2,
  style,
}: {
  name: keyof typeof ICON_PATHS | string;
  size?: number;
  color?: string;
  width?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0, ...style }}
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

const FACE_CHIP: Record<StoryFace, { bg: string; fg: string; icon: string; label: string }> = {
  draft: { bg: '#F1F3F1', fg: '#3A4A3E', icon: 'draft', label: 'Draft' },
  planning: { bg: '#E8F1FA', fg: '#244E78', icon: 'planning', label: 'Planning' },
  plan_needs_you: { bg: '#FEF3D9', fg: '#7A5A06', icon: 'hand', label: 'Plan needs you' },
  in_progress: { bg: '#E6F2EA', fg: '#1F5A31', icon: 'play', label: 'In progress' },
  blocked: { bg: '#FDECE8', fg: '#A5321E', icon: 'warn', label: 'Blocked' },
  review: { bg: '#E9EAF7', fg: '#3F4390', icon: 'eye', label: 'Review' },
  done: { bg: '#F1F3F1', fg: '#3A4A3E', icon: 'check', label: 'Done' },
  dropped: { bg: '#F1F3F1', fg: '#5B6B60', icon: 'x', label: 'Dropped' },
};

/** The state chip of a Story (C2): never colour alone, each one has its icon and word. */
export function StoryStateChip({ face }: { face: StoryFace }) {
  const c = FACE_CHIP[face];
  return (
    <span className={styles.chip} style={{ background: c.bg, color: c.fg }} data-testid="story-state-chip">
      <Ico name={c.icon} size={face === 'blocked' || face === 'plan_needs_you' ? 13 : 11} color={c.fg} />
      {c.label}
    </span>
  );
}

/** A paused Story says so next to its state. */
export function PausedChip() {
  return (
    <span className={styles.chip} style={{ background: '#EEF1EE', color: '#3A4A3E' }}>
      <Ico name="pause" size={11} color="#3A4A3E" width={2} />
      Paused
    </span>
  );
}

const ROLE_STYLE: { match: RegExp; bg: string; fg: string; border: string; abbr: string; label: string }[] = [
  { match: /^pm|manager|coordinator/i, bg: '#E8F1FA', fg: '#244E78', border: '#2F6FB0', abbr: 'PM', label: 'PM' },
  { match: /^dev/i, bg: '#E6F2EA', fg: '#1F5A31', border: '#2E6F40', abbr: 'DV', label: 'Dev' },
  { match: /^design/i, bg: '#FCE8F1', fg: '#8A2655', border: '#C2417A', abbr: 'DS', label: 'Designer' },
  { match: /^test|^qa/i, bg: '#FEF3D9', fg: '#7A5A06', border: '#B8860B', abbr: 'TS', label: 'Tester' },
  { match: /^review/i, bg: '#E9EAF7', fg: '#3F4390', border: '#5B5FA8', abbr: 'RV', label: 'Reviewer' },
  { match: /^ba$|^business|analyst/i, bg: '#F3E7DC', fg: '#8A4B00', border: '#B4791E', abbr: 'BA', label: 'BA' },
  { match: /^triage/i, bg: '#EEF1EE', fg: '#3A4A3E', border: '#5B6B60', abbr: 'TR', label: 'Triage' },
];

/** How a role reads: its two-letter badge and its word ("DV", "Dev"). */
export function roleOf(role: string | null | undefined) {
  const r = ROLE_STYLE.find((x) => x.match.test((role ?? '').trim()));
  if (r) return r;
  const word = (role ?? '').trim() || 'AI';
  return {
    match: /./,
    bg: '#EEF1EE',
    fg: '#3A4A3E',
    border: '#5B6B60',
    abbr: word.slice(0, 2).toUpperCase(),
    label: word.charAt(0).toUpperCase() + word.slice(1),
  };
}

/** The square role badge of an AI (PM, DV, DS …). */
export function RoleBadge({
  role,
  size = 20,
  title,
}: {
  role: string | null | undefined;
  size?: number;
  title?: string;
}) {
  const r = roleOf(role);
  return (
    <span
      className={styles.badge}
      title={title ?? r.label}
      style={{
        width: size,
        height: size,
        borderRadius: size >= 24 ? 7 : 6,
        background: r.bg,
        color: r.fg,
        borderColor: r.border,
        fontSize: size >= 26 ? 9 : size >= 24 ? 8 : 7,
      }}
    >
      {r.abbr}
    </span>
  );
}

/** The progress bar of a Story: done, building, and (when Blocked) what waits, in red. */
export function StoryBar({ story, width, height = 6 }: { story: StoryView; width?: number; height?: number }) {
  const { done, total, building, waiting } = story.progress;
  const face = storyFace(story);
  const hatched = face === 'draft' || face === 'planning' || face === 'plan_needs_you' || total === 0;
  const pct = (n: number) => `${total > 0 ? (n / total) * 100 : 0}%`;
  return (
    <div
      className={styles.bar}
      style={{ width: width ?? '100%', height, flexShrink: 0 }}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      aria-label={hatched ? 'No tickets yet' : `${done} of ${total} tickets done`}
    >
      {hatched ? (
        <i className={styles.hatched} style={{ width: '100%' }} />
      ) : (
        <>
          <i style={{ width: pct(done), background: '#2E6F40' }} />
          <i style={{ width: pct(Math.min(building, total - done)), background: '#7DBF8E' }} />
          {face === 'blocked' && (
            <i style={{ width: pct(Math.min(Math.max(waiting, 1), total - done - building)), background: '#C4432A' }} />
          )}
        </>
      )}
    </div>
  );
}

/** "You stepped in 3 times" / "No one has stepped in" (C2), or nothing before the Story runs. */
export function SteppedIn({ story, style }: { story: StoryView; style?: CSSProperties }) {
  const face = storyFace(story);
  if (face === 'draft' || face === 'planning' || face === 'plan_needs_you' || face === 'dropped') return null;
  const n = story.interventions.count;
  return (
    <div className={styles.stepped} style={{ color: n > 0 ? '#7A5A06' : '#2E6F40', ...style }}>
      {n > 0 ? `You stepped in ${n} time${n === 1 ? '' : 's'}` : 'No one has stepped in'}
    </div>
  );
}

/** The red strip of a Blocked Story: what it waits for. */
export function blockedLead(kind: string): string {
  switch (kind) {
    case 'budget':
      return 'Budget reached:';
    case 'quota':
      return 'Waits for a usage window:';
    case 'stopped':
      return 'Stopped:';
    default:
      return 'Needs you:';
  }
}

/** The small chip a child ticket carries: which Story it belongs to (C). */
export function StoryChildChip({ storyId, title }: { storyId: string; title?: string }) {
  return (
    <span className={styles.childChip} title={title ? `In the Story ${title}` : `In the Story ${storyId}`}>
      <Ico name="story" size={10} color="#1B3A6B" width={2.2} />
      <span>{storyId}</span>
    </span>
  );
}

/** 1,300,000 → "1.3M"; 220,000 → "220k". */
export function fmtTokens(n: number): string {
  if (!n) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** Seconds between two moments as "2 h 40 m" (long: "2 h 40 min"). */
export function fmtSpan(fromIso: string | null | undefined, toIso?: string | null, long = false): string {
  if (!fromIso) return '–';
  const from = new Date(fromIso).getTime();
  const to = toIso ? new Date(toIso).getTime() : Date.now();
  if (Number.isNaN(from) || Number.isNaN(to)) return '–';
  const min = Math.max(0, Math.round((to - from) / 60000));
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  const mWord = long ? 'min' : 'm';
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} ${mWord}`;
  return `${m} ${mWord}`;
}

/** "09:12" today, "Oct 21, 09:12" another day. */
export function fmtClock(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return time;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`;
}

/** "PM" for the board's PM, a person's name otherwise. */
export function byWord(by: string | null | undefined, pmName?: string | null): string {
  if (!by) return 'someone';
  if (by === 'pm' || by === 'PM' || (pmName && by === pmName)) return 'PM';
  if (by === 'user' || by === 'person') return 'you';
  return by;
}

/** How one plan item reads in the State column of the plan (E). */
export function planItemState(item: StoryPlanItem, items: StoryPlanItem[]): { label: string; bg: string; fg: string } {
  const s = item.status;
  if (s === 'done') return { label: 'Done', bg: '#E6F2EA', fg: '#1F5A31' };
  if (s === 'wont_do') return { label: 'Dropped', bg: '#F1F3F1', fg: '#5B6B60' };
  const open = item.after.filter((id) => {
    const other = items.find((i) => i.ticketId === id);
    return !other || other.status !== 'done';
  });
  if (open.length > 0 && (s === 'backlog' || s === 'todo')) {
    return { label: `Waits for ${open.join(', ')}`, bg: '#F1F3F1', fg: '#3A4A3E' };
  }
  if (s === 'in-progress') {
    const step = item.step ? item.step.charAt(0).toUpperCase() + item.step.slice(1) : 'Building';
    return { label: step, bg: '#E6F2EA', fg: '#1F5A31' };
  }
  if (s === 'review') return { label: 'In review', bg: '#E9EAF7', fg: '#3F4390' };
  if (s === 'testing') return { label: 'Testing', bg: '#E8F1FA', fg: '#244E78' };
  return { label: 'Not started', bg: '#F1F3F1', fg: '#3A4A3E' };
}

/** "first", "after 1", "after 2 and 3", "at the same time as 2" (F, the plan waiting for you). */
export function waitsWord(item: StoryPlanItem, items: StoryPlanItem[]): string {
  const orderOf = (id: string) => items.find((i) => i.ticketId === id)?.order;
  const key = (x: StoryPlanItem) => [...x.after].sort().join(',');
  const twin = items.find((o) => o.order < item.order && key(o) === key(item));
  if (item.after.length === 0) {
    if (twin) return `at the same time as ${twin.order}`;
    return item.order === 1 ? 'first' : 'at the start';
  }
  if (twin) return `at the same time as ${twin.order}`;
  const nums = item.after.map((id) => orderOf(id) ?? id);
  return `after ${nums.length > 1 ? `${nums.slice(0, -1).join(', ')} and ${nums[nums.length - 1]}` : nums[0]}`;
}

/** Criterion numbers as people read them (1-based), whether the server counts from 0 or 1. */
export function coverNumbers(items: StoryPlanItem[]): (covers: number[]) => number[] {
  const zeroBased = items.some((i) => i.covers.includes(0));
  return (covers) => covers.map((c) => (zeroBased ? c + 1 : c));
}

/** The common error text of a refused request. */
export function errorText(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { detail?: unknown } }; message?: string } | null;
  const d = e?.response?.data?.detail;
  if (typeof d === 'string' && d) return d;
  return fallback;
}
