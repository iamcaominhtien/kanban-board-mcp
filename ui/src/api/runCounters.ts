import { useCallback, useSyncExternalStore } from 'react';

/**
 * The live step counter of each running AI, from its `ai.step` events (api/aiRunCache.ts). It is kept out of the
 * query cache on purpose: the AI board there is read by every card and column, so moving a counter in it rendered the
 * whole board under an open ticket every few seconds. Here only the line that shows "step N" for that run renders.
 */
interface Counter {
  stepsCount: number;
  lastOutputAt: string | null;
}

const counters = new Map<string, Counter>();
const listeners = new Map<string, Set<() => void>>();

/** Note a run's newest counter and tell whoever shows it. */
export function setRunCounter(runId: string, counter: Counter): void {
  const old = counters.get(runId);
  if (old && old.stepsCount === counter.stepsCount && old.lastOutputAt === counter.lastOutputAt) return;
  counters.set(runId, counter);
  if (counters.size > 500) counters.delete(counters.keys().next().value as string);
  listeners.get(runId)?.forEach((fn) => fn());
}

/** Forget every counter (tests). */
export function resetRunCounters(): void {
  counters.clear();
}

/** The newest counter of a run, if one arrived. */
export function runCounter(runId: string): Counter | undefined {
  return counters.get(runId);
}

/**
 * How many steps a run has made: the newest of the live counter and `fallback` (what the run's own data says).
 * @param runId - The run; nothing live without one.
 * @param fallback - The count from the run's data (the board, the run list).
 */
export function useRunStepsCount(runId: string | null | undefined, fallback: number): number {
  const subscribe = useCallback(
    (fn: () => void) => {
      if (!runId) return () => undefined;
      let set = listeners.get(runId);
      if (!set) listeners.set(runId, (set = new Set()));
      set.add(fn);
      return () => {
        set.delete(fn);
        if (!set.size) listeners.delete(runId);
      };
    },
    [runId],
  );
  const live = useSyncExternalStore(subscribe, () => (runId ? counters.get(runId)?.stepsCount : undefined));
  return Math.max(live ?? 0, fallback);
}
