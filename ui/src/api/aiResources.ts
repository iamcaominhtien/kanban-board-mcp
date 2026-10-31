import { useEffect, useState } from 'react';
import camelcaseKeys from 'camelcase-keys';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client';
import { resolveOrigin } from './resolveOrigin';
import type { ResourceSnapshot } from '../types/aiResources';

/** The Resources tab's numbers, every 2 s while the page is open (Server-Sent Events). */
export function useResourcesStream(projectId: string): { data: ResourceSnapshot | null; live: boolean } {
  const [data, setData] = useState<ResourceSnapshot | null>(null);
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (!projectId || typeof EventSource === 'undefined') return;
    setData(null);
    const es = new EventSource(`${resolveOrigin()}/projects/${projectId}/ai/resources/stream`);
    es.onmessage = (e) => {
      try {
        setData(camelcaseKeys(JSON.parse(e.data as string) as Record<string, unknown>, { deep: true }) as never);
        setLive(true);
      } catch {
        /* a broken frame: wait for the next one */
      }
    };
    es.onerror = () => setLive(false);
    return () => es.close();
  }, [projectId]);
  return { data, live };
}

/** Start a running run's CLI again inside the same run (it resumes; memory is released). */
export function useRestartRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (runId: string) => (await client.post<{ restarting: boolean }>(`/ai/runs/${runId}/restart`)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ai'] }),
  });
}

/** One reading of the machine and the runs, for the settings estimate (no live updates). */
export function useResourcesSnapshot(projectId: string) {
  return useQuery({
    queryKey: ['ai', 'resources', projectId] as const,
    queryFn: async () => (await client.get<ResourceSnapshot>(`/projects/${projectId}/ai/resources`)).data,
    enabled: !!projectId,
    staleTime: 10000,
  });
}
