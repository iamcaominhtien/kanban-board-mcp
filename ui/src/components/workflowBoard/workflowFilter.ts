import type { WorkflowBoardRow, WorkflowFilterState } from '../../types/aiWorkflowBoard';

export const NO_WORKFLOW_FILTER: WorkflowFilterState = {
  waitingForMe: false,
  role: 'all',
  template: 'all',
  step: 'all',
};

/** Role pack keys and the two-letter chips they wear. */
export const ROLE_CHIPS: Record<string, string> = {
  triage: 'TR',
  pm: 'PM',
  ba: 'BA',
  designer: 'DS',
  dev: 'DV',
  qa: 'QA',
  user_tester: 'UT',
  reviewer: 'RV',
};

export const ROLE_NAMES: Record<string, string> = {
  triage: 'Triage',
  pm: 'PM',
  ba: 'BA',
  designer: 'Designer',
  dev: 'Dev',
  qa: 'QA',
  user_tester: 'User tester',
  reviewer: 'Reviewer',
};

/** The two-letter chip of a role. */
export function roleChip(role: string | null): string | null {
  if (!role) return null;
  return ROLE_CHIPS[role] ?? role.slice(0, 2).toUpperCase();
}

/** The display name of a role. */
export function roleName(role: string): string {
  return ROLE_NAMES[role] ?? role;
}

/** Whether any workflow filter is on. */
export function isFilterActive(f: WorkflowFilterState): boolean {
  return f.waitingForMe || f.role !== 'all' || f.template !== 'all' || f.step !== 'all';
}

/**
 * Whether a ticket passes the workflow filters. A ticket with no workflow row passes only while no filter is on,
 * because every one of these filters is about something a workflow gives a ticket.
 */
export function matchesWorkflowFilter(row: WorkflowBoardRow | undefined, f: WorkflowFilterState): boolean {
  if (!isFilterActive(f)) return true;
  if (!row) return false;
  if (f.waitingForMe && !row.waitsForPerson) return false;
  if (f.role !== 'all' && row.role !== f.role) return false;
  if (f.template !== 'all' && row.templateKey !== f.template) return false;
  if (f.step !== 'all' && row.step !== f.step) return false;
  return true;
}

export interface WorkflowFilterOptions {
  roles: string[];
  templates: { key: string; name: string }[];
  steps: string[];
  waitingCount: number;
}

/** What the dropdowns offer, from the rows that exist. Empty when no ticket is on a workflow. */
export function workflowFilterOptions(rows: WorkflowBoardRow[]): WorkflowFilterOptions {
  const roles = new Set<string>();
  const steps = new Set<string>();
  const templates = new Map<string, string>();
  let waitingCount = 0;
  for (const r of rows) {
    if (r.role) roles.add(r.role);
    if (r.step) steps.add(r.step);
    templates.set(r.templateKey, r.templateName);
    if (r.waitsForPerson) waitingCount += 1;
  }
  return {
    roles: [...roles].sort(),
    templates: [...templates].map(([key, name]) => ({ key, name })),
    steps: [...steps].sort(),
    waitingCount,
  };
}
