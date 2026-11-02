import type { CheckName, CommandName, Proposal, Scan, ScanJob, TrialRun } from '../../../types/aiPacks';

/** The four commands, in the order a ticket meets them. */
export const COMMANDS: CommandName[] = ['prepare', 'test', 'lint', 'build'];
/** The ones the Checks step of a workflow runs. */
export const CHECKS: CheckName[] = ['test', 'lint', 'build'];

export const ROW_NAME: Record<CommandName, string> = {
  prepare: 'Prepare',
  test: 'Test',
  lint: 'Lint',
  build: 'Build',
};
/** The words under a row's name (design D1). */
export const ROW_ROLE: Record<CommandName, string> = {
  prepare: 'before a ticket starts',
  test: 'a ticket must pass',
  lint: 'a workflow check',
  build: 'a workflow check',
};
/** What an empty box says (design E2). */
export const ROW_PLACEHOLDER: Record<CommandName, string> = {
  prepare: 'Leave empty if nothing needs to run first',
  test: 'The command that runs the tests',
  lint: 'Optional',
  build: 'Optional',
};

/** The scan's job, or null before any ran. */
export function jobOf(scan: Scan | null | undefined): ScanJob | null {
  const j = scan?.job as Partial<ScanJob> | undefined;
  return j && j.state ? (j as ScanJob) : null;
}

/** What the AI proposed, or null before it ran. */
export function proposalOf(scan: Scan | null | undefined): Proposal | null {
  const p = scan?.proposal as Partial<Proposal> | undefined;
  return p && p.commands ? (p as Proposal) : null;
}

/** "0.4 s", "42 s", "1 min 04 s". */
export function fmtSeconds(s: number): string {
  if (s > 0 && s < 1) return `${s.toFixed(1)} s`; // a fast command is not "0 s"
  const n = Math.max(0, Math.round(s));
  if (n < 60) return `${n} s`;
  return `${Math.floor(n / 60)} min ${String(n % 60).padStart(2, '0')} s`;
}

/** "0:48". */
export function clock(s: number): string {
  const n = Math.max(0, Math.floor(s));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}

/** What a row shows: nothing typed, typed but never run, edited since the run, or the run's own status. */
export type RowKind = 'empty' | 'untried' | 'changed' | TrialRun['status'];

/** The look of one command row from its box and the board's last run of it. */
export function rowKind(text: string, run: TrialRun | null | undefined): RowKind {
  const t = text.trim();
  if (!t) return 'empty';
  if (!run) return 'untried';
  if (t !== run.command) return 'changed';
  return run.status;
}

/** A command the board proved wrong or failing: as a check it would send tickets back to Dev. */
export function isBad(kind: RowKind): boolean {
  return kind === 'fails' || kind === 'wrong';
}

/** "2 of 214 tests" from a test runner's last lines (null: not recognised). */
export function failCounts(tail: string[]): { failed: number; total: number } | null {
  for (const line of [...tail].reverse()) {
    const m = /(\d+)\s+failed.*?\((\d+)\)/i.exec(line);
    if (m && /tests?/i.test(line)) return { failed: Number(m[1]), total: Number(m[2]) };
  }
  return null;
}

/** Colour of a line in the dark output boxes. */
export function logTone(line: string): 'cmd' | 'bad' | 'good' | 'plain' | 'dim' {
  if (/^(board)?\$ /.test(line)) return 'cmd';
  if (/\b(error|fail(ed|ure|s)?|not found|missing|cannot|denied)\b/i.test(line)) return 'bad';
  if (/\b(pass(ed)?|works|done|ok)\b/i.test(line) && !/\bfail/i.test(line)) return 'good';
  if (/^(AI proposed|Test Files|Tests |Duration)/.test(line)) return 'dim';
  return 'plain';
}
