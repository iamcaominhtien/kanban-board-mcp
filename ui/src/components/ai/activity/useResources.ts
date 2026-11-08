import { useEffect, useState } from 'react';
import camelcaseKeys from 'camelcase-keys';
import { subscribeSSE } from '../../../hooks/sseEvents';
import type { ResourceRun, ResourceSnapshot } from '../../../types/aiResources';

/** What the stream last said about one run: its row, the project's limits and when it arrived. */
export interface RunResources {
  run: ResourceRun;
  limitMb: number;
  autoRestarts: number;
  at: number;
}

/**
 * The CLI's RAM and CPU of a run, live. The monitor lives in the runner process, so the numbers come over the event
 * stream as `ai.resources` (every 2 s while a CLI runs), not from a request. Nothing before the first event.
 */
export function useRunResources(runId: string | undefined): RunResources | null {
  const [state, setState] = useState<RunResources | null>(null);
  useEffect(() => {
    setState(null);
    if (!runId) return;
    return subscribeSSE((data) => {
      if (!data.startsWith('{') || !data.includes('"ai.resources"')) return;
      try {
        const snap = camelcaseKeys(JSON.parse(data) as Record<string, unknown>, {
          deep: true,
        }) as unknown as ResourceSnapshot & { type: string };
        if (snap.type !== 'ai.resources') return;
        const run = snap.runs.find((r) => r.runId === runId);
        if (run)
          setState({
            run,
            limitMb: snap.limits.runMemoryLimitMb,
            autoRestarts: snap.limits.autoRestarts,
            at: Date.now(),
          });
      } catch {
        /* a broken frame: wait for the next one */
      }
    });
  }, [runId]);
  return state;
}
