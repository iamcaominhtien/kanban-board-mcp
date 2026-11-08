import type { ScheduleDraft } from '../../types/schedules';

/** A ready-made schedule: the New schedule dialog's "Start from" row fills the form with it (nothing is saved). */
export interface ScheduleTemplate {
  id: string;
  label: string;
  /** One line under the label: what it does. */
  hint: string;
  /** What changes in the draft; the ticket, the team and the time zone stay as chosen. */
  patch: Partial<ScheduleDraft>;
}

const base = { ends: 'never' as const, endsAfter: null, endsOn: '', windowEnd: '' };

export const SCHEDULE_TEMPLATES: ScheduleTemplate[] = [
  {
    id: 'nightly-tests',
    label: 'Nightly test run',
    hint: 'Every night at 02:00 the team runs your tests and reports what failed.',
    patch: {
      ...base,
      kind: 'repeat',
      days: [0, 1, 2, 3, 4, 5, 6],
      time: '02:00',
      limits: { stopAfterMin: 30, retries: 1, maxCost: null },
      instruction:
        'Run the whole test suite. If something fails, find the cause and write it in the summary (the test, the file, the likely reason). Fix it only when the fix is small and clear.',
    },
  },
  {
    id: 'weekly-dependencies',
    label: 'Weekly dependency check',
    hint: 'Monday at 09:00 the team lists outdated or vulnerable packages. It upgrades nothing.',
    patch: {
      ...base,
      kind: 'repeat',
      days: [0],
      time: '09:00',
      limits: { stopAfterMin: 30, retries: 1, maxCost: null },
      instruction:
        'Check the project for outdated and vulnerable dependencies (for example npm outdated and npm audit, or pip list --outdated and pip-audit). Do not upgrade anything: list what you found in the summary, most urgent first, each with the version to move to.',
    },
  },
  {
    id: 'daily-summary',
    label: 'Daily summary',
    hint: 'Weekdays at 18:00 the team writes what moved on the board today and what waits for a person.',
    patch: {
      ...base,
      kind: 'repeat',
      days: [0, 1, 2, 3, 4],
      time: '18:00',
      limits: { stopAfterMin: 15, retries: 1, maxCost: null },
      instruction:
        'Write a short summary of today on this board: tickets that moved, runs that finished or failed, and what is waiting for a person. Read the board; change nothing.',
    },
  },
];
