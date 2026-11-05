import type { QueryClient } from '@tanstack/react-query';
import camelcaseKeys from 'camelcase-keys';
import type { AiMessageEvent, AiRun, AiRunEvent, AiRunFull, AiStepEvent, BoardRun, RunStep } from '../types/ai';
import { aiKeys, type AiBoardData } from './ai';

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

/**
 * `ai.step`: a batch of a run's steps. They go on the run in the cache when it is there (a run nobody opened takes
 * nothing), and the counters and state go on the board entry and the ticket's run list. A batch that left out steps
 * (`truncated`) or does not follow the ones held makes the open run refetch.
 */
export function applyStepEvent(qc: QueryClient, ev: AiStepEvent): void {
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
  const counters = <T extends { state: AiRun['state']; stepsCount: number; lastOutputAt: string | null }>(r: T): T => ({
    ...r,
    state: ev.state,
    stepsCount: ev.stepsCount,
    lastOutputAt: ev.lastOutputAt ?? r.lastOutputAt,
  });
  patchBoard(qc, (r) => r.runId === ev.runId, counters);
  patchTicketRuns(qc, ev.runId, counters);
  patchProjectRuns(qc, ev.runId, counters);
}

/**
 * `ai.run`: a run changed state or fields. It replaces the run in the cache (keeping the steps and agents held), the
 * ticket's run list and the board entry; the overview and the live panel are asked again, because the number of
 * active runs changed.
 */
export function applyRunEvent(qc: QueryClient, ev: AiRunEvent): void {
  const run = ev.run;
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

/** Route one SSE message. Returns true when it was an AI event (so the generic invalidation is skipped). */
export function applyAiEvent(qc: QueryClient, data: string): boolean {
  const ev = parseAiEvent(data);
  if (!ev) return false;
  if (ev.type === 'ai.step') applyStepEvent(qc, ev);
  else if (ev.type === 'ai.run') applyRunEvent(qc, ev);
  else if (ev.type === 'ai.message') applyMessageEvent(qc, ev);
  else void qc.invalidateQueries({ queryKey: ['ai', 'run'] });
  return true;
}
