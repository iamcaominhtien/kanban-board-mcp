import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client';
import { aiKeys } from './ai';
import { LIVE_POLL_MS, SAFETY_POLL_MS } from './pollIntervals';
import type { WindowPatch, WindowsOverview } from '../types/aiWindows';
import type { AiRun } from '../types/ai';

export const windowKeys = { all: ['ai', 'windows'] as const };

/** The usage window of every Claude account. Polled while the page is open; faster while something runs. */
export function useAiWindows() {
  return useQuery({
    queryKey: windowKeys.all,
    queryFn: async () => (await client.get<WindowsOverview>('/ai/windows')).data,
    refetchInterval: (q) => (q.state.data?.accounts.some((a) => a.running.length) ? LIVE_POLL_MS : SAFETY_POLL_MS),
  });
}

export const windowsApi = {
  patch: async (key: string, body: WindowPatch) =>
    (await client.patch<{ key: string; maxParallel: number; moveUrgent: boolean }>(`/ai/windows/${key}`, body)).data,
  /** Move a queued run to another account. Only the account changes, and only for this run. */
  moveRun: async (runId: string, accountId: string) =>
    (await client.post<AiRun>(`/ai/runs/${runId}/move-account`, { accountId })).data,
};

/** Change an account's limit or its move-urgent switch; refreshes the windows after. */
export function usePatchWindow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, body }: { key: string; body: WindowPatch }) => windowsApi.patch(key, body),
    onSettled: () => void qc.invalidateQueries({ queryKey: windowKeys.all }),
  });
}

/** Move one queued run to an account with room; refreshes the windows and the runs. */
export function useMoveRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ runId, accountId }: { runId: string; accountId: string }) => windowsApi.moveRun(runId, accountId),
    onSettled: () =>
      Promise.all([qc.invalidateQueries({ queryKey: windowKeys.all }), qc.invalidateQueries({ queryKey: aiKeys.all })]),
  });
}
