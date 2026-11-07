import { useEffect, useState } from 'react';
import camelcaseKeys from 'camelcase-keys';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { subscribeSSE } from '../hooks/sseEvents';
import { client } from './client';
import type { ResourceSnapshot } from '../types/aiResources';

/** A pushed reading older than this is stale: the runner has no CLI to read, or is not reachable. */
const PUSH_FRESH_MS = 7000;
const POLL_MS = 4000;

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
    refetchInterval: POLL_MS,
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
  const fresh = pushed != null && Date.now() - pushed.at < PUSH_FRESH_MS;
  const data = fresh ? pushed.snap : (polled.data ?? null);
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
