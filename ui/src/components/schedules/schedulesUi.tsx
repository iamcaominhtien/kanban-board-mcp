import type { ReactNode } from 'react';
import type { AiMember } from '../../types/ai';
import type { Schedule, ScheduleRun, SlotState } from '../../types/schedules';
import '../ai/ai.css';
import './schedules.css';

type IconProps = { size?: number };

function Svg({ size = 14, children, sw = 2 }: IconProps & { children: ReactNode; sw?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** Calendar glyph (the Schedules tab, schedule blocks). */
export function CalendarIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <path d="M3.5 10H20.5M8 3V6.5M16 3V6.5" />
    </Svg>
  );
}
/** Clock glyph. */
export function ClockIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7V12L15 14" />
    </Svg>
  );
}
/** Play triangle. */
export function PlayIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M7 4.5L19 12L7 19.5Z" />
    </Svg>
  );
}
/** Pause bars. */
export function PauseIcon({ size }: IconProps) {
  return (
    <Svg size={size} sw={2.4}>
      <path d="M8.5 5.5V18.5M15.5 5.5V18.5" />
    </Svg>
  );
}
/** Pencil. */
export function PencilIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M12 20H21M16.5 3.5A2.1 2.1 0 0 1 19.5 6.5L7 19L3 20L4 16Z" />
    </Svg>
  );
}
/** Repeat arrows. */
export function RepeatIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M17 2L21 6L17 10M3 11V9A3 3 0 0 1 6 6H21M7 22L3 18L7 14M21 13V15A3 3 0 0 1 18 18H3" />
    </Svg>
  );
}
/** Check in a circle. */
export function CheckCircleIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5L11 15.5L16 9" />
    </Svg>
  );
}
/** Warning triangle. */
export function WarnIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M12 3.5L22 20H2Z" />
      <path d="M12 10V14M12 17.2V17.3" />
    </Svg>
  );
}
/** Info circle. */
export function InfoIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11V16M12 7.8V7.9" />
    </Svg>
  );
}
/** Chevron; `dir` points where it opens. */
export function ChevronIcon({ size, dir = 'down' }: IconProps & { dir?: 'down' | 'right' | 'left' | 'up' }) {
  const d = { down: 'M6 9L12 15L18 9', up: 'M6 15L12 9L18 15', right: 'M9 6L15 12L9 18', left: 'M15 6L9 12L15 18' }[
    dir
  ];
  return (
    <Svg size={size}>
      <path d={d} />
    </Svg>
  );
}
/** Flask (tests). */
export function FlaskIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M9 3H15M10 3V9L5 19C4.5 20 5.2 21 6.3 21H17.7C18.8 21 19.5 20 19 19L14 9V3" />
    </Svg>
  );
}
/** Branch (PR linked). */
export function BranchIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <path d="M6 8.5V15.5M8.5 6H13A5 5 0 0 1 18 11V15.5" />
    </Svg>
  );
}
/** Document (summary comment). */
export function DocIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M6 3H14L19 8V20A1 1 0 0 1 18 21H6A1 1 0 0 1 5 20V4A1 1 0 0 1 6 3ZM14 3V8H19" />
    </Svg>
  );
}
/** Target (checks the reviewer judges). */
export function TargetIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4.5" />
    </Svg>
  );
}
/** Person with a check (AI review). */
export function ReviewIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20C2.5 16.5 5.5 14.5 9 14.5M14 18L16.5 20.5L21.5 14.5" />
    </Svg>
  );
}
/** Plus. */
export function PlusIcon({ size }: IconProps) {
  return (
    <Svg size={size} sw={2.4}>
      <path d="M12 5V19M5 12H19" />
    </Svg>
  );
}
/** Close cross. */
export function CloseIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M6 6L18 18M18 6L6 18" />
    </Svg>
  );
}
/** List rows. */
export function ListIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M8 6H21M8 12H21M8 18H21M3.5 6H3.6M3.5 12H3.6M3.5 18H3.6" />
    </Svg>
  );
}
/** Four squares (week grid). */
export function GridIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
    </Svg>
  );
}
/** Skip-to-end bar. */
export function SkipIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M5 5L15 12L5 19ZM19 5V19" />
    </Svg>
  );
}
/** Catch-up arrows. */
export function RefreshIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M20 11A8 8 0 0 0 5.6 6.5L4 8.5M4 4V8.5H8.5M4 13A8 8 0 0 0 18.4 17.5L20 15.5M20 20V15.5H15.5" />
    </Svg>
  );
}
/** Padlock. */
export function LockIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="5" y="11" width="14" height="9.5" rx="2" />
      <path d="M8 11V8A4 4 0 0 1 16 8V11" />
    </Svg>
  );
}
/** Dollar sign. */
export function DollarIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M12 3V21M16.5 7.5C16 6 14.3 5 12 5C9.5 5 8 6.2 8 8C8 12 16.5 10 16.5 15C16.5 17 14.5 19 12 19C9.5 19 7.7 17.7 7.5 16" />
    </Svg>
  );
}

