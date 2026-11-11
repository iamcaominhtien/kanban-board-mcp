import type { QueryClient } from '@tanstack/react-query';
import camelcaseKeys from 'camelcase-keys';
import type { AiMessageEvent, AiRun, AiRunEvent, AiRunFull, AiStepEvent, BoardRun, RunStep } from '../types/ai';
import { aiKeys, type AiBoardData } from './ai';
import { resetRunCounters, setRunCounter } from './runCounters';

/** Steps by seq, oldest first, each seq once (a later copy replaces an earlier one: its output may have arrived). */
export function mergeSteps(old: RunStep[], incoming: RunStep[]): RunStep[] {
  if (!incoming.length) return old;
  const bySeq = new Map<number, RunStep>();
  for (const s of old) bySeq.set(s.seq, s);
  for (const s of incoming) bySeq.set(s.seq, s);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** The typed SSE events of the AI, with their keys camel-cased like every response. Anything else: null. */
export function parseAiEvent(data: string): AiStepEvent | AiRunEvent | AiMessageEvent | null {
  if (!data || data[0] !== '{') return null;
  let raw: { type?: unknown };
  try {
    raw = JSON.parse(data) as { type?: unknown };
  } catch {
    return null;
  }
  if (raw.type !== 'ai.step' && raw.type !== 'ai.run' && raw.type !== 'ai.message' && raw.type !== 'ai.agent')
    return null;
  return camelcaseKeys(raw as Record<string, unknown>, { deep: true }) as unknown as
    AiStepEvent | AiRunEvent | AiMessageEvent;
}

function patchBoard(qc: QueryClient, match: (r: BoardRun) => boolean, patch: (r: BoardRun) => BoardRun) {
  qc.setQueriesData<AiBoardData>({ queryKey: ['ai', 'board'] }, (old) => {
    if (!old) return old;
    let changed = false;
    const tickets: Record<string, BoardRun> = {};
    for (const [key, r] of Object.entries(old.tickets)) {
      if (match(r)) {
        tickets[key] = patch(r);
        changed = true;
      } else tickets[key] = r;
    }
    return changed ? { tickets } : old;
  });
}

function patchTicketRuns(qc: QueryClient, runId: string, patch: (r: AiRun) => AiRun) {
  qc.setQueriesData<AiRun[]>({ queryKey: ['ai', 'ticketRuns'] }, (old) => {
    if (!old || !old.some((r) => r.id === runId)) return old;
    return old.map((r) => (r.id === runId ? patch(r) : r));
  });
}

function patchProjectRuns(qc: QueryClient, runId: string, patch: (r: AiRun) => AiRun) {
  qc.setQueriesData<AiRun[]>({ queryKey: ['ai', 'runs'] }, (old) => {
    if (!old || !old.some((r) => r.id === runId)) return old;
    return old.map((r) => (r.id === runId ? patch(r) : r));
  });
}

/** How often the step counters of the running AIs may change the run lists (and the board, on a change of state). */
export const COUNTERS_EVERY_MS = 5000;

type Counters = Pick<AiStepEvent, 'state' | 'stepsCount' | 'lastOutputAt'>;

// The newest counters of each run, waiting for the next write; one write for every run at once
const pending = new Map<string, Counters>();
let lastWrite = -Infinity;
let timer: ReturnType<typeof setTimeout> | undefined;

function counted<T extends { state: AiRun['state']; stepsCount: number; lastOutputAt: string | null }>(
  r: T,
  c: Counters,
  withState: boolean,
): T {
  // a batch written later carries only the counters: a state it held may be older than what a refetch or an `ai.run`
  // put there since (a change of state is written at once, with `withState`)
  return {
    ...r,
    state: withState ? c.state : r.state,
    stepsCount: Math.max(c.stepsCount, r.stepsCount),
    lastOutputAt: c.lastOutputAt ?? r.lastOutputAt,
  };
}

/**
 * Write the waiting counters of every run on the run lists, at once. The board gets them only with a change of state
 * (`board`): its cards show their live "step N" from api/runCounters.ts, and a board entry that moved rendered every
 * card and column of the board.
 */
function writeCounters(qc: QueryClient, now: number, board = false): void {
  clearTimeout(timer);
  timer = undefined;
  lastWrite = now;
  if (!pending.size) return;
  const all = new Map(pending);
  pending.clear();
  if (board)
    patchBoard(
      qc,
      (r) => all.has(r.runId),
      (r) => counted(r, all.get(r.runId) as Counters, true),
    );
  for (const [runId, c] of all) {
    patchTicketRuns(qc, runId, (r) => counted(r, c, board));
    patchProjectRuns(qc, runId, (r) => counted(r, c, board));
  }
}

/**
 * Put a step batch's counters where they show. The live "step N" goes to api/runCounters.ts at once (only that line
 * renders). The board and the run lists are read by the App, every card, column, ticket and comment box: a run
 * streaming a batch a second re-rendered the whole app a second, once per running AI (typing a comment lagged). So a
 * change of state goes to the board at once; the counters go to the run lists, for all runs together, at most every
 * COUNTERS_EVERY_MS, and to the board not at all.
 */
function queueCounters(qc: QueryClient, ev: AiStepEvent, now: number): void {
  setRunCounter(ev.runId, { stepsCount: ev.stepsCount, lastOutputAt: ev.lastOutputAt ?? null });
  const boards = qc.getQueriesData<AiBoardData>({ queryKey: ['ai', 'board'] });
  const held = boards.map(([, d]) => Object.values(d?.tickets ?? {}).find((r) => r.runId === ev.runId)).find(Boolean);
  pending.set(ev.runId, { state: ev.state, stepsCount: ev.stepsCount, lastOutputAt: ev.lastOutputAt });
  if (held && held.state !== ev.state) {
    writeCounters(qc, now, true);
  } else if (now - lastWrite >= COUNTERS_EVERY_MS) {
    writeCounters(qc, now);
  } else if (timer === undefined) {
    timer = setTimeout(() => writeCounters(qc, Date.now()), lastWrite + COUNTERS_EVERY_MS - now);
  }
}

/** Forget the waiting counters and when they were last written (tests). */
export function resetCounterThrottle(): void {
  resetRunCounters();
  clearTimeout(timer);
  timer = undefined;
  pending.clear();
  lastWrite = -Infinity;
}

/**
 * `ai.step`: a batch of a run's steps. They go on the run in the cache when it is there (a run nobody opened takes
 * nothing), the counter to the line that shows it (api/runCounters.ts), a change of state to the board entry and the
 * run lists, and the counters to the run lists (all runs together, at most every COUNTERS_EVERY_MS). A batch that left out steps (`truncated`) or does not follow the ones held makes the open run
 * refetch.
 */
export function applyStepEvent(qc: QueryClient, ev: AiStepEvent, now = Date.now()): void {
  const runKey = aiKeys.run(ev.runId);
  const run = qc.getQueryData<AiRunFull>(runKey);
  if (run) {
    const last = run.steps.length ? run.steps[run.steps.length - 1].seq : 0;
    const first = ev.steps.length ? ev.steps[0].seq : 0;
    if (ev.truncated || (last && first && first > last + 1)) {
      void qc.invalidateQueries({ queryKey: runKey, exact: true });
    } else {
      qc.setQueryData<AiRunFull>(runKey, {
        ...run,
        ...(ev.fields ?? {}),
        state: ev.state,
        stepsCount: ev.stepsCount,
        lastOutputAt: ev.lastOutputAt ?? run.lastOutputAt,
        agents: ev.agents ?? run.agents,
        steps: mergeSteps(run.steps, ev.steps),
      });
    }
  }
  queueCounters(qc, ev, now);
}

/**
 * `ai.run`: a run changed state or fields. It replaces the run in the cache (keeping the steps and agents held), the
 * ticket's run list and the board entry; the overview and the live panel are asked again, because the number of
 * active runs changed.
 */
export function applyRunEvent(qc: QueryClient, ev: AiRunEvent): void {
  const run = ev.run;
  // counters waiting for their write are older than this: they must not put back a state the run left
  pending.delete(run.id);
  qc.setQueryData<AiRunFull>(aiKeys.run(run.id), (old) => (old ? { ...old, ...run } : old));
  if (run.ticketId) {
    qc.setQueryData<AiRun[]>(aiKeys.ticketRuns(run.ticketId), (old) => {
      if (!old) return old;
      if (old.some((r) => r.id === run.id)) return old.map((r) => (r.id === run.id ? run : r));
      return [run, ...old].sort((a, b) => b.number - a.number);
    });
    qc.setQueriesData<AiBoardData>({ queryKey: ['ai', 'board'] }, (old) => {
      if (!old) return old;
      const current = old.tickets[run.ticketId as string];
      if (current && current.runId !== run.id && current.number > run.number) return old;
      const entry: BoardRun = {
        ticketId: run.ticketId as string,
        runId: run.id,
        memberId: run.memberId,
        state: run.state,
        number: run.number,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        lastOutputAt: run.lastOutputAt,
        stepsCount: run.stepsCount,
        summary: run.summary,
        question: run.question,
      };
      return { tickets: { ...old.tickets, [entry.ticketId]: entry } };
    });
  }
  patchProjectRuns(qc, run.id, () => run);
  void qc.invalidateQueries({ queryKey: ['ai', 'overview'] });
  void qc.invalidateQueries({ queryKey: ['ai', 'live'] });
  void qc.invalidateQueries({ queryKey: ['ai', 'teams'] });
  // A run that started or ended moved files and branches of the ticket's workspace.
  void qc.invalidateQueries({ queryKey: ['ticket_workspace'] });
  void qc.invalidateQueries({ queryKey: ['ticket_branches'] });
}

/** `ai.message`: the run's message list changed. */
export function applyMessageEvent(qc: QueryClient, ev: AiMessageEvent): void {
  void qc.invalidateQueries({ queryKey: aiKeys.runMessages(ev.runId), exact: true });
}

// `{"type": "ai.…"` at the start: how the server writes a typed AI event (events.publish_typed)
const AI_TYPED = /^\{\s*"type"\s*:\s*"ai\./;

/**
 * Route one SSE message. Returns true when it was an AI event (so the generic invalidation is skipped). A typed AI
 * event handled elsewhere (`ai.resources`, RAM and CPU every 2 s, read by useResources) or not known here is never a
 * reason to refetch: taken for "anything changed", it made the whole app refetch everything while an AI ran.
 */
export function applyAiEvent(qc: QueryClient, data: string): boolean {
  const ev = parseAiEvent(data);
  if (!ev) return AI_TYPED.test(data);
  if (ev.type === 'ai.step') applyStepEvent(qc, ev);
  else if (ev.type === 'ai.run') applyRunEvent(qc, ev);
  else if (ev.type === 'ai.message') applyMessageEvent(qc, ev);
  else void qc.invalidateQueries({ queryKey: ['ai', 'run'] });
  return true;
}
