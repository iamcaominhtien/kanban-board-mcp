import { useEffect, useState } from 'react';
import camelcaseKeys from 'camelcase-keys';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { subscribeSSE } from '../hooks/sseEvents';
import { client } from './client';
import type { ResourceSnapshot } from '../types/aiResources';

/** A pushed reading older than this is stale: the runner has no CLI to read, or is not reachable. */
const PUSH_FRESH_MS = 7000;
const POLL_MS = 4000;
/** With no live run there is little to see move: the machine tiles are read now and then, the push does the rest. */
const IDLE_POLL_MS = 15000;

/**
 * The Resources numbers. The monitor lives in the runner process, which pushes a snapshot over the event stream
 * (`ai.resources`, every 2 s while a CLI runs, with the 5-minute history). The API answers a request with the machine
 * and the numbers the runner last saved, which is what shows when nothing is pushed (no CLI, or the runner is down).
 * `live` is true while the server answers or a reading is fresh.
 */
export function useResourcesStream(projectId: string): {
  data: ResourceSnapshot | null;
  live: boolean;
  /** The readings arrive every 2 s (otherwise they are the last saved ones). */
  pushed: boolean;
} {
  const polled = useQuery({
    queryKey: ['ai', 'resources', projectId] as const,
    queryFn: async () => (await client.get<ResourceSnapshot>(`/projects/${projectId}/ai/resources`)).data,
    enabled: !!projectId,
    refetchInterval: (q) => (q.state.data?.runs.some((r) => r.live) ? POLL_MS : IDLE_POLL_MS),
    staleTime: 1000,
  });
  const [pushed, setPushed] = useState<{ snap: ResourceSnapshot; at: number } | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    setPushed(null);
    if (!projectId) return;
    const stop = subscribeSSE((data) => {
      if (!data.startsWith('{') || !data.includes('"ai.resources"')) return;
      try {
        const snap = camelcaseKeys(JSON.parse(data) as Record<string, unknown>, {
          deep: true,
        }) as unknown as ResourceSnapshot & { type: string };
        if (snap.type === 'ai.resources' && snap.projectId === projectId) setPushed({ snap, at: Date.now() });
      } catch {
        /* a broken frame: wait for the next one */
      }
    });
    // a pushed reading goes stale without another event: look at the clock now and then
    const timer = setInterval(() => tick((n) => n + 1), 2000);
    return () => {
      stop();
      clearInterval(timer);
    };
  }, [projectId]);
  const fresh = pushed != null && pushed.snap.projectId === projectId && Date.now() - pushed.at < PUSH_FRESH_MS;
  const base = polled.data ?? null;
  let data: ResourceSnapshot | null = base;
  if (pushed && fresh) {
    // What a run is (running, stopped, ended) is the server's word and changes the moment a person presses Stop; the
    // runner's push adds the live readings and the 5-minute history of the runs the server calls live.
    data = base
      ? {
          ...base,
          runs: base.runs.map((r) => {
            if (!r.live) return r;
            const p = pushed.snap.runs.find((x) => x.runId === r.runId && x.live);
            // a run the server calls live that the runner does not read yet has a CLI that is starting again (after a
            // restart): its saved value is the old CLI's, so show none until the first reading
            if (!p) return { ...r, cliRssMb: null, extraMb: null, cpuPct: null };
            return {
              ...r,
              readable: p.readable,
              cliRssMb: p.cliRssMb,
              extraMb: p.extraMb,
              cpuPct: p.cpuPct,
              peakRssMb: p.peakRssMb ?? r.peakRssMb,
              history: p.history,
            };
          }),
          machine:
            pushed.snap.machine.cliCount === base.runs.filter((r) => r.live).length
              ? pushed.snap.machine
              : base.machine,
        }
      : pushed.snap;
  }
  return { data, live: fresh || (polled.isSuccess && !polled.isError), pushed: fresh };
}

/** Start a running run's CLI again inside the same run (it resumes; memory is released). */
export function useRestartRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (runId: string) => (await client.post<{ restarting: boolean }>(`/ai/runs/${runId}/restart`)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ai'] }),
  });
}
