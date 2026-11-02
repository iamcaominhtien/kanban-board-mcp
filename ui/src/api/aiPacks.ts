import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client';
import { aiKeys } from './ai';
import type {
  ApplyBody,
  ApplyResult,
  CatalogueEntry,
  MakeMemberBody,
  Pack,
  PackDraft,
  PackExport,
  PackImportResult,
  Scan,
} from '../types/aiPacks';
import type { AiMember } from '../types/ai';

export const packKeys = {
  all: (projectId: string) => ['ai', 'packs', projectId] as const,
  catalogue: ['ai', 'catalogue'] as const,
};

export const packsApi = {
  list: async (projectId: string) => (await client.get<Pack[]>(`/projects/${projectId}/ai/packs`)).data,
  save: async (projectId: string, key: string, body: PackDraft) =>
    (await client.put<Pack>(`/projects/${projectId}/ai/packs/${key}`, body)).data,
  remove: async (projectId: string, key: string) => {
    await client.delete(`/projects/${projectId}/ai/packs/${key}`);
  },
  export: async (projectId: string, key: string) =>
    (await client.get<PackExport>(`/projects/${projectId}/ai/packs/${key}/export`)).data,
  import: async (projectId: string, body: PackExport) =>
    (await client.post<PackImportResult>(`/projects/${projectId}/ai/packs/import`, body)).data,
  makeMember: async (projectId: string, key: string, body: MakeMemberBody) =>
    (await client.post<AiMember>(`/projects/${projectId}/ai/packs/${key}/member`, body)).data,
  scan: async (projectId: string, folder: string) =>
    (await client.post<Scan>(`/projects/${projectId}/ai/scan`, { folder, trial: true })).data,
  apply: async (scanId: string, body: ApplyBody) =>
    (await client.post<ApplyResult>(`/ai/scans/${scanId}/apply`, body)).data,
};

/** The ready-made packs first, then the project's own. */
export function usePacks(projectId: string) {
  return useQuery({ queryKey: packKeys.all(projectId), queryFn: () => packsApi.list(projectId) });
}

/** The plugin catalogue, for names. */
export function useCatalogue() {
  return useQuery({
    queryKey: packKeys.catalogue,
    queryFn: async () => (await client.get<CatalogueEntry[]>('/ai/catalogue')).data,
    staleTime: 5 * 60_000,
  });
}

/** Save a pack: a new version, or the project's copy of a ready-made one. */
export function useSavePack(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, body }: { key: string; body: PackDraft }) => packsApi.save(projectId, key, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: packKeys.all(projectId) }),
  });
}

/** Delete the project's own pack; the ready-made one comes back. */
export function useDeletePack(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => packsApi.remove(projectId, key),
    onSuccess: () => void qc.invalidateQueries({ queryKey: packKeys.all(projectId) }),
  });
}

/** Import an exported pack. */
export function useImportPack(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PackExport) => packsApi.import(projectId, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: packKeys.all(projectId) }),
  });
}

/** Make an AI member from a pack. */
export function useMakeMember(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, body }: { key: string; body: MakeMemberBody }) => packsApi.makeMember(projectId, key, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: aiKeys.all }),
  });
}

/** Scan a folder and try its commands (creates nothing). */
export function useScan(projectId: string) {
  return useMutation({ mutationFn: (folder: string) => packsApi.scan(projectId, folder) });
}

/** Create the team from an edited scan suggestion. */
export function useApplyScan(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ scanId, body }: { scanId: string; body: ApplyBody }) => packsApi.apply(scanId, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: aiKeys.all });
      void qc.invalidateQueries({ queryKey: packKeys.all(projectId) });
    },
  });
}
