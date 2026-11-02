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
  /** Commands saved but not run as checks: names out of test, lint, build. */
  checksOff?: string[];
  /** Extra folders put in front of the PATH for everything this project runs. */
  envPath?: string[];
  /** A workflow template key, or "" for none. */
  workflowDefault?: string | null;
  /** The PM member that arbitrates and runs the team; null: the first PM. */
  coordinatorId?: string | null;
  /** The Triage that takes new tickets; null: any member with the Triage role. */
  triageId?: string | null;
  /** New tickets in `status`, assigned to nobody, are taken by the team (`since`: when it was turned on). */
  intake?: { on?: boolean; status?: string; since?: string | null };
  /** How far the team goes without a person: Done is a person's move, or the board's once everything passed; the
   * step that waits for a person before the last one (the design) is approved by a person or by the PM. */
  autonomy?: { done?: 'person' | 'after_review'; approve?: 'person' | 'pm' };
  /** The coordinator runs the team: what it may decide before a person is asked. */
  manager?: { on?: boolean; graceMin?: number; maxRisk?: 'low' | 'medium' | 'high'; perHourLimit?: number };
  /** A Dev step hands in a failing test run and a passing one. */
  tdd?: { required?: boolean };
  /** Tokens one ticket's workflow may use before it stops for a person; 0: no cap. */
  ticketTokenCap?: number;
  /** A message reaches a running AI at its next turn (off: at its next board call). */
  liveMessages?: boolean;
  knowledgeShared?: boolean;
  /** Claude Code runs load the person's own Claude Code plugins (ai-story-flow Q2). */
  ownClaude?: boolean;
  /** Which roles load each of those plugins; a plugin not listed loads for every role. */
  ownClaudeRoles?: { plugin: string; roles: string[] }[];
  github?: { on?: boolean; pollMin?: number; auto?: boolean };
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
