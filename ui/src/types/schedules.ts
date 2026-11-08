/** AI schedules (design/screens/ai-schedules.md). Keys are camelCase: the API client converts them. */

export type ScheduleKind = 'once' | 'repeat';
export type ScheduleEnds = 'never' | 'after' | 'on_date';
export type ScheduleCatchUp = 'run' | 'skip' | 'ask';
export type ScheduleState = 'active' | 'paused' | 'ended';
export type ScheduleNotify = 'started' | 'needs_input' | 'failed' | 'finished';

/** What one slot is doing or how it ended. */
export type SlotState = 'waiting' | 'ask' | 'running' | 'passed' | 'partly' | 'failed' | 'skipped' | 'cancelled';

export interface ScheduleLimits {
  stopAfterMin: number;
  retries: number;
  maxCost: number | null;
}

/** What the lead said when the run finished. */
export interface ScheduleRunReport {
  status: string;
  summary: string;
  openItems: string[];
  branch: string | null;
  prUrl: string | null;
  runId: string;
}

/** One planned start (a "slot") and what came of it. */
export interface ScheduleRun {
  id: string;
  scheduleId: string;
  ticketId: string;
  slotAt: string;
  state: SlotState;
  catchUp: boolean;
  memberId: string | null;
  memberName: string | null;
  runIds: string[];
  attempts: number;
  note: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationS: number | null;
  costUsd: number;
  /** The lead's report on the slot's last run (summary, open items, branch and PR), when it finished. */
  report?: ScheduleRunReport | null;
}

export interface PreviewCheck {
  level: 'ok' | 'warn' | 'error';
  text: string;
  key: string;
}

export interface Schedule {
  id: string;
  projectId: string;
  ticketId: string;
  ticketTitle: string | null;
  ticketStatus: string | null;
  memberId: string;
  memberName: string | null;
  connection: 'local' | 'api_key' | 'inbox' | null;
  backupMemberId: string | null;
  backupMemberName: string | null;
  createdBy: string;
  kind: ScheduleKind;
  runAt: string | null;
  days: number[];
  time: string;
  tz: string;
  tzLabel: string;
  ends: ScheduleEnds;
  endsAfter: number | null;
  endsOn: string | null;
  windowEnd: string | null;
  limits: ScheduleLimits;
  catchUp: ScheduleCatchUp;
  catchUpHours: number;
  notify: ScheduleNotify[];
  notifyPeople: string[];
  instruction: string;
  state: ScheduleState;
  pausedReason: string | null;
  failuresInRow: number;
  runsCount: number;
  nextRunAt: string | null;
  nextIn: string | null;
  /** "Desktop app often closed at 02:00": a team that missed its last starts. */
  offlineRisk?: string | null;
  when: string;
  ticketChanged: boolean;
  lastRun: ScheduleRun | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleList {
  items: Schedule[];
  /** The API sends `next24h`; the client camel-cases it to `next24H`. */
  next24H: number;
  counts: { upcoming: number; paused: number; ended: number; history: number };
}

export interface ScheduleDetail extends Schedule {
  stats: {
    passed: number;
    of: number;
    avgS: number | null;
    cost: number;
    metered: boolean;
  };
  runs: ScheduleRun[];
  summary: string;
  problems: PreviewCheck[];
}

/** The editor's values, as the API takes them (also what preview and dry run send). */
export interface ScheduleDraft {
  ticketId: string;
  memberId: string;
  backupMemberId: string;
  kind: ScheduleKind;
  runAt: string;
  days: number[];
  time: string;
  tz: string;
  ends: ScheduleEnds;
  endsAfter: number | null;
  endsOn: string;
  windowEnd: string;
  limits: ScheduleLimits;
  catchUp: ScheduleCatchUp;
  catchUpHours: number;
  notify: ScheduleNotify[];
  notifyPeople: string[];
  instruction: string;
}

export interface SchedulePreview {
  summary: string;
  nextRuns: { at: string; day: string; time: string; in: string }[];
  checks: PreviewCheck[];
}

export interface DryRun {
  text: string;
  memberName: string | null;
  cost: number;
  metered: boolean;
}

export interface WeekItem {
  scheduleId: string;
  ticketId: string;
  memberId: string | null;
  at: string;
  kind: 'run' | 'past';
  paused: boolean;
  state?: SlotState;
  overlap?: boolean;
  risk?: string;
}

export interface WeekMember {
  id: string;
  name: string;
  connection: 'local' | 'api_key' | 'inbox' | null;
  maxParallel: number;
  available: boolean;
  reason: string | null;
}

export interface ScheduleWeek {
  start: string;
  days: number;
  items: WeekItem[];
  members: WeekMember[];
}

/** Footer state of a board card. */
export interface ScheduleCard {
  ticketId: string;
  scheduleId: string;
  state: 'missed' | 'soon' | 'planned' | 'paused';
  label: string;
  at?: string;
  memberId?: string;
}

/** A notification for the person (toast). */
export interface ScheduleEvent {
  id: number;
  at: string;
  projectId: string;
  scheduleId: string;
  ticketId: string;
  event: ScheduleNotify;
  text: string;
  to: string[];
  runId?: string;
  srunId?: string;
  action?: 'open_run' | 'reschedule' | 'open';
}

/** 422 body when a check fails. */
export interface ScheduleErrorBody {
  detail: string;
  code: string;
  problems?: PreviewCheck[];
}