const CHIP: Record<string, { bg: string; color: string; border?: string }> = {
  green: { bg: '#F1F8F3', color: '#2E6F40', border: '#BFDCC7' },
  amber: { bg: '#FFF4E0', color: '#B4571F', border: '#F0D9A8' },
  red: { bg: '#FBEEEA', color: '#C4432A', border: '#F0C4B8' },
  blue: { bg: '#E8F1FA', color: '#2F6FB0', border: '#C9DDF0' },
  slate: { bg: '#EEF2F6', color: '#34455A', border: '#D3DCE6' },
  violet: { bg: '#F5F3FD', color: '#6D5DD3', border: '#D9D2F5' },
  grey: { bg: '#F1F3F2', color: '#5B6B60', border: '#E3E8E5' },
};

/** Rounded status chip with an icon slot. */
export function Pill({
  tone,
  icon,
  children,
  title,
}: {
  tone: keyof typeof CHIP;
  icon?: ReactNode;
  children: ReactNode;
  title?: string;
}) {
  const c = CHIP[tone];
  return (
    <span
      className="ai-chip"
      title={title}
      style={{ background: c.bg, color: c.color, border: `1px solid ${c.border ?? c.bg}` }}
    >
      {icon}
      {children}
    </span>
  );
}

/** Active / Paused / Ended chip of a schedule. */
export function ScheduleStateChip({ state }: { state: Schedule['state'] }) {
  if (state === 'paused')
    return (
      <Pill tone="grey" icon={<PauseIcon size={11} />}>
        Paused
      </Pill>
    );
  if (state === 'ended')
    return (
      <Pill tone="grey" icon={<CheckCircleIcon size={11} />}>
        Ended
      </Pill>
    );
  return (
    <Pill tone="slate" icon={<ClockIcon size={11} />}>
      Active
    </Pill>
  );
}

/** State chip of one slot ("Finished", "Partly done", "Failed ×3", "Skipped", "Catch-up"…). */
export function SlotChip({
  state,
  failures,
  verbose,
  catchUp,
}: {
  state: SlotState;
  /** Failures in a row, shown as ×N on a failed chip. */
  failures?: number;
  /** "Finished · passed" in the run history. */
  verbose?: boolean;
  catchUp?: boolean;
}) {
  switch (state) {
    case 'passed':
      return (
        <Pill tone="green" icon={<CheckCircleIcon size={11} />}>
          {verbose ? 'Finished · passed' : 'Finished'}
        </Pill>
      );
    case 'partly':
      return (
        <Pill tone="amber" icon={<WarnIcon size={11} />}>
          Partly done
        </Pill>
      );
    case 'failed':
      return (
        <Pill tone="red" icon={<WarnIcon size={11} />}>
          Failed{failures && failures > 1 ? ` ×${failures}` : ''}
        </Pill>
      );
    case 'skipped':
      return (
        <Pill tone="grey" icon={<SkipIcon size={11} />}>
          Skipped
        </Pill>
      );
    case 'cancelled':
      return (
        <Pill tone="grey" icon={<CloseIcon size={10} />}>
          Cancelled
        </Pill>
      );
    case 'waiting':
      return (
        <Pill tone="amber" icon={<ClockIcon size={11} />}>
          Waiting for runner
        </Pill>
      );
    case 'ask':
      return (
        <Pill tone="slate" icon={<PauseIcon size={11} />}>
          Late: run it?
        </Pill>
      );
    case 'running':
      return (
        <Pill tone="green" icon={<span className="ai-pulse sc-dot" />}>
          {catchUp ? 'Catch-up · running' : 'Running'}
        </Pill>
      );
    case 'reviewing':
      return (
        <Pill tone="violet" icon={<span className="ai-spin" style={{ width: 10, height: 10 }} />}>
          In AI review
        </Pill>
      );
    case 'fixing':
      return (
        <Pill tone="violet" icon={<span className="ai-spin" style={{ width: 10, height: 10 }} />}>
          Fixing after review
        </Pill>
      );
  }
}

/** Chip for a slot that ran late ("Catch-up"). */
export function CatchUpChip() {
  return (
    <Pill tone="blue" icon={<RefreshIcon size={11} />}>
      Catch-up
    </Pill>
  );
}

const DAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** Day names, Monday first (matches the API's `days`). */
export const DAY_NAMES = DAY;

const pad = (n: number) => String(n).padStart(2, '0');

/** "02:00" in the browser's time zone. */
export function clock(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Day name of a date, Monday first ("Tue"). */
export function dayName(d: Date): string {
  return DAY[(d.getDay() + 6) % 7];
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "Tue 02:00", with the date when it is more than six days away ("Mon Nov 4, 22:00"). */
export function fmtNext(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  const days = (d.getTime() - now.getTime()) / 86400000;
  if (days < 6 && days > -6) return `${dayName(d)} ${clock(iso)}`;
  return `${dayName(d)} ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${clock(iso)}`;
}

/** "Today 02:00", "Mon 02:00" (this week), "Oct 24 02:00" (earlier). */
export function fmtSlot(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (sameDay(d, now)) return `Today ${clock(iso)}`;
  const age = (now.getTime() - d.getTime()) / 86400000;
  if (age >= 0 && age < 6) return `${dayName(d)} ${clock(iso)}`;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${clock(iso)}`;
}

/** "18 m 40 s", "45 m 00 s", "4 s"; a dash when unknown. */
export function fmtDuration(s: number | null | undefined): string {
  if (!s) return '–';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.round(s % 60);
  if (h) return `${h} h ${pad(m)} m`;
  if (m) return `${m} m ${pad(sec)} s`;
  return `${sec} s`;
}

/** "19 min" for an average. */
export function fmtMinutes(s: number | null | undefined): string {
  if (!s) return '–';
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.max(m, 1)} min`;
}

/** The "Weekdays at 02:00 (UTC+7) · Claude Code · Backend · reviewed by Reviewer" line. */
export function scheduleLine(s: Schedule, opts: { tz?: boolean; ai?: boolean } = {}): string {
  const parts = [s.kind === 'repeat' && opts.tz ? `${s.when} (${s.tzLabel})` : s.when];
  if (opts.ai !== false && s.memberName) parts.push(s.memberName);
  if (opts.ai !== false && s.review.on && s.review.reviewerName) parts.push(`reviewed by ${s.review.reviewerName}`);
  return parts.join(' · ');
}

/** The check chips of a schedule: "4 criteria", "Tests", "PR linked", "1 judged". */
export function CheckChips({
  schedule,
  criteria,
  aiLabel,
}: {
  schedule: Schedule;
  criteria?: number;
  aiLabel?: boolean;
}) {
  const c = schedule.checks;
  const chips: { key: string; icon: ReactNode; text: string }[] = [];
  if (c.criteria)
    chips.push({
      key: 'criteria',
      icon: <CheckCircleIcon size={12} />,
      text: criteria == null ? 'Criteria' : `${criteria} criteri${criteria === 1 ? 'on' : 'a'}`,
    });
  if (c.tests.on) chips.push({ key: 'tests', icon: <FlaskIcon size={12} />, text: 'Tests' });
  if (c.summary && !chips.length) chips.push({ key: 'summary', icon: <DocIcon size={12} />, text: 'Summary' });
  if (c.branch) chips.push({ key: 'branch', icon: <BranchIcon size={12} />, text: 'PR linked' });
  if (c.aiChecks.length)
    chips.push({
      key: 'ai',
      icon: <TargetIcon size={12} />,
      text: aiLabel
        ? `${c.aiChecks.length} AI check${c.aiChecks.length === 1 ? '' : 's'}`
        : `${c.aiChecks.length} judged`,
    });
  if (!chips.length)
    return (
      <span className="ai-muted" style={{ fontSize: 12.5 }}>
        No checks
      </span>
    );
  return (
    <>
      {chips.map((x) => (
        <span key={x.key} className="sc-chip">
          {x.icon}
          {x.text}
        </span>
      ))}
    </>
  );
}

/** What a member can be picked for: the board can start it. */
export function canStart(m: AiMember): boolean {
  return m.kind === 'ai' && m.connection !== 'inbox';
}

/** The slot the person most likely wants to see first: waiting, then the newest. */
export function pickRun(runs: ScheduleRun[]): ScheduleRun | undefined {
  return runs.find((r) => r.state === 'waiting' || r.state === 'ask') ?? runs[0];
}

/** "UTC+7" style label of an IANA zone right now. */
export function zoneLabel(tz: string): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName')?.value;
    const m = part ? /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(part) : null;
    if (!m) return part === 'GMT' || !part ? 'UTC' : part;
    return `UTC${m[1]}${Number(m[2])}${m[3] && m[3] !== '00' ? `:${m[3]}` : ''}`;
  } catch {
    return tz;
  }
}
