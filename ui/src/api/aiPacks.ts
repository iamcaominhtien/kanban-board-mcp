import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client';
import { aiKeys } from './ai';
import type {
  AiBody,
  ApplyBody,
  ApplyResult,
  CatalogueEntry,
  MakeMemberBody,
  MemberPack,
  MemberPackDiff,
  Pack,
  PackDraft,
  PackExport,
  PackImportResult,
  Scan,
  TryBody,
} from '../types/aiPacks';
import type { AiMember } from '../types/ai';

export const packKeys = {
  all: (projectId: string) => ['ai', 'packs', projectId] as const,
  catalogue: ['ai', 'catalogue'] as const,
  member: (memberId: string) => ['ai', 'member-pack', memberId] as const,
  diff: (memberId: string) => ['ai', 'member-pack-diff', memberId] as const,
  latestScan: (projectId: string) => ['ai', 'scan-latest', projectId] as const,
  scan: (scanId: string) => ['ai', 'scan', scanId] as const,
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
  /** Reads files only (no AI, no command is run); the commands come in step 3. */
  scan: async (projectId: string, folder: string) =>
    (await client.post<Scan>(`/projects/${projectId}/ai/scan`, { folder, trial: false })).data,
  /** The project's latest scan that was not applied, from the last 24 hours (null: none). */
  latestScan: async (projectId: string) =>
    (await client.get<Scan | null>(`/projects/${projectId}/ai/scans/latest`)).data ?? null,
  getScan: async (scanId: string) => (await client.get<Scan>(`/ai/scans/${scanId}`)).data,
  startAi: async (scanId: string, body: AiBody) => (await client.post<Scan>(`/ai/scans/${scanId}/ai`, body)).data,
  tryCommands: async (scanId: string, body: TryBody) => (await client.post<Scan>(`/ai/scans/${scanId}/try`, body)).data,
  cancelScan: async (scanId: string) => (await client.post<Scan>(`/ai/scans/${scanId}/cancel`)).data,
  apply: async (scanId: string, body: ApplyBody) =>
    (await client.post<ApplyResult>(`/ai/scans/${scanId}/apply`, body)).data,
  memberPack: async (memberId: string) => (await client.get<MemberPack | null>(`/ai/members/${memberId}/pack`)).data,
  memberDiff: async (memberId: string) => (await client.get<MemberPackDiff>(`/ai/members/${memberId}/pack/diff`)).data,
  updateMember: async (memberId: string) => (await client.post<MemberPack>(`/ai/members/${memberId}/pack/update`)).data,
  revertMember: async (memberId: string) => (await client.post<MemberPack>(`/ai/members/${memberId}/pack/revert`)).data,
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

/** Read a folder (files only; creates nothing). */
export function useScan(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ folder }: { folder: string }) => packsApi.scan(projectId, folder),
    onSuccess: (scan) => qc.setQueryData(packKeys.scan(scan.id), scan),
  });
}

/** The project's latest scan that was not applied, so the wizard can offer to continue it. */
export function useLatestScan(projectId: string) {
  return useQuery({
    queryKey: packKeys.latestScan(projectId),
    queryFn: () => packsApi.latestScan(projectId),
    enabled: !!projectId,
    retry: false,
    staleTime: 0,
  });
}

/** A scan, re-read every second while its job runs. The mutations below write their answer into this cache. */
export function useScanPoll(scanId: string | null) {
  return useQuery({
    queryKey: packKeys.scan(scanId ?? ''),
    queryFn: () => packsApi.getScan(scanId as string),
    enabled: !!scanId,
    staleTime: 30_000,
    refetchInterval: (q) => ((q.state.data?.job as { state?: string } | undefined)?.state === 'running' ? 1000 : false),
  });
}

/** Start the AI on a scan, start a "try" run of the commands, or cancel the job: each answers with the scan. */
export function useScanJob() {
  const qc = useQueryClient();
  const keep = (scan: Scan) => qc.setQueryData(packKeys.scan(scan.id), scan);
  return {
    startAi: useMutation({
      mutationFn: ({ scanId, body }: { scanId: string; body: AiBody }) => packsApi.startAi(scanId, body),
      onSuccess: keep,
    }),
    tryCommands: useMutation({
      mutationFn: ({ scanId, body }: { scanId: string; body: TryBody }) => packsApi.tryCommands(scanId, body),
      onSuccess: keep,
    }),
    cancel: useMutation({ mutationFn: (scanId: string) => packsApi.cancelScan(scanId), onSuccess: keep }),
  };
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

/** The pack a member was made from and whether a newer version is out (null: not made from a pack). */
export function useMemberPack(memberId: string) {
  return useQuery({
    queryKey: packKeys.member(memberId),
    queryFn: () => packsApi.memberPack(memberId),
    enabled: !!memberId,
  });
}

/** What updating the member to its pack's newest version would change. */
export function useMemberPackDiff(memberId: string, enabled = true) {
  return useQuery({
    queryKey: packKeys.diff(memberId),
    queryFn: () => packsApi.memberDiff(memberId),
    enabled: !!memberId && enabled,
    retry: false,
  });
}

/** Update the member to its pack's newest version, or (`revert`) go back to the version it had. */
export function useMemberPackChange(memberId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: 'update' | 'revert') =>
      action === 'update' ? packsApi.updateMember(memberId) : packsApi.revertMember(memberId),
    onSuccess: (data) => {
      qc.setQueryData(packKeys.member(memberId), data);
      // the member's instructions, tools and permissions changed: everything that shows it reloads
      void qc.invalidateQueries({ queryKey: aiKeys.all, predicate: (q) => q.queryKey[1] !== 'member-pack' });
    },
  });
}
