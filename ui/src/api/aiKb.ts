import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { KbDetail, KbDocument, KbHit, KbList, KbStore, KbUpload } from '../types/aiKb';
import { client } from './client';

export const kbKeys = {
  list: (projectId: string) => ['ai', 'kb', projectId] as const,
  search: (projectId: string, q: string) => ['ai', 'kb-search', projectId, q] as const,
  doc: (id: string) => ['ai', 'kb-doc', id] as const,
};

export const kbApi = {
  list: async (projectId: string) => (await client.get<KbList>(`/projects/${projectId}/ai/kb`)).data,
  search: async (projectId: string, q: string) =>
    (await client.get<KbHit[]>(`/projects/${projectId}/ai/kb/search`, { params: { q } })).data,
  get: async (id: string) => (await client.get<KbDetail>(`/ai/kb/${id}`)).data,
  upload: async (projectId: string, u: KbUpload) => {
    const f = new FormData();
    if (u.file) f.append('file', u.file, u.file.name);
    else f.append('text', u.text ?? '');
    f.append('title', u.title);
    f.append('store', u.store);
    f.append('private', u.private ? 'true' : 'false');
    return (await client.post<KbDocument>(`/projects/${projectId}/ai/kb`, f)).data;
  },
  patch: async (id: string, body: { store?: KbStore; private?: boolean }) =>
    (await client.patch<KbDetail>(`/ai/kb/${id}`, body)).data,
  remove: async (id: string) => {
    await client.delete(`/ai/kb/${id}`);
  },
};

/** Part of the knowledge base (wave 3). */
export function useKbList(projectId: string) {
  return useQuery({ queryKey: kbKeys.list(projectId), queryFn: () => kbApi.list(projectId), enabled: !!projectId });
}

/** Keyword search as the AIs run it; runs only for a non-empty query. */
export function useKbSearch(projectId: string, q: string) {
  return useQuery({
    queryKey: kbKeys.search(projectId, q),
    queryFn: () => kbApi.search(projectId, q),
    enabled: !!projectId && q.trim().length > 0,
  });
}

/** Part of the knowledge base (wave 3). */
export function useKbDoc(id: string | null) {
  return useQuery({ queryKey: kbKeys.doc(id ?? ''), queryFn: () => kbApi.get(id as string), enabled: !!id });
}

/** A change to the knowledge base refreshes the list, the searches and the open document. */
export function useKbMutation<TVars, TOut>(projectId: string, fn: (v: TVars) => Promise<TOut>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ai', 'kb', projectId] });
      void qc.invalidateQueries({ queryKey: ['ai', 'kb-search', projectId] });
      void qc.invalidateQueries({ queryKey: ['ai', 'kb-doc'] });
    },
  });
}
