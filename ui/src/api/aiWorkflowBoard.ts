import { useQuery } from '@tanstack/react-query';
import { client } from './client';
import { LIVE_POLL_MS, SAFETY_POLL_MS } from './pollIntervals';
import type { WorkflowBoardRow, WorkflowMetric, WorkflowName } from '../types/aiWorkflowBoard';

export const workflowBoardKeys = {
  board: (projectId: string) => ['ai', 'workflow-board', projectId] as const,
  metrics: (projectId: string, days: number) => ['ai', 'workflow-metrics', projectId, days] as const,
  names: (projectId: string) => ['ai', 'workflow-names', projectId] as const,
};

/** One row per ticket on a workflow. Polled gently; the server's announcements refetch it sooner. */
export function useWorkflowBoard(projectId: string) {
  return useQuery({
    queryKey: workflowBoardKeys.board(projectId),
    queryFn: async () => (await client.get<WorkflowBoardRow[]>(`/projects/${projectId}/ai/workflow-board`)).data,
    enabled: !!projectId,
    retry: false,
    refetchInterval: (q) => (q.state.data?.some((r) => r.state === 'running') ? LIVE_POLL_MS : SAFETY_POLL_MS),
  });
}

/** The measures per template over the last `days` days. */
export function useWorkflowMetrics(projectId: string, days = 30) {
  return useQuery({
    queryKey: workflowBoardKeys.metrics(projectId, days),
    queryFn: async () =>
      (await client.get<WorkflowMetric[]>(`/projects/${projectId}/ai/workflow-metrics`, { params: { days } })).data,
    enabled: !!projectId,
    refetchInterval: SAFETY_POLL_MS,
  });
}

/** Template names, for labels. */
export function useWorkflowNames(projectId: string) {
  return useQuery({
    queryKey: workflowBoardKeys.names(projectId),
    queryFn: async () => (await client.get<WorkflowName[]>(`/projects/${projectId}/ai/workflows`)).data,
    enabled: !!projectId,
  });
}
