import type { CommandName, JobState, Scan, ScanJob, TrialRun } from '../../../types/aiPacks';

export const COMMAND_ORDER: CommandName[] = ['prepare', 'test', 'lint', 'build'];
export const COMMAND_TITLE: Record<CommandName, string> = {
  prepare: 'Prepare',
  test: 'Test',
  lint: 'Lint',
  build: 'Build',
};

export type CommandTexts = Record<CommandName, string>;

/** The job of a scan, or null before any ran. */
export function jobOf(scan: Scan | null | undefined): ScanJob | null {
  const job = scan?.job as Partial<ScanJob> | undefined;
  return job && job.state ? (job as ScanJob) : null;
}

/** "3:02", "0:12". */
export function clock(s: number): string {
  const n = Math.max(0, Math.round(s));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}

/** "42 s", "1 min 04 s". */
export function secondsText(s: number): string {
  const n = Math.round(s);
  if (n < 60) return `${n} s`;
  return `${Math.floor(n / 60)} min ${String(n % 60).padStart(2, '0')} s`;
}

/** What the strip says of a job: its pill. */
export function jobPill(state: JobState): { label: string; tone: 'work' | 'ok' | 'bad' | 'warn' | 'grey' } {
  switch (state) {
    case 'running':
      return { label: 'Working', tone: 'work' };
    case 'done':
      return { label: 'Done', tone: 'ok' };
    case 'timeout':
      return { label: 'Out of time', tone: 'warn' };
    case 'failed':
      return { label: 'Did not finish', tone: 'bad' };
    case 'cancelled':
      return { label: 'Stopped', tone: 'grey' };
  }
}

/** The proposal's command texts (what the AI proposed), or null while it has none. */
export function proposedTexts(scan: Scan | null | undefined): CommandTexts | null {
  const commands = (scan?.proposal as { commands?: Partial<Record<CommandName, { command: string }>> } | undefined)
    ?.commands;
  if (!commands) return null;
  const out = {} as CommandTexts;
  for (const n of COMMAND_ORDER) out[n] = commands[n]?.command ?? '';
  return out;
}

/** "ci.yml · job ui" → file "ci.yml", rest "· job ui"; "ui/package.json › scripts.test" → rest "› scripts.test". */
export function sourceParts(source: string | undefined): { file: string; rest: string } | null {
  const s = (source ?? '').trim();
  if (!s) return null;
  const m = /^(\S+)\s*(.*)$/.exec(s);
  return m ? { file: m[1], rest: m[2] } : null;
}

export type RowKind =
  'empty' | 'untried' | 'waiting' | 'running' | 'works' | 'fails' | 'wrong' | 'timeout' | 'not_run' | 'changed';

export interface RowView {
  kind: RowKind;
  /** The text of the chip. */
  chip: string;
  /** The line under the chip. */
  sub: string | null;
  /** The last output lines to show with it. */
  tail: string[];
  /** A sentence under the output (an explanation the board can stand behind). */
  note: string | null;
}

/** How one row reads: the server's status for the command as it was run, or a note that the box changed since. */
export function rowView(
  name: CommandName,
  text: string,
  trial: TrialRun | null | undefined,
  job: ScanJob | null,
): RowView {
  const blank = (kind: RowKind, chip: string, sub: string | null = null): RowView => ({
    kind,
    chip,
    sub,
    tail: [],
    note: null,
  });
  const step = job?.state === 'running' ? job.steps.find((s) => s.key === name) : undefined;
  if (!text.trim()) return blank('empty', 'Empty', name === 'lint' || name === 'build' ? 'Optional' : null);
  if (step?.state === 'running' || trial?.status === 'running') return blank('running', 'Running');
  if (step?.state === 'waiting' || trial?.status === 'waiting') return blank('waiting', 'Waiting');
  if (!trial || !trial.status) return blank('untried', 'Not tried yet');
  const tail = trial.tail ?? [];
  const base = { tail, note: null as string | null };
  if (trial.command.trim() !== text.trim())
    return { ...base, kind: 'changed', chip: 'Changed since the last run', sub: null };
  switch (trial.status) {
    case 'works':
      return {
        ...base,
        kind: 'works',
        chip: `Works · ${secondsText(trial.seconds)}`,
        sub: 'The board ran it, the way a ticket does, and it exited 0.',
      };
    case 'fails':
      return {
        ...base,
        kind: 'fails',
        chip: 'Runs · the repo’s own tests fail',
        sub: `Exit ${trial.exitCode ?? '?'} after ${Math.round(trial.seconds)} s.`,
        note: 'The command is right. The repository fails its own tests, lint or build; the AI did not change anything to make them pass.',
      };
    case 'wrong':
      return {
        ...base,
        kind: 'wrong',
        chip: `Command is wrong · exit ${trial.exitCode ?? '?'}`,
        sub: trial.reason?.startsWith('The shell')
          ? trial.reason
          : `The shell could not run it${trial.reason ? `: ${trial.reason}` : '.'}`,
      };
    case 'timeout':
      return {
        ...base,
        kind: 'timeout',
        chip: 'Timed out · 10 min',
        sub: 'The command did not end in time and was stopped.',
      };
    case 'not_run':
      return notRun(base, trial.reason);
    default:
      return blank('untried', 'Not tried yet');
  }
}

/** "Not run": a reason is always given; the AI running out of time reads "timed out" and says what to do. */
function notRun(base: { tail: string[]; note: string | null }, reason: string | null | undefined): RowView {
  const r = reason ?? '';
  if (/stopped after 10 minutes/i.test(r))
    return { ...base, kind: 'not_run', chip: 'Not run · timed out', sub: 'Type one, or run the AI again.' };
  if (/^cancelled/i.test(r)) return { ...base, kind: 'not_run', chip: 'Not run · stopped', sub: null };
  return { ...base, kind: 'not_run', chip: `Not run${r ? ` · ${r}` : ''}`, sub: null };
}

/** Which commands are kept when the AI runs again: the ones the person typed with no proof yet, and the ones that work. */
export function keepList(texts: CommandTexts, trial: Scan['trial'] | undefined): CommandName[] {
  return COMMAND_ORDER.filter((n) => {
    const text = texts[n].trim();
    if (!text) return false;
    const run = trial?.[n];
    if (!run) return true;
    return run.command.trim() === text && run.status === 'works';
  });
}
