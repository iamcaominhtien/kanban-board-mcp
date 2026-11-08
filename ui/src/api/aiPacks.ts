import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PackBody, PackExport, PackImportResult, RolePack } from '../types/aiPacks';
import { client } from './client';

export const packKeys = {
  list: (projectId: string) => ['ai', 'role-packs', projectId] as const,
};

const base = (projectId: string) => `/projects/${projectId}/ai/packs`;

export const aiPacksApi = {
  list: async (projectId: string) => (await client.get<RolePack[]>(base(projectId))).data,
  /** Create or edit the project's pack `key` (a new version each time; a ready-made one makes the project's copy). */
  save: async (projectId: string, key: string, body: PackBody) =>
    (await client.put<RolePack>(`${base(projectId)}/${encodeURIComponent(key)}`, body)).data,
  /** Remove the project's own pack; a ready-made one comes back in its place. */
  remove: async (projectId: string, key: string) => {
    await client.delete(`${base(projectId)}/${encodeURIComponent(key)}`);
  },
  /** The pack as one file, keys as they are in the file (the page never renames them). */
  exportFile: async (projectId: string, key: string) =>
    (await client.get<PackExport>(`${base(projectId)}/${encodeURIComponent(key)}/export`, { keepKeys: true })).data,
  /** Import a pack file; says what it names that this project does not have yet. */
  importFile: async (projectId: string, file: unknown) =>
    (await client.post<PackImportResult>(`${base(projectId)}/import`, file)).data,
};

/** The ready-made packs and the project's own. */
export function usePacks(projectId: string) {
  return useQuery({
    queryKey: packKeys.list(projectId),
    queryFn: () => aiPacksApi.list(projectId),
    enabled: !!projectId,
  });
}

/** Run a change and refresh the list of packs afterwards. */
export function usePackMutation<A, R>(projectId: string, fn: (a: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    // the answer waits for the new list, so the screen finds the pack it just made
    onSuccess: () => qc.invalidateQueries({ queryKey: packKeys.list(projectId) }),
  });
}
