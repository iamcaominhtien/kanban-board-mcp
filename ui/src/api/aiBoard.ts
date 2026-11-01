import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client';
import { LIVE_POLL_MS } from './pollIntervals';
import type { AiSignal, BoardAiPatch, BoardAiView } from '../types/aiBoard';

export const boardAiKeys = {
  view: (projectId: string) => ['ai', 'board-ai', projectId] as const,
  signals: (projectId: string) => ['ai', 'signals', projectId] as const,
};

export const aiBoardApi = {
  get: async (projectId: string) => (await client.get<BoardAiView>(`/projects/${projectId}/ai/board-ai`)).data,
  patch: async (projectId: string, body: BoardAiPatch) =>
    (await client.patch<BoardAiView>(`/projects/${projectId}/ai/board-ai`, body)).data,
  signals: async (projectId: string) => (await client.get<AiSignal[]>(`/projects/${projectId}/ai/signals`)).data,
};

/** The Board AI's mode and tier table for a project. */
export function useBoardAi(projectId: string) {
  return useQuery({
    queryKey: boardAiKeys.view(projectId),
    queryFn: () => aiBoardApi.get(projectId),
    enabled: !!projectId,
  });
}

/** Turn "Acts as you" on or off, or lower a middle-tier action. */
export function useUpdateBoardAi(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: BoardAiPatch) => aiBoardApi.patch(projectId, body),
    onSuccess: (data) => qc.setQueryData(boardAiKeys.view(projectId), data),
  });
}

/** The AI signals, asked again while Board health is open. */
export function useSignals(projectId: string) {
  return useQuery({
    queryKey: boardAiKeys.signals(projectId),
    queryFn: () => aiBoardApi.signals(projectId),
    enabled: !!projectId,
    refetchInterval: LIVE_POLL_MS,
  });
}
