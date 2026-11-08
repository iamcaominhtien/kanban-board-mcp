import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AiBody, Scan, TryBody } from '../types/aiPacks';
import { client } from './client';

export const scanKeys = {
  latest: (projectId: string) => ['ai', 'scan', 'latest', projectId] as const,
  one: (scanId: string) => ['ai', 'scan', scanId] as const,
};

/**
 * The repository scan of a project (server/api/ai_tools.py). A scan reads the repository by code; the AI job and the
 * board's own run of the commands are jobs on it that the server keeps going when the page is closed.
 */
export const aiScanApi = {
  /** Read the repository by code: runs nothing, and says whether the AI can start (`aiAvailable`). */
  create: async (projectId: string, folder: string) =>
    (await client.post<Scan>(`/projects/${projectId}/ai/scan`, { folder, trial: false, refine: false })).data,
  /** The newest scan of the last day that was not applied, or null. */
  latest: async (projectId: string) =>
    (await client.get<Scan | null>(`/projects/${projectId}/ai/scans/latest`)).data ?? null,
  get: async (scanId: string) => (await client.get<Scan>(`/ai/scans/${scanId}`)).data,
  /** Start the AI: it reads the repository and proposes, then the board runs each command. */
  startAi: async (scanId: string, body: AiBody) => (await client.post<Scan>(`/ai/scans/${scanId}/ai`, body)).data,
  /** The board runs the commands as they are, the way a ticket does. */
  startTry: async (scanId: string, body: TryBody) => (await client.post<Scan>(`/ai/scans/${scanId}/try`, body)).data,
  /** Stop the job; what it already proved stays. */
  cancel: async (scanId: string) => (await client.post<Scan>(`/ai/scans/${scanId}/cancel`)).data,
};

/** The scan the card works on, kept fresh once a second while a job runs. */
export function useLatestScan(projectId: string) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: scanKeys.latest(projectId),
    queryFn: () => aiScanApi.latest(projectId),
    enabled: !!projectId,
    refetchInterval: (q) => {
      const job = q.state.data?.job as { state?: string } | undefined;
      return job?.state === 'running' ? 1000 : false;
    },
  });
  const put = useCallback((scan: Scan) => qc.setQueryData(scanKeys.latest(projectId), scan), [qc, projectId]);
  return { query, put };
}
