import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CleanupResult,
  HandoverRoute,
  MergeResult,
  Worktree,
  WorktreeList,
  WorktreeWithRoute,
} from '../types/aiCode';
import { client } from './client';

export const codeKeys = {
  list: (projectId: string) => ['ai', 'worktrees', projectId] as const,
  ticket: (ticketId: string) => ['ai', 'worktree', ticketId] as const,
};

export const codeApi = {
  list: async (projectId: string) => (await client.get<WorktreeList>(`/projects/${projectId}/ai/worktrees`)).data,
  ticket: async (ticketId: string) =>
    (await client.get<Worktree | null>(`/tickets/${ticketId}/ai/worktree`)).data ?? null,
  remove: async (ticketId: string) =>
    (await client.post<Worktree>(`/tickets/${ticketId}/ai/worktree/remove`, { force: false })).data,
  keep: async (ticketId: string) => (await client.post<Worktree>(`/tickets/${ticketId}/ai/worktree/keep`)).data,
  /** Discard what is not committed and remove the worktree (a person's choice, confirmed first). */
  discard: async (ticketId: string) =>
    (await client.post<Worktree>(`/tickets/${ticketId}/ai/worktree/remove`, { force: true })).data,
  /** Move the outputs left in the worktree (screenshots, logs, reports) to the ticket's Workspace. */
  moveOutputs: async (ticketId: string) =>
    (
      await client.post<{ moved: string[]; to?: string; left?: string[]; reason?: string }>(
        `/tickets/${ticketId}/ai/worktree/outputs`,
      )
    ).data,
  /** Commit the code left in the worktree on its branch (outputs never go in the commit). */
  commit: async (ticketId: string) =>
    (await client.post<{ committed: boolean; left: string[] }>(`/tickets/${ticketId}/ai/worktree/commit`)).data,
  cleanup: async (projectId: string) =>
    (await client.post<CleanupResult>(`/projects/${projectId}/ai/worktrees/cleanup`)).data,
  open: async (ticketId: string) =>
    (await client.post<{ opened: string }>(`/tickets/${ticketId}/ai/worktree/open`)).data,
  merge: async (ticketId: string) => (await client.post<MergeResult>(`/tickets/${ticketId}/ai/merge`)).data,
  handover: async (ticketId: string, route: HandoverRoute) =>
    (await client.patch<WorktreeWithRoute>(`/tickets/${ticketId}/ai/handover`, { route })).data,
};

/** Every worktree of a project, with the total size on disk. */
export function useWorktrees(projectId: string) {
  return useQuery({ queryKey: codeKeys.list(projectId), queryFn: () => codeApi.list(projectId), enabled: !!projectId });
}

/** One ticket's worktree, or null when it has none. */
export function useTicketWorktree(ticketId: string, enabled = true) {
  return useQuery({
    queryKey: codeKeys.ticket(ticketId),
    queryFn: () => codeApi.ticket(ticketId),
    enabled: !!ticketId && enabled,
  });
}

/** Run one worktree action and refresh everything that shows worktrees. */
export function useCodeMutation<T, V>(fn: (v: V) => Promise<T>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ai', 'worktrees'] });
      void qc.invalidateQueries({ queryKey: ['ai', 'worktree'] });
    },
  });
}
