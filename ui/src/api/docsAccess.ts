import { useMutation, useQuery } from '@tanstack/react-query';
import { client } from './client';
import type { DocsEditPolicy } from '../types/ticket';

/** What the current actor may do in a project's Docs space. */
export interface DocsAccess {
  /** False for someone who is not part of the project: they see "You don't have access to Docs". */
  access: boolean;
  role: 'viewer' | 'member' | 'admin' | null;
  canEdit: boolean;
  policy: DocsEditPolicy;
  me: string;
  /** Project admins by name; an access request notifies them. */
  admins: string[];
}

/** Query key for a project's Docs access. */
export const docsAccessKey = (projectId: string) => ['docs', 'access', projectId] as const;

/** Query the caller's Docs access for a project. */
export function useDocsAccess(projectId: string, enabled = true) {
  return useQuery({
    queryKey: docsAccessKey(projectId),
    queryFn: async () => (await client.get<DocsAccess>(`/projects/${projectId}/docs/access`)).data,
    enabled: !!projectId && enabled,
    retry: false,
  });
}

/** Mutation: ask the project's admins for access to Docs. */
export function useRequestDocsAccess(projectId: string) {
  return useMutation({
    mutationFn: async (note: string) =>
      (
        await client.post<{ sent: boolean; admins: string[] }>(`/projects/${projectId}/docs/access-requests`, {
          note,
        })
      ).data,
  });
}
