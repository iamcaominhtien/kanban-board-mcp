import type { AiRun, RunState } from '../../../types/ai';
import { ACTIVE_STATES } from '../../../types/ai';
import { STATUS_OPTIONS } from '../../StatusMenu';
import { fmtElapsed, hhmm, shortDate } from '../aiUi';

/** Whether a run is still going. */
export const isLive = (state: RunState): boolean => ACTIVE_STATES.includes(state);

/** How long a run took, or has taken so far (to `now` while it goes on). */
export function runSeconds(run: Pick<AiRun, 'startedAt' | 'endedAt'>, now: number): number | null {
  if (!run.startedAt) return null;
  const end = run.endedAt ? new Date(run.endedAt).getTime() : now;
  return Math.max(0, Math.round((end - new Date(run.startedAt).getTime()) / 1000));
}

/** "3m 12s", or nothing before the run started. */
export const elapsedWords = (run: Pick<AiRun, 'startedAt' | 'endedAt'>, now: number): string =>
  fmtElapsed(runSeconds(run, now));

/** "12:41" today, "Oct 21" on another day. */
export function whenShort(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toDateString() !== new Date().toDateString() ? shortDate(iso) : hhmm(iso);
}

/** "Assigned by An Nguyen, 12:41": how and by whom the run began. */
export function startedByWords(run: Pick<AiRun, 'mode' | 'trigger' | 'startedBy' | 'queuedAt'>): string {
  const how =
    run.mode === 'ask'
      ? 'Ask'
      : run.trigger === 'assign'
        ? 'Assigned'
        : (run.trigger || 'started').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  return `${how} by ${run.startedBy}, ${whenShort(run.queuedAt)}`;
}

/** The board's name of a status ("in-progress" → "In Progress"). */
export function statusName(status: unknown): string {
  const key = String(status ?? '');
  return STATUS_OPTIONS.find((o) => o.status === key)?.label ?? key.replace(/[-_]/g, ' ');
}

/** The headline and the line under it for the run card: "Run #3 in progress", "Started 12:41 · 3m 12s". */
export function cardWords(run: AiRun, now: number): { title: string; sub: string } {
  const took = elapsedWords(run, now);
  const started = run.startedAt ? `Started ${hhmm(run.startedAt)}` : `Queued ${hhmm(run.queuedAt)}`;
  const n = `Run #${run.number}`;
  switch (run.state) {
    case 'queued':
      return { title: `${n} is queued`, sub: run.waitingReason ? run.waitingReason : started };
    case 'starting':
      return { title: `${n} is starting`, sub: started };
    case 'running':
      return { title: `${n} in progress`, sub: [started, took].filter(Boolean).join(' · ') };
    case 'needs_input':
      return { title: `${n} is waiting for your answer`, sub: [started, took].filter(Boolean).join(' · ') };
    case 'finished':
      return { title: `${n} finished`, sub: `Ended ${hhmm(run.endedAt)}${took ? ` · ${took}` : ''}` };
    case 'cancelled':
      return { title: `${n} was stopped`, sub: `Ended ${hhmm(run.endedAt)}${took ? ` · ${took}` : ''}` };
    case 'timed_out':
      return { title: `${n} timed out`, sub: `Ended ${hhmm(run.endedAt)}${took ? ` · ${took}` : ''}` };
    default:
      return { title: `${n} did not finish`, sub: `Ended ${hhmm(run.endedAt)}${took ? ` · ${took}` : ''}` };
  }
}
