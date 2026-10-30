/** Decision logic of keeping pages true, Docs health and tickets from a page (docs-ai-care A and C). Pure, so it is tested. */

export interface CareReason {
  key: string;
  kind: 'ticket' | 'page' | 'reported' | 'check' | string;
  ref: string;
  text: string;
  /** What was compared ("ticket KAN-12 (status, title, recent comments)"). */
  compared: string;
  quote?: string;
}

/** "Checked today 06:10", "Checked yesterday", "Checked 3 days ago". */
export function checkedLabel(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return 'Not checked yet';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'Not checked yet';
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86400000);
  if (days <= 0) {
    const hh = String(at.getHours()).padStart(2, '0');
    const mm = String(at.getMinutes()).padStart(2, '0');
    return `Checked today ${hh}:${mm}`;
  }
  if (days === 1) return 'Checked yesterday';
  if (days < 14) return `Checked ${days} days ago`;
  return `Checked ${at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

/** The ticket the banner offers to open: the first ticket among the reasons. */
export function firstTicketRef(reasons: CareReason[]): string | null {
  return reasons.find((r) => r.kind === 'ticket' && r.ref)?.ref ?? null;
}

/** Whether the banner shows: editors only, Docs AI on, and the check says the page may be out of date. */
export function showFreshnessBanner(opts: {
  canEdit: boolean;
  aiOn: boolean;
  stale: boolean;
  hiddenFromAi: boolean;
}): boolean {
  return opts.canEdit && opts.aiOn && opts.stale && !opts.hiddenFromAi;
}

export type HealthTab = 'outOfDate' | 'missing' | 'broken' | 'overlaps';

export interface HealthCounts {
  outOfDate: number;
  missing: number;
  broken: number;
  overlaps: number;
  total: number;
}

/** Tabs with their counts ("Out of date 3"). */
export function healthTabs(counts: HealthCounts): { id: HealthTab; label: string; count: number }[] {
  return [
    { id: 'outOfDate', label: 'Out of date', count: counts.outOfDate },
    { id: 'missing', label: 'Missing docs', count: counts.missing },
    { id: 'broken', label: 'Broken links', count: counts.broken },
    { id: 'overlaps', label: 'Overlaps', count: counts.overlaps },
  ];
}

/** The tab to open first: the first one with something in it, else Out of date. */
export function defaultHealthTab(counts: HealthCounts): HealthTab {
  return healthTabs(counts).find((t) => t.count > 0)?.id ?? 'outOfDate';
}

/** The three dismiss levels, in the order of the menu. */
export const DISMISS_LEVELS = [
  { id: 'once', label: 'This time' },
  { id: '30d', label: 'For 30 days' },
  { id: 'never', label: 'Never' },
] as const;

export type DismissLevel = (typeof DISMISS_LEVELS)[number]['id'];

/** "Done 3 days ago" style note is made by the server; this is the heading of the Missing docs list. */
export function missingHeading(n: number): string {
  return `${n} Done ticket${n === 1 ? '' : 's'} that no page mentions`;
}

export interface TicketDraft {
  n: number;
  text: string;
  title: string;
  type: string;
  projectId: string;
  column: string;
  suggestedAssignee: { memberId: string; name: string } | null;
  dueDate: string | null;
}

export interface EditableDraft extends TicketDraft {
  /** The review step: a draft can be left out. */
  include: boolean;
  /** Only set when the person accepts the suggestion; the default is Unassigned. */
  assigneeId: string | null;
}

/** Drafts as the dialog edits them: all included, nobody assigned. */
export function toEditable(drafts: TicketDraft[]): EditableDraft[] {
  return drafts.map((d) => ({ ...d, include: true, assigneeId: null }));
}

/** "Create 2 tickets" (or "Create ticket"). */
export function createLabel(n: number): string {
  return n === 1 ? 'Create 1 ticket' : `Create ${n} tickets`;
}

/** Whether the create button works: at least one included draft, and every included draft has a title. */
export function canCreate(drafts: EditableDraft[]): boolean {
  const on = drafts.filter((d) => d.include);
  return on.length > 0 && on.every((d) => d.title.trim().length > 0);
}

const COLUMN_NAMES: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  'in-progress': 'In Progress',
  review: 'Review',
  testing: 'Testing',
  done: 'Done',
  wont_do: "Won't do",
};

/** A board column as people read it. */
export function columnLabel(column: string): string {
  return COLUMN_NAMES[column] ?? column;
}

/** The Undo toast: "2 tickets created in Backlog". */
export function createdToast(n: number, column: string): string {
  return `${n} ticket${n === 1 ? '' : 's'} created in ${columnLabel(column)}`;
}

/** "Due Fri Oct 30" from an ISO date, or null. */
export function dueLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return null;
  const date = new Date(y, m - 1, d);
  return `Due ${date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`;
}

/** The body of the create request for the included drafts. */
export function createBody(drafts: EditableDraft[], replaceText: boolean, link: boolean) {
  return {
    drafts: drafts
      .filter((d) => d.include)
      .map((d) => ({
        title: d.title.trim(),
        text: d.text,
        type: d.type,
        column: d.column,
        projectId: d.projectId,
        assigneeId: d.assigneeId,
        dueDate: d.dueDate,
      })),
    replaceText,
    link,
  };
}

/** Initials for the assignee chip ("Hoa Mai" -> "HM"). */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

/** A change from a proposal, as the suggested-edits view shows it. */
export interface CareChange {
  n: number;
  title: string;
  reason: string;
  old: string;
  new: string;
  status: 'pending' | 'accepted' | 'rejected';
  stale?: boolean;
}

/** The change to show now: the first pending one that still applies. */
export function currentChange(changes: CareChange[]): CareChange | null {
  return changes.find((c) => c.status === 'pending' && !c.stale) ?? null;
}

/** How many changes still wait for a decision ("Accept all (2)"). */
export function pendingCount(changes: CareChange[]): number {
  return changes.filter((c) => c.status === 'pending' && !c.stale).length;
}
