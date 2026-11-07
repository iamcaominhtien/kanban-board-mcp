import type { NotificationRow } from '../../types/notifications';

/** The six filters of Needs you (design/screens/ai-operations.md, D): every kind lands in exactly one of five. */
export type NeedsFilter = 'all' | 'faults' | 'decision' | 'asked' | 'code' | 'accounts';

export const NEEDS_FILTERS: { id: NeedsFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'faults', label: 'Board faults' },
  { id: 'decision', label: 'Needs a decision' },
  { id: 'asked', label: 'Asked you' },
  { id: 'code', label: 'Code' },
  { id: 'accounts', label: 'Accounts' },
];

const ASKED = new Set(['question', 'approval', 'access_request', 'mention']);
const CODE = new Set(['merge_conflict']);
const ACCOUNTS = new Set(['account_signed_out', 'window_urgent', 'offline']);

/** What the board's diagnosis says about a row, when it carries one. */
export function diagnosisOf(row: NotificationRow): Record<string, unknown> | null {
  const d = row.data?.diagnosis;
  return d && typeof d === 'object' ? (d as Record<string, unknown>) : null;
}

/** A board fault: the board's own part failed (a MCP, token, worktree or port), not the AI. */
export function isBoardFault(row: NotificationRow): boolean {
  return row.kind === 'board_fault' || diagnosisOf(row)?.boardFault === true;
}

/** The one filter (besides All) a Needs you row belongs to. Whatever is not asked, code or accounts is a decision. */
export function needsFilterOf(row: NotificationRow): Exclude<NeedsFilter, 'all'> {
  if (isBoardFault(row)) return 'faults';
  if (ASKED.has(row.kind)) return 'asked';
  if (CODE.has(row.kind)) return 'code';
  if (ACCOUNTS.has(row.kind)) return 'accounts';
  return 'decision';
}

/** The rows of one filter (all of them for All). */
export function applyNeedsFilter(rows: NotificationRow[], filter: NeedsFilter): NotificationRow[] {
  return filter === 'all' ? rows : rows.filter((r) => needsFilterOf(r) === filter);
}

/** How many open rows each filter holds (done rows are not counted). */
export function needsFilterCounts(rows: NotificationRow[]): Record<NeedsFilter, number> {
  const out: Record<NeedsFilter, number> = { all: 0, faults: 0, decision: 0, asked: 0, code: 0, accounts: 0 };
  for (const r of rows) {
    if (r.done) continue;
    out.all += 1;
    out[needsFilterOf(r)] += 1;
  }
  return out;
}
