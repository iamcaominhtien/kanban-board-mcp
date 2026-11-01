import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from '../../api/client';

/** Query key of the caller's follow state for a project's Docs space (starts with `notifications`, so the server refreshes it). */
export const docsFollowKey = (projectId: string) => ['notifications', 'follow', 'space', projectId] as const;

/**
 * Whether the person follows a project's Docs space, read from and written to the server
 * (`GET /notifications/follow`, `PUT /projects/{id}/docs/follow`).
 * @param projectId - Project whose Docs space is followed.
 * @returns `[following, setFollowing]`.
 */
export function useDocsFollow(projectId: string): [boolean, (on: boolean) => void] {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: docsFollowKey(projectId),
    enabled: !!projectId,
    queryFn: async () => {
      const res = await client.get<{ level: string | null }>('/notifications/follow', {
        params: { scope: 'space', scope_id: projectId },
      });
      return res.data.level;
    },
  });
  const m = useMutation({
    mutationFn: (on: boolean) => client.put(`/projects/${projectId}/docs/follow`, { on }),
    onMutate: async (on) => {
      await qc.cancelQueries({ queryKey: docsFollowKey(projectId) });
      qc.setQueryData(docsFollowKey(projectId), on ? 'follow' : null);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: docsFollowKey(projectId) }),
  });
  const on = !!q.data && q.data !== 'mute';
  const set = useCallback((v: boolean) => m.mutate(v), [m]);
  return [on, set];
}
