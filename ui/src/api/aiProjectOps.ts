import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client';

/**
 * What a project says about how its AI team runs (GET /projects/{id}/ai/ops: the project's settings over the
 * defaults). Known keys only; the server keeps nothing else. Cards for other settings reuse this module.
 */
export interface ProjectOps {
  hangAfterMin: number;
  diagnoseWithModel: boolean;
  proposeLessons: boolean;
  lessonsInPrompt: number;
  worktrees?: Record<string, unknown>;
  commands?: { test?: string; lint?: string; build?: string };
  workflowDefault?: string | null;
  coordinatorId?: string | null;
  triageId?: string | null;
  knowledgeShared?: boolean;
  github?: { on?: boolean; pollMin?: number };
  [key: string]: unknown;
}

export const opsKeys = { project: (projectId: string) => ['ai', 'ops', projectId] as const };

export const opsApi = {
  get: async (projectId: string) => (await client.get<ProjectOps>(`/projects/${projectId}/ai/ops`)).data,
  /** A partial object: nested objects merge. */
  patch: async (projectId: string, body: Partial<ProjectOps>) =>
    (await client.patch<ProjectOps>(`/projects/${projectId}/ai/ops`, body)).data,
};

/** The project's AI operations settings over the defaults. */
export function useProjectOps(projectId: string) {
  return useQuery({
    queryKey: opsKeys.project(projectId),
    queryFn: () => opsApi.get(projectId),
    enabled: !!projectId,
  });
}

/** Save a partial change; the cache takes the server's answer. */
export function usePatchProjectOps(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<ProjectOps>) => opsApi.patch(projectId, body),
    onSuccess: (data) => qc.setQueryData(opsKeys.project(projectId), data),
  });
}
