import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Pull } from '../types/aiPulls';
import { client } from './client';

export const pullKeys = { list: (projectId: string) => ['ai', 'pulls', projectId] as const };

export const pullApi = {
  list: async (projectId: string) => (await client.get<Pull[]>(`/projects/${projectId}/ai/pulls`)).data,
  poll: async (projectId: string) =>
    (await client.post<{ changes: number }>(`/projects/${projectId}/ai/pulls/poll`)).data,
};

/** The watched pull requests of a project; polled gently while one is open. */
export function usePulls(projectId: string | undefined) {
  return useQuery({
    queryKey: pullKeys.list(projectId ?? ''),
    queryFn: () => pullApi.list(projectId as string),
    enabled: !!projectId,
    refetchInterval: (q) => (q.state.data?.some((p) => p.state === 'open') ? 60_000 : false),
  });
}

/** Check now, or hand something back to the Dev: both refresh the pulls and the runs. */
export function usePullMutation<TVars, TOut>(projectId: string | undefined, fn: (v: TVars) => Promise<TOut>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ai', 'pulls'] });
      void qc.invalidateQueries({ queryKey: ['ai', 'ticket-runs'] });
      void qc.invalidateQueries({ queryKey: ['ai', 'board', projectId ?? ''] });
    },
  });
}
