import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client';
import { LIVE_POLL_MS } from './pollIntervals';

export const powerKeys = {
  active: ['ai', 'power'] as const,
  keepAwake: ['desktop', 'keep-awake'] as const,
};

/** The desktop app's Keep awake switch, or null in the web build (a browser tab cannot hold the computer awake). */
export function keepAwakeApi() {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  return api?.getKeepAwake && api.setKeepAwake ? { get: api.getKeepAwake, set: api.setKeepAwake } : null;
}

/** How many AI runs are queued, starting or running (GET /ai/power); polled in the desktop app only. */
export function usePowerActive(enabled: boolean) {
  return useQuery({
    queryKey: powerKeys.active,
    queryFn: async () => (await client.get<{ active: number }>('/ai/power')).data,
    enabled,
    refetchInterval: LIVE_POLL_MS,
    retry: false,
  });
}

/** Whether Keep awake while AI runs is on (read again on every poll: the View menu can change it). */
export function useKeepAwake() {
  const api = keepAwakeApi();
  return useQuery({
    queryKey: powerKeys.keepAwake,
    queryFn: async () => Boolean(await api!.get()),
    enabled: !!api,
    refetchInterval: LIVE_POLL_MS,
  });
}

/** Switch Keep awake while AI runs, as the View menu does. */
export function useSetKeepAwake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (on: boolean) => {
      const api = keepAwakeApi();
      if (!api) throw new Error('Only the desktop app can keep this computer awake.');
      return Boolean(await api.set(on));
    },
    onSuccess: (on) => qc.setQueryData(powerKeys.keepAwake, on),
  });
}
